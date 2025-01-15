/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/runtime'
], function(record, search, log, runtime) {

    /**
     * getInputData():
     *  - Finds customrecord_mg_po_create entries where at least one of the warehouse script statuses
     *    is null or "Ready to Process".
     *  - The search-level filter ensures we only retrieve records that have at least one warehouse needing processing.
     */
    function getInputData() {
        return search.create({
            type: 'customrecord_mg_po_create',
            filters: [
                [
                    [
                        'custrecord_mg_poc_scriptstatusecom', 'anyof', ['@NONE@']
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusecom', 'is', 1
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusretail', 'anyof', ['@NONE@']
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusretail', 'is', 1
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatuswholesale', 'anyof', ['@NONE@']
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatuswholesale', 'is', 1
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusmarket', 'anyof', ['@NONE@']
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusmarket', 'is', 1
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusdropship', 'anyof', ['@NONE@']
                    ], 'OR',
                    [
                        'custrecord_mg_poc_scriptstatusdropship', 'is', 1
                    ]
                ]
            ],
            columns: [
                'internalid',
                // Main fields
                'custrecord_mg_poc_item',
                'custrecord_mg_poc_vendor',
                // Warehouse quantity fields
                'custrecord_mg_poc_ecomwarehouse',
                'custrecord_mg_poc_retailwarehouse',
                'custrecord_mg_poc_dropshipwarehouse',
                'custrecord_mg_poc_wholesalewarehouse',
                'custrecord_mg_poc_marketingwarehouse',
                // External IDs
                'custrecord_mg_poc_externalid_ecom',
                'custrecord_mg_poc_externalid_retail',
                'custrecord_mg_poc_externalid_dropship',
                'custrecord_mg_poc_externalid_wholesale',
                'custrecord_mg_poc_externalid_marketing',
                // Validation totals
                'custrecord_mg_poc_qtyvalidation_ecom',
                'custrecord_mg_poc_qtyvalidation_retail',
                'custrecord_mg_poc_qtyvalidation_dropship',
                'custrecord_mg_poc_qtyvalidation_wholesal',
                'custrecord_mg_poc_qtyvalidation_marketin',
                // Dates & notes
                'custrecord_mg_poc_inhousedate',
                'custrecord_mg_poc_podate',
                'custrecord_mg_poc_mgnotes_internal',
                'custrecord_mg_poc_fobunitcost',
                // Script statuses for each warehouse
                'custrecord_mg_poc_scriptstatusecom',
                'custrecord_mg_poc_scriptstatusretail',
                'custrecord_mg_poc_scriptstatuswholesale',
                'custrecord_mg_poc_scriptstatusmarket',
                'custrecord_mg_poc_scriptstatusdropship'
            ]
        });
    }

    /**
     * map(context):
     *  - For each search result (custom record), we examine each warehouse.
     *  - We only produce a map output if:
     *      1) The warehouse script status is null or "Ready to Process".
     *      2) The external ID for that warehouse is non-empty.
     *      3) The warehouse quantity is non-zero.
     */
    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var recId  = result.id;

            // Helper to get field value from the search result
            function val(fieldId) {
    var raw = result.values[fieldId];
    if (raw && typeof raw === 'object') {
        // If it's an object from a list/record field (like a vendor), 
        // NetSuite Search result returns { value: '123', text: 'Vendor Name' }
        return raw.value;
    }
    // If it's a simple string/number or empty, return it as is
    return raw || '';
}
            // Parse float or return 0
            function parseFloatOrZero(raw) {
                var n = parseFloat(raw);
                return isNaN(n) ? 0 : n;
            }

            // Build an object of the fields we’ll need
            var data = {
                recId:           recId,
                item:            val('custrecord_mg_poc_item'),
                vendor:          val('custrecord_mg_poc_vendor'),
                // Warehouse quantities
                qty_ecom:        parseFloatOrZero(val('custrecord_mg_poc_ecomwarehouse')),
                qty_retail:      parseFloatOrZero(val('custrecord_mg_poc_retailwarehouse')),
                qty_dropship:    parseFloatOrZero(val('custrecord_mg_poc_dropshipwarehouse')),
                qty_wholesale:   parseFloatOrZero(val('custrecord_mg_poc_wholesalewarehouse')),
                qty_marketing:   parseFloatOrZero(val('custrecord_mg_poc_marketingwarehouse')),
                // External IDs
                extId_ecom:      val('custrecord_mg_poc_externalid_ecom'),
                extId_retail:    val('custrecord_mg_poc_externalid_retail'),
                extId_dropship:  val('custrecord_mg_poc_externalid_dropship'),
                extId_wholesale: val('custrecord_mg_poc_externalid_wholesale'),
                extId_marketing: val('custrecord_mg_poc_externalid_marketing'),
                // Validation
                val_ecom:        parseFloatOrZero(val('custrecord_mg_poc_qtyvalidation_ecom')),
                val_retail:      parseFloatOrZero(val('custrecord_mg_poc_qtyvalidation_retail')),
                val_dropship:    parseFloatOrZero(val('custrecord_mg_poc_qtyvalidation_dropship')),
                val_wholesale:   parseFloatOrZero(val('custrecord_mg_poc_qtyvalidation_wholesal')),
                val_marketing:   parseFloatOrZero(val('custrecord_mg_poc_qtyvalidation_marketin')),
                // Dates & notes
                inHouseDate:     val('custrecord_mg_poc_inhousedate'),
                poDate:          val('custrecord_mg_poc_podate'),
                notes:           val('custrecord_mg_poc_mgnotes_internal'),
                unitCost:        parseFloatOrZero(val('custrecord_mg_poc_fobunitcost')),
                // Script statuses
                status_ecom:     val('custrecord_mg_poc_scriptstatusecom'),
                status_retail:   val('custrecord_mg_poc_scriptstatusretail'),
                status_whsl:     val('custrecord_mg_poc_scriptstatuswholesale'),
                status_mktg:     val('custrecord_mg_poc_scriptstatusmarket'),
                status_ds:       val('custrecord_mg_poc_scriptstatusdropship')
            };
            
            log.debug('recId',data.recId);
            log.debug('vendor',data.vendor);
            log.debug('item',data.item);
            /**
             * We will only write if:
             *   (1) the warehouse script status is null or "Ready to Process"
             *   (2) external ID is non-empty
             *   (3) quantity != 0
             */
            function warehouseStatusIsReady(warehouseStatus) {
                return (!warehouseStatus || warehouseStatus === 1);
            }

            // Helper function to do the context.write if conditions pass
            function writeWarehouse(warehouse, extId, qty, status) {
                if (
                    warehouseStatusIsReady(status) &&
                    (extId && extId !== '') &&
                    (qty !== 0)
                ) {
                    var key = warehouse + '|' + extId;
                    context.write({
                        key: key,
                        value: data
                    });
                }
            }

            // ECOM
            writeWarehouse('ecom',      data.extId_ecom,      data.qty_ecom,    data.status_ecom);
            // RETAIL
            writeWarehouse('retail',    data.extId_retail,    data.qty_retail,  data.status_retail);
            // DROPSHIP
            writeWarehouse('dropship',  data.extId_dropship,  data.qty_dropship, data.status_ds);
            // WHOLESALE
            writeWarehouse('wholesale', data.extId_wholesale, data.qty_wholesale, data.status_whsl);
            // MARKETING
            writeWarehouse('marketing', data.extId_marketing, data.qty_marketing, data.status_mktg);

        } catch (e) {
            log.error('MAP ERROR', e);
        }
    }

    /**
     * reduce(context):
     *  - context.key: "warehouse|externalId"
     *  - Accumulate lines for that grouping, sum quantities, compare to validations.
     *  - If mismatch, mark Error; if zero or missing externalId, Skipped - No Data.
     *  - Otherwise, create one PO with multiple lines (unique items, costs).
     */
    function reduce(context) {
        var key        = context.key;          // e.g. "ecom|ABC123"
        var values     = context.values;       // array of JSON strings
        var parts      = key.split('|');
        var warehouse  = parts[0];             // "ecom", "retail", etc.
        var externalId = parts[1];

        var totalQty        = 0;
        var totalValidation = 0;
        var vendor          = null;
        var inHouseDate     = null;
        var poDate          = null;
        var notes           = null;

        // Gather line data for PO
        var lineData   = [];
        // Keep track of record IDs to update statuses
        var recDetails = [];

        // Helper: for each warehouse, get quantity or validation
        function getQtyByWarehouse(obj) {
            switch (warehouse) {
                case 'ecom':       return obj.qty_ecom;
                case 'retail':     return obj.qty_retail;
                case 'dropship':   return obj.qty_dropship;
                case 'wholesale':  return obj.qty_wholesale;
                case 'marketing':  return obj.qty_marketing;
                default:           return 0;
            }
        }
        function getValidationByWarehouse(obj) {
            switch (warehouse) {
                case 'ecom':       return obj.val_ecom;
                case 'retail':     return obj.val_retail;
                case 'dropship':   return obj.val_dropship;
                case 'wholesale':  return obj.val_wholesale;
                case 'marketing':  return obj.val_marketing;
                default:           return 0;
            }
        }

        values.forEach(function(jsonStr) {
            var obj = JSON.parse(jsonStr);

            var qty = getQtyByWarehouse(obj);
            // We assume the "max" or "unique" total validation is the same across all lines in the grouping
            var validation = getValidationByWarehouse(obj);

            totalQty += qty;
            totalValidation = validation;  

            if (!vendor)       vendor      = obj.vendor;
            if (!inHouseDate)  inHouseDate = obj.inHouseDate;
            if (!poDate)       poDate      = obj.poDate;
            if (!notes)        notes       = obj.notes;

            lineData.push({
                recId:    obj.recId,
                item:     obj.item,
                quantity: qty,
                rate:     obj.unitCost
            });

            recDetails.push({ recId: obj.recId });
        });

        log.debug('REDUCE KEY', 'Warehouse: ' + warehouse + ' | External ID: ' + externalId);
        log.debug('REDUCE QUANTITIES', 'Sum Qty: ' + totalQty + ', Validation: ' + totalValidation);

        // Helper: set record status & error
        function setRecordStatus(recId, warehouse, status, errorMsg) {
            try {
                var rec = record.load({
                    type: 'customrecord_mg_po_create',
                    id: recId,
                    isDynamic: true
                });

                var statusField, errorField;
                switch (warehouse) {
                    case 'ecom':
                        statusField = 'custrecord_mg_poc_scriptstatusecom';
                        errorField  = 'custrecord_mg_poc_scripterrorecom';
                        break;
                    case 'retail':
                        statusField = 'custrecord_mg_poc_scriptstatusretail';
                        errorField  = 'custrecord_mg_poc_scripterrorretail';
                        break;
                    case 'wholesale':
                        statusField = 'custrecord_mg_poc_scriptstatuswholesale';
                        errorField  = 'custrecord_mg_poc_scripterrorwholesale';
                        break;
                    case 'marketing':
                        statusField = 'custrecord_mg_poc_scriptstatusmarket';
                        errorField  = 'custrecord_mg_poc_scripterrormarket';
                        break;
                    case 'dropship':
                        statusField = 'custrecord_mg_poc_scriptstatusdropship';
                        errorField  = 'custrecord_mg_poc_scripterrordropship';
                        break;
                }

                rec.setValue({ fieldId: statusField, value: status });
                rec.setValue({ fieldId: errorField,  value: errorMsg });
                rec.save();
            } catch (err) {
                log.error('STATUS UPDATE ERROR', 'Record ' + recId + ': ' + err.message);
            }
        }

        // 1) If externalId missing or totalQty=0 => skip
        if (!externalId || totalQty === 0) {
            log.audit('SKIPPED', 'No External ID or zero total qty for key=' + key);
            recDetails.forEach(function(rd) {
                setRecordStatus(rd.recId, warehouse, 6, ''); //6 = skipped - no data
            });
            return;
        }

        // 2) Compare totalQty vs totalValidation
        if (totalQty !== totalValidation) {
            var errorMsg = 'Sum of qty(' + totalQty + ') != validation(' + totalValidation + ')';
            log.error('VALIDATION ERROR', errorMsg);
            recDetails.forEach(function(rd) {
                setRecordStatus(rd.recId, warehouse, 4, errorMsg); //4 = error
            });
            return;
        }

        // 3) Create one PO for this grouping
        try {
            var poId = createPO({
                vendor:       vendor,
                warehouse:    warehouse,
                externalId:   externalId,
                inHouseDate:  inHouseDate,
                poDate:       poDate,
                notes:        notes,
                lines:        lineData
            });

            log.audit('PO CREATED', 'PO ID=' + poId + ' for ' + key);

            // Mark records as completed
            recDetails.forEach(function(rd) {
                setRecordStatus(rd.recId, warehouse, 3, ''); //3 = completed
            });

        } catch (e) {
            // If there's an error creating the PO, mark all as Error
            log.error('REDUCE ERROR - PO CREATION', e);
            recDetails.forEach(function(rd) {
                setRecordStatus(rd.recId, warehouse, 4, e.message); //4 = error
            });
        }
    }

    /**
     * summarize(summary):
     *  - Logs usage, concurrency, errors from map/reduce
     */
    function summarize(summary) {
        log.audit('SUMMARY', 'Usage: ' + summary.usage + ', Concurrency: '
            + summary.concurrency + ', Yields: ' + summary.yields);

        if (summary.inputSummary.error) {
            log.error('INPUT ERROR', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function(key, errorMsg) {
            log.error('MAP ERROR, key=' + key, errorMsg);
            return true;
        });
        summary.reduceSummary.errors.iterator().each(function(key, errorMsg) {
            log.error('REDUCE ERROR, key=' + key, errorMsg);
            return true;
        });
    }

    /**
     * createPO(params):
     *  - Creates a single Purchase Order record with multiple lines.
     *  - Sets location/class depending on warehouse, copies inHouseDate, sets externalid, etc.
     */
    function createPO(params) {
        if (!params.vendor) {
            throw new Error('Missing vendor; cannot create PO.');
        }

        // Determine class & location from warehouse
        var cls = 108; // from your specs
        var loc = 0;
        switch (params.warehouse) {
            case 'ecom':       loc = 10;  break;
            case 'retail':     loc = 12;  break;
            case 'wholesale':  loc = 11;  break;
            case 'marketing':  loc = 13;  break;
            case 'dropship':   loc = 1;   break;
        }

        var poRec = record.create({
            type: record.Type.PURCHASE_ORDER,
            isDynamic: true
        });

        poRec.setValue({ fieldId: 'entity',     value: params.vendor });
        poRec.setValue({ fieldId: 'department', value: 1 });
        poRec.setValue({ fieldId: 'class',      value: cls });
        poRec.setValue({ fieldId: 'location',   value: loc });

        // PO date -> trandate
        if (params.poDate) {
            var poDateObj = parseDate(params.poDate);
            if (poDateObj) {
                poRec.setValue({ fieldId: 'trandate', value: poDateObj });
            }
        }

        // inHouseDate -> custbody_mg_inhousedate + custbody_mg_inhousedate_original
        if (params.inHouseDate) {
            var inHouseObj = parseDate(params.inHouseDate);
            if (inHouseObj) {
                poRec.setValue({ fieldId: 'custbody_mg_inhousedate', value: inHouseObj });
                poRec.setValue({ fieldId: 'custbody_mg_inhousedate_original', value: inHouseObj });
            }
        }

        // externalId -> both record externalid + custbody_mg_ext_order_number
        if (params.externalId) {
            poRec.setValue({ fieldId: 'externalid', value: params.externalId });
            poRec.setValue({ fieldId: 'custbody_mg_ext_order_number', value: params.externalId });
        }

        // notes -> custbody_mg_notes
        if (params.notes) {
            poRec.setValue({ fieldId: 'custbody_mg_notes', value: params.notes });
        }

        // Add PO lines
        var lines = params.lines || [];
        lines.forEach(function(line) {
            if (!line.item || !line.quantity) {
                return; // skip invalid lines
            }

            poRec.selectNewLine({ sublistId: 'item' });
            poRec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                value: line.item
            });
            poRec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                value: line.quantity
            });
            if (line.rate) {
                poRec.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'rate',
                    value: line.rate
                });
            }

            // expectedreceiptdate = inHouseDate + 3
            if (params.inHouseDate) {
                var expDateObj = parseDate(params.inHouseDate);
                if (expDateObj) {
                    expDateObj.setDate(expDateObj.getDate() + 3);
                    poRec.setCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'expectedreceiptdate',
                        value: expDateObj
                    });
                }
            }

            poRec.commitLine({ sublistId: 'item' });
        });

        return poRec.save();
    }

    /**
     * parseDate(string):
     *  - Helper to parse common date formats into a JS Date object
     */
    function parseDate(dateStr) {
        if (!dateStr) return null;
        // If already Date object, return it
        if (Object.prototype.toString.call(dateStr) === '[object Date]') {
            return dateStr;
        }
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) {
            // Additional logic if needed, or return null
            return null;
        }
        return d;
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});
