/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log'], function(record, log) {
    function beforeLoad(context) {
        if (context.type === context.UserEventType.VIEW) {
            var currentRecord = context.newRecord;
            var fulfillmentHold = currentRecord.getValue({ fieldId: 'custbody_mg_fulfillmenthold' });

            log.debug('Fulfillment Hold field value:', fulfillmentHold);
            if (fulfillmentHold) {
                var form = context.form;
                var fulfillButton = form.getButton('process');
                if (fulfillButton) {
                    log.debug('Hiding fulfill button');
                    fulfillButton.isHidden = true;
                } else {
                    log.debug('Fulfill button not found');
                }
            } else {
                log.debug('Fulfillment Hold is not set');
            }
        }
    }

    return {
        beforeLoad: beforeLoad
    };
});
