/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], (record, log) => {

    /**
     * Configuration object to centralize all constants and settings.
     * Adjust these as new requirements emerge.
     */
    const CONFIG = {
        ALLOWED_CLASSES: ['1', '3', '101', '102', '103', '104', '105', '106', '107'],
        TARGET_LOCATIONS: ['3', '4', '5', '6', '7', '8', '9', '10'],
        SHIPPED_LOCATIONS: ['3', '4', '5', '6', '7', '8', '9'],
        DEFAULT_IF_STATUS: 'A', // 'A' = Picked
        SHIPPED_IF_STATUS: 'C', // 'C' = Shipped

        // Future: Add new configuration properties here as needed,
        // such as additional filters, item types, or other logic toggles.
    };

    /**
     * Entry point for the User Event script after a Sales Order is submitted.
     * This function orchestrates the main logic by calling helper functions.
     */
    function afterSubmit(context) {
        // Only run on creation
       log.debug('Enter mg_ue_aftersubmit_salesorder.hs After Submit',context.type);
      
        if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
            return;
        }
        log.debug('Enter mg_ue_aftersubmit_salesorder.hs After Submit','Step 2');
        const soRec = context.newRecord;

        // Check preliminary conditions before proceeding
        if (!checkHeaderConditions(soRec, CONFIG)) {
            log.debug('mg_ue_aftersubmit_salesorder.hs Check Header Fail');
            return;
        }

        // Check if any line is already fulfilled (including partial),
        // indicating a fulfillment already exists.
        if (isAnyLineFulfilled(soRec)) {
            log.debug('Skipping Fulfillment', 'A fulfillment already exists for this Sales Order.');
            return;
        }

        // Identify which locations are fully committed
        const fullyCommittedLocations = getFullyCommittedLocations(soRec, CONFIG);
        if (fullyCommittedLocations.length === 0) {
            // Nothing to fulfill
            return;
        }

        // Create fulfillments for each fully committed location
        createFulfillments(soRec, fullyCommittedLocations, CONFIG);
    }

    /**
     * Checks if the record should be processed based on various conditions,
     * such as the Sales Order's class, or other criteria.
     *
     * Add new conditions by extending this function.
     */
    function checkHeaderConditions(soRec, config) {
        const orderClass = String(soRec.getValue({ fieldId: 'class' }));
        log.debug('checkHeaderConditions orderClass',orderClass);
        if (!config.ALLOWED_CLASSES.includes(orderClass)) {
            return false;  
        }

        // Future conditions:
        // - Check for certain departments, subsidiaries, or fields.
        // - Validate dates or custom fields.
        // Simply add more if-conditions here.

        return true;
    }

    /**
     * Checks if any line on the Sales Order is already fulfilled.
     * If `islinefulfilled` is true for any line, a fulfillment exists (partial or full).
     */
    function isAnyLineFulfilled(soRec) {
    const lineCount = soRec.getLineCount({ sublistId: 'item' });
    for (let i = 0; i < lineCount; i++) {
        const lineFulfilled = soRec.getSublistValue({
            sublistId: 'item',
            fieldId: 'islinefulfilled',
            line: i
        });

        log.debug('lineFulfilled', lineFulfilled); // Check what it returns in the logs

        // If lineFulfilled returns 'T' for fulfilled lines:
        if (lineFulfilled === 'T') {
            // Already fulfilled
            return true;
        }
    }
    return false;
    }

    /**
     * Determines which locations are fully committed.
     * Fully committed means:
     * - The location is among TARGET_LOCATIONS.
     * - Lines are fulfillable (fulfillable = true).
     * - Lines are open (not closed), with qty > 0.
     * - quantity = quantitycommitted for all such lines.
     *
     * Returns an array of location IDs that meet these criteria.
     */
    function getFullyCommittedLocations(soRec, config) {
        const lineCount = soRec.getLineCount({ sublistId: 'item' });
        const locationToLines = {};

        for (let i = 0; i < lineCount; i++) {
            const lineLocation = String(soRec.getSublistValue({ sublistId: 'item', fieldId: 'location', line: i }));
            const isFulfillable = soRec.getSublistValue({ sublistId: 'item', fieldId: 'fulfillable', line: i });
            const isClosed = soRec.getSublistValue({ sublistId: 'item', fieldId: 'isclosed', line: i }) === true; 
            const qty = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity', line: i }) || 0;

            // Skip lines that are not relevant
            if (!config.TARGET_LOCATIONS.includes(lineLocation) || !isFulfillable || isClosed || qty === 0) {
                continue;
            }

            const qtyCommitted = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantitycommitted', line: i }) || 0;

            if (!locationToLines[lineLocation]) {
                locationToLines[lineLocation] = [];
            }

            locationToLines[lineLocation].push({ qty, qtyCommitted });
        }

        const fullyCommittedLocations = [];
        for (const loc in locationToLines) {
            const lines = locationToLines[loc];
            const allCommitted = lines.every(line => line.qty === line.qtyCommitted);
            if (allCommitted && lines.length > 0) {
                fullyCommittedLocations.push(loc);
            }
        }

        return fullyCommittedLocations;
    }

    /**
     * Creates fulfillments for each location that is fully committed.
     * Since each fulfillment can only contain one location, we:
     * - Transform the Sales Order into an Item Fulfillment.
     * - Remove lines not matching the current location.
     * - Determine the appropriate status (Picked or Shipped).
     * - Save the fulfillment.
     *
     * This is the main logic that could be extended in the future if new
     * statuses, conditions, or line adjustments are needed.
     */
    function createFulfillments(soRec, locations, config) {
        locations.forEach((locationId) => {
            try {
                const fulfillmentRec = record.transform({
                    fromType: record.Type.SALES_ORDER,
                    fromId: soRec.id,
                    toType: record.Type.ITEM_FULFILLMENT,
                    isDynamic: true
                });

                // Remove lines not from the current location
                filterFulfillmentLines(fulfillmentRec, locationId);

                // Determine the IF status to set based on the current location
                const fulfillmentStatus = config.SHIPPED_LOCATIONS.includes(locationId)
                    ? config.SHIPPED_IF_STATUS
                    : config.DEFAULT_IF_STATUS;

                fulfillmentRec.setValue({ fieldId: 'shipstatus', value: fulfillmentStatus });
                const fulfillmentId = fulfillmentRec.save();

                log.audit('Item Fulfillment Created', `Fulfillment ID: ${fulfillmentId} for Sales Order: ${soRec.id}, Location: ${locationId}`);
            } catch (error) {
                log.error({ title: `Error creating fulfillment for SO ${soRec.id}, Location: ${locationId}`, details: error });
            }
        });
    }

    /**
     * Filters lines in the fulfillment to only include those from the specified location.
     * After this, the fulfillment should have lines from one location only.
     */
    function filterFulfillmentLines(fulfillmentRec, singleLocation) {
      const lineCount = fulfillmentRec.getLineCount({ sublistId: 'item' });
      for (let i = 0; i < lineCount; i++) {
        fulfillmentRec.selectLine({ sublistId: 'item', line: i });
        const lineLocation = String(fulfillmentRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' }));
        
        // If the line's location is not the desired location, mark it as not received (not fulfilled)
        if (lineLocation !== singleLocation) {
            fulfillmentRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
        } else {
            // For lines you want to fulfill, ensure itemreceive = true
            fulfillmentRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true });
        }

        fulfillmentRec.commitLine({ sublistId: 'item' });
    }
}

    return {
        afterSubmit: afterSubmit
    };
});