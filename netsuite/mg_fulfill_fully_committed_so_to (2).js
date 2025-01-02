/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    // Configuration Settings
    const CONFIG = {
        SAVED_SEARCH_ID: 'customsearch_mg_scr_fullycommitted_so_to',
        TARGET_LOCATIONS: ['3', '4', '5', '6', '7', '8', '9', '10'],
        DEFAULT_IF_STATUS: 'A', // Picked
        SHIPPED_IF_STATUS: 'C',  // Shipped
        LOCATIONS_TO_AUTOSHIP: ['3', '4', '5', '6', '7', '8', '9']
    };

    function getInputData() {
        return search.load({ id: CONFIG.SAVED_SEARCH_ID });
    }

    function map(context) {
        const result = JSON.parse(context.value);

        const transactionId = result.values['GROUP(internalid)'].value;
        const transactionType = result.values['GROUP(type)'].value;
        const locationId = result.values['GROUP(location)'].value;

        let fromType;
        if (transactionType === 'SalesOrd') {
            fromType = record.Type.SALES_ORDER;
        } else if (transactionType === 'TrnfrOrd') {
            fromType = record.Type.TRANSFER_ORDER;
        } else {
            log.error('Unexpected transaction type', transactionType);
            return;
        }


        //If the location is not in our target list, skip entirely
        if (!CONFIG.TARGET_LOCATIONS.includes(locationId)) {
            log.debug('Skipping non-target location', `Location: ${locationId} not in ${CONFIG.TARGET_LOCATIONS}`);
            return;
        }
      
        // Load the source transaction
        let soRec;
        try {
            soRec = record.load({ type: fromType, id: parseInt(transactionId, 10), isDynamic: false });
        } catch (e) {
            log.error('Error loading record', `Transaction ID: ${transactionId}, Type: ${fromType}, Error: ${e}`);
            return;
        }


        // Check if any line is fulfilled
        if (isAnyLineFulfilled(soRec)) {
            log.debug('Skipping Fulfillment', 'A fulfillment already exists for this order.');
            return;
        }

        try {
            const fulfillmentRec = record.transform({
                fromType: fromType,
                fromId: parseInt(transactionId, 10),
                toType: record.Type.ITEM_FULFILLMENT,
                isDynamic: true
            });

            // Filter lines to only itemreceive those from locationId
            filterFulfillmentLines(fulfillmentRec, locationId);

            // Determine the IF status to set based on the current location
            const fulfillmentStatus = CONFIG.LOCATIONS_TO_AUTOSHIP.includes(locationId)
                ? CONFIG.SHIPPED_IF_STATUS
                : CONFIG.DEFAULT_IF_STATUS;

            fulfillmentRec.setValue({ fieldId: 'shipstatus', value: fulfillmentStatus });
            const fulfillmentId = fulfillmentRec.save();

            log.audit('Item Fulfillment Created', `Fulfillment ID: ${fulfillmentId} for ${transactionType} ${transactionId} at Location: ${locationId}`);

        } catch (error) {
            log.error({
                title: `Error processing ${transactionType} ${transactionId} at Location ${locationId}`,
                details: error
            });
        }
    }

    function reduce(context) {
        // Not needed since each record is processed in map()
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error('Input Error', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map Error for key: ${key}`, error);
            return true;
        });

        log.audit('Summary', {
            TotalUsage: summary.usage,
            Concurrency: summary.concurrency,
            Yields: summary.yields
        });
    }


    function isAnyLineFulfilled(soRec) {
        const lineCount = soRec.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < lineCount; i++) {
            const lineFulfilled = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'islinefulfilled',
                line: i
            });
            if (lineFulfilled === 'T') {
                return true;
            }
        }
        return false;
    }

    function filterFulfillmentLines(fulfillmentRec, singleLocation) {
        const lineCount = fulfillmentRec.getLineCount({ sublistId: 'item' });
        const singleLocationStr = String(singleLocation);
        for (let i = 0; i < lineCount; i++) {
            fulfillmentRec.selectLine({ sublistId: 'item', line: i });
            const lineLocation = fulfillmentRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });
            const lineLocationStr = String(lineLocation);

            if (lineLocationStr !== singleLocationStr) {
                fulfillmentRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
            } else {
                fulfillmentRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
            }

            fulfillmentRec.commitLine({ sublistId: 'item' });
        }
    }


    return {
        getInputData,
        map,
        reduce,
        summarize
    };
});