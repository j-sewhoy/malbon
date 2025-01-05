/**
 * @NApiVersion 2.x
 * @NScriptType ScheduledScript
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log'
], function(record, search, runtime, log) {

    /**
     * Entry point for the Scheduled Script
     */
    function execute(context) {
        try {
            // var TEST_ID = 103;  // <-- For testing, set a specific internal ID for the custom record
            // var receiptSearch = search.create({
            //     type: 'customrecord_mg_po_receipt',
            //     filters: [
            //         ['custrecord_poreceipt_processstatus','anyof','@NONE@'],
            //         'AND',
            //         ['internalid','anyof', TEST_ID]
            //     ],
            //     columns: [
            //         search.createColumn({ name: 'internalid' })
            //     ]
            // });
            var receiptSearch = search.create({
                type: 'customrecord_mg_po_receipt',
                filters: [
                    ['custrecord_poreceipt_processstatus','anyof','@NONE@']
                ],
                columns: [
                    search.createColumn({ name: 'internalid' })
                ]
            });

            var searchResults = receiptSearch.run().getRange({ start: 0, end: 1000 });
            if (!searchResults || searchResults.length === 0) {
                log.audit('No Records', 'No unprocessed PO receipts found (or none match your filter).');
                return;
            }

            for (var i = 0; i < searchResults.length; i++) {
                var recId = searchResults[i].getValue({ name: 'internalid' });
                processOnePOReceipt(recId);
            }

        } catch (masterErr) {
            log.error('Script-Level Error', masterErr);
        }
    }

    /**
     * Process a single customrecord_mg_po_receipt record from the 3PL data
     */
    function processOnePOReceipt(receiptId) {
        var custRec;
        try {
            // 1) Load the custom record
            custRec = record.load({
                type: 'customrecord_mg_po_receipt',
                id: receiptId,
                isDynamic: true
            });

            // Mark as "In Progress" (assuming internal ID = '2' for that status)
            custRec.setValue({
                fieldId: 'custrecord_poreceipt_processstatus',
                value: '2'
            });
            custRec.save();

            // Get fields
            var poId         = custRec.getValue({ fieldId: 'custrecord_poreceipt_po' });
            var rawJson      = custRec.getValue({ fieldId: 'custrecord_poreceipt_raw_json' });
            var receiptDate  = custRec.getValue({ fieldId: 'custrecord_poreceipt_date_updated' });

            // 2) Parse JSON safely
            var dataObj;
            try {
                dataObj = JSON.parse(rawJson);
            } catch (parseErr) {
                var parseErrorMsg = 'JSON parse error: ' + parseErr;
                markAsError(receiptId, parseErrorMsg);
                return;
            }

            var items = dataObj.items || [];
            if (!Array.isArray(items) || items.length === 0) {
                // If no items, mark complete or handle as you wish
                record.submitFields({
                    type: 'customrecord_mg_po_receipt',
                    id: receiptId,
                    values: {
                        custrecord_poreceipt_processstatus: '3', // 3 - Complete
                        custrecord_poreceipt_errordetails: 'No items found in JSON. Nothing to process.',
                        custrecord_poreceipt_scripterror: ''
                    }
                });
                log.audit('No Items', 'No items found in the JSON, marked as Complete');
                return;
            }

            // 3) GROUP by SKU and aggregate "good" quantity
            var skuSummary = {}; // { sku: totalGoodQty }
            for (var i = 0; i < items.length; i++) {
                var lineObj = items[i];
                var sku = lineObj.sku;
                var goodQty = parseInt(lineObj.good, 10) || 0;

                if (!sku) {
                    continue;
                }
                if (!skuSummary[sku]) {
                    skuSummary[sku] = 0;
                }
                skuSummary[sku] += goodQty;
            }

            // 4) Find item IDs for each SKU. If missing, mark error
            var allSKUs = Object.keys(skuSummary);
            var skuToItemIdMap = {};
            var notFoundSkus = [];

            for (var s = 0; s < allSKUs.length; s++) {
                var skuKey = allSKUs[s];
                var itemId = findItemBySKU(skuKey);
                if (!itemId) {
                    notFoundSkus.push(skuKey);
                } else {
                    skuToItemIdMap[skuKey] = itemId;
                }
            }
            if (notFoundSkus.length > 0) {
                var errorMsgNF = 'No matching NetSuite item found for these SKUs: ' + notFoundSkus.join(', ');
                markAsError(receiptId, errorMsgNF);
                return;
            }

            // 5) Load PO once, gather totalOrdered, totalReceived, isClosed
            var poRec = record.load({
                type: record.Type.PURCHASE_ORDER,
                id: poId,
                isDynamic: false
            });

            var itemLineData = {};
            var lineCount = poRec.getLineCount({ sublistId: 'item' });
            for (var idx = 0; idx < lineCount; idx++) {
                var currItemId = poRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: idx
                });
                var qtyOrdered = parseFloat(
                    poRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: idx })
                ) || 0;
                var qtyReceived = parseFloat(
                    poRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityreceived', line: idx })
                ) || 0;
                var isClosed = poRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: idx
                });

                if (!itemLineData[currItemId]) {
                    itemLineData[currItemId] = {
                        totalOrdered: 0,
                        totalReceived: 0,
                        anyLineClosed: false
                    };
                }
                itemLineData[currItemId].totalOrdered  += qtyOrdered;
                itemLineData[currItemId].totalReceived += qtyReceived;
                if (isClosed === true) {
                    itemLineData[currItemId].anyLineClosed = true;
                }
            }

            // 6) Check for "reductions" (3PL < NetSuite)
            var reducedSkus = [];
            for (var s2 = 0; s2 < allSKUs.length; s2++) {
                var skuKey2 = allSKUs[s2];
                var totalGoodQty2 = skuSummary[skuKey2];
                var nsItemId2 = skuToItemIdMap[skuKey2];

                var itemLine2 = itemLineData[nsItemId2];
                var nsTotalReceivedSoFar2 = itemLine2 ? itemLine2.totalReceived : 0;

                if (totalGoodQty2 < nsTotalReceivedSoFar2) {
                    reducedSkus.push(skuKey2);
                }
            }
            if (reducedSkus.length > 0) {
                var reduceErrMsg = '3PL Provided reduced quantity for these SKUs: ' + reducedSkus.join(', ');
                markAsError(receiptId, reduceErrMsg);
                return;
            }

            // -------------------------------
            // 7) Build final wantedItemSet
            // -------------------------------
            // We'll store all item IDs in a set. Then do a two-pass approach:
            //    Pass A: Determine how many units we REALLY need
            //    Pass B: Transform & create/updates receipts
            var wantedItemSet = {};
            // "itemsToReceive" is a map of itemId -> how many units to receive
            var itemsToReceive = {};

            for (var s3 = 0; s3 < allSKUs.length; s3++) {
                var skuKey3 = allSKUs[s3];
                var totalGoodQty3 = skuSummary[skuKey3];
                var itemId3 = skuToItemIdMap[skuKey3];

                var lineData3 = itemLineData[itemId3];
                var alreadyReceived3 = lineData3 ? lineData3.totalReceived : 0;
                var additionalNeeded3 = totalGoodQty3 - alreadyReceived3;

                if (additionalNeeded3 > 0) {
                    // We want to receive this item, so add to "wanted" set
                    wantedItemSet[itemId3] = true;
                    itemsToReceive[itemId3] = additionalNeeded3;
                }
                else {
                    // Nothing to do => skip, do not add
                }
            }

            // If no items have additionalNeeded > 0, we skip creating any item receipt
            if (Object.keys(itemsToReceive).length === 0) {
                // means there's no new quantity to receive
                record.submitFields({
                    type: 'customrecord_mg_po_receipt',
                    id: receiptId,
                    values: {
                        custrecord_poreceipt_processstatus: '3',
                        custrecord_poreceipt_errordetails: 'No incremental quantity to receive.',
                        custrecord_poreceipt_scripterror: ''
                    }
                });
                log.audit('No Incremental Receipt', 'All items additionalNeeded <= 0');
                return;
            }

            // -------------------------------------
            // 8) Actually Create or Update Receipts
            // -------------------------------------
            var newReceiptRec = null;

            // Now we only loop over "itemsToReceive"
            for (var itemId4 in itemsToReceive) {
                if (!itemsToReceive.hasOwnProperty(itemId4)) {
                    continue;
                }

                var addNeeded = itemsToReceive[itemId4];
                var lineData4 = itemLineData[itemId4];
                var isFullyOrOver = false;

                if (lineData4) {
                    var ordered4 = lineData4.totalOrdered;
                    var received4 = lineData4.totalReceived;
                    if (received4 >= ordered4 || lineData4.anyLineClosed) {
                        isFullyOrOver = true;
                    }
                }

                if (isFullyOrOver) {
                    // We update the most recent IR or create new
                    var latestIRid = getMostRecentItemReceiptForPOItem(poId, itemId4);
                    if (!latestIRid) {
                        // None found => create new IR
                        if (!newReceiptRec) {
                            newReceiptRec = createTransformItemReceipt(poId, receiptDate, wantedItemSet);
                        }
                        addLineToReceipt(newReceiptRec, itemId4, addNeeded);
                    } else {
                        updateExistingItemReceipt(latestIRid, itemId4, addNeeded);
                    }
                } else {
                    // Not fully received => create or reuse new IR
                    if (!newReceiptRec) {
                        newReceiptRec = createTransformItemReceipt(poId, receiptDate, wantedItemSet);
                    }
                    addLineToReceipt(newReceiptRec, itemId4, addNeeded);
                }
            }

            // 9) If we created a new receipt, save it
            if (newReceiptRec) {
                var savedNewId = newReceiptRec.save();
                log.audit('New Receipt Created/Updated', 'ID: ' + savedNewId);
            }

            // 10) Mark custom record as Complete
            record.submitFields({
                type: 'customrecord_mg_po_receipt',
                id: receiptId,
                values: {
                    custrecord_poreceipt_processstatus: '3', // 3 - Completed
                    custrecord_poreceipt_errordetails: '',
                    custrecord_poreceipt_scripterror: ''
                }
            });

        } catch (err) {
            var errorDetails = (err && err.message) ? err.message : JSON.stringify(err);
            markAsError(receiptId, errorDetails);
        }
    }

    // --------------------------------------------------------------
    // HELPER FUNCTIONS
    // --------------------------------------------------------------

    /**
     * Helper to mark record as Error
     * => Also logs the error message to custrecord_poreceipt_scripterror
     */
    function markAsError(receiptId, msg) {
        record.submitFields({
            type: 'customrecord_mg_po_receipt',
            id: receiptId,
            values: {
                custrecord_poreceipt_processstatus: '4', // 4 - Error
                custrecord_poreceipt_errordetails: msg,
                custrecord_poreceipt_scripterror: msg
            }
        });
        log.error('Receipt Error ' + receiptId, msg);
    }

    /**
     * findItemBySKU(sku):
     * Return internal ID of item where custitem_mg_sku == SKU
     */
    function findItemBySKU(sku) {
        if (!sku) return null;
        var itemSearchObj = search.create({
            type: search.Type.ITEM,
            filters: [
                ['custitem_mg_sku','is', sku],
                'AND',
                ['matrix','is','F']
            ],
            columns: ['internalid']
        });

        var rs = itemSearchObj.run().getRange({ start: 0, end: 1 });
        if (rs && rs.length > 0) {
            return rs[0].getValue({ name: 'internalid' });
        }
        return null;
    }

    /**
     * getMostRecentItemReceiptForPOItem
     */
    function getMostRecentItemReceiptForPOItem(poId, itemId) {
        var irSearch = search.create({
            type: 'itemreceipt',
            filters: [
                ['createdfrom','anyof', poId],
                'AND',
                ['item','anyof', itemId]
            ],
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.DESC })
            ]
        });

        var rs = irSearch.run().getRange({ start: 0, end: 1 });
        if (rs && rs.length > 0) {
            return rs[0].getValue({ name: 'internalid' });
        }
        return null;
    }

    /**
     * createTransformItemReceipt
     * Creates a new Item Receipt via transform, unchecking lines not in wantedItemSet.
     */
    function createTransformItemReceipt(poId, receiptDate, wantedItemSet) {
        log.debug('WantedItemSet (transforming):', wantedItemSet);

        var irRec = record.transform({
            fromType: record.Type.PURCHASE_ORDER,
            fromId:   poId,
            toType:   record.Type.ITEM_RECEIPT
        });

        if (receiptDate) {
            irRec.setValue({ fieldId: 'trandate', value: receiptDate });
        }

        // uncheck anything not in wantedItemSet
        var lineCount = irRec.getLineCount({ sublistId: 'item' });
        for (var i = 0; i < lineCount; i++) {
            var thisItem = irRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });

            if (!wantedItemSet[thisItem]) {
                // uncheck
                irRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i,
                    value: false
                });
            }
        }
        return irRec;
    }

    /**
     * updateExistingItemReceipt
     * Load existing IR, add additionalQty
     */
    function updateExistingItemReceipt(irId, itemId, additionalQty) {
        var irRec = record.load({
            type: 'itemreceipt',
            id: irId,
            isDynamic: false
        });

        var lineCount = irRec.getLineCount({ sublistId: 'item' });
        for (var i = 0; i < lineCount; i++) {
            var currItem = irRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });
            if (parseInt(currItem, 10) === parseInt(itemId, 10)) {
                var currentQty = parseFloat(irRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i
                })) || 0;
                var newQty = currentQty + additionalQty;
                irRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i,
                    value: newQty
                });
                irRec.save();
                log.audit('Updated Existing IR',
                    'IR=' + irId + ' item=' + itemId + ' oldQty=' + currentQty +
                    ' + ' + additionalQty + ' => newQty=' + newQty
                );
                return;
            }
        }
        log.error('Item line not found on existing IR', 'IR=' + irId + ' itemId=' + itemId);
    }

    /**
     * addLineToReceipt
     * In standard mode, set itemreceive=true and quantity for that line
     */
    function addLineToReceipt(irRec, itemId, quantityToAdd) {
        var lineCount = irRec.getLineCount({ sublistId: 'item' });
        for (var i = 0; i < lineCount; i++) {
            var currItem = irRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            });
            if (parseInt(currItem, 10) === parseInt(itemId, 10)) {
                // Check "itemreceive"
                irRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i,
                    value: true
                });

                irRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: i,
                    value: quantityToAdd
                });
                log.debug('Added line to new IR', 'item=' + itemId + ' qty=' + quantityToAdd + ' lineIndex=' + i);
                return;
            }
        }
        // If not found
        log.error('No matching PO line found for itemId', itemId + ' - cannot add line in standard mode.');
    }

    return {
        execute: execute
    };
});
