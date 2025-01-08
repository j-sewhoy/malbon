/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 */
define(['N/error', 'N/search'], function(error, search) {

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.CREATE && 
            context.type !== context.UserEventType.COPY) {
            return;
        }

        var ifRec = context.newRecord;

        // Check the Sales Order's hold field (already sourced onto the IF)...
        var orderHoldValue = ifRec.getValue({ fieldId: 'custbody_mg_fulfillmenthold' });
        var orderHoldText  = ifRec.getText({ fieldId: 'custbody_mg_fulfillmenthold' });
        log.debug('orderHoldValue', orderHoldValue);
        log.debug('orderHoldText', orderHoldText);

        // Check the Customer hold field (sourced from the Sales Order to the IF)...
        var customerHoldValue = ifRec.getValue({ fieldId: 'custbody_mg_customerholdstatus' });
        var customerHoldText  = ifRec.getText({ fieldId: 'custbody_mg_customerholdstatus' });
        log.debug('customerHoldValue', customerHoldValue);
        log.debug('customerHoldText', customerHoldText);

        // If either hold is set, block the creation:
        if (orderHoldValue || customerHoldValue) {

            // 1) Get the "Created From" transaction
            var createdFromId = ifRec.getValue({ fieldId: 'createdfrom' });
            var docNumber = '';
            if (createdFromId) {
                // 2) Lookup the recordtype + tranid of the parent transaction
                var parentLookup = search.lookupFields({
                    type: 'transaction',
                    id: createdFromId,
                    columns: ['recordtype', 'tranid']
                });

                // The parent's doc number is in 'tranid'
                docNumber = parentLookup.tranid || '';
            }

            // 3) Build a more descriptive error message
            var msgParts = [];
            if (orderHoldValue) {
                msgParts.push('Order Hold: ' + orderHoldText);
            }
            if (customerHoldValue) {
                msgParts.push('Customer Hold Active: ' + customerHoldText);
            }

            var errorMessage = 'Fulfillment is blocked from parent transaction: ' + 
                               (docNumber ? docNumber : '(No Parent Doc Number)') + 
                               '. Reason(s): ' + msgParts.join(' | ');

            // 4) Throw the error
            throw error.create({
                name: 'MG_FULFILLMENT_HOLD_ERROR',
                message: errorMessage,
                notifyOff: false
            });
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
