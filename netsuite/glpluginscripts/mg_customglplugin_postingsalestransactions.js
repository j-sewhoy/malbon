/**
 * @NApiVersion 2.x
 * @NScriptType customglplugin
 */
define(['N/record', 'N/log'], function(record, log) {

    var rules = [
        {
            name: 'Sales Tax Reclass',
            condition: function(context) {
                log.debug({ title: 'Sales Tax Reclass Condition Check', details: 'Evaluating condition...' });
                
                var transactionRecord = context.transactionRecord;
                var tranType = transactionRecord.getValue({ fieldId: 'type' });
                log.debug({ title: 'Transaction Type', details: tranType });

                if (['custinvc','custcred','cashsale','cashrfnd'].indexOf(tranType) === -1) {
                    log.debug({ title: 'Condition Not Met', details: 'Transaction type not in list' });
                    return false;
                }

                var categoryId = transactionRecord.getValue({ fieldId:'custbody_mg_salestax_reclass_category' });
                log.debug({ title: 'Category ID Check', details: 'CategoryId: ' + categoryId });

                var conditionMet = !!categoryId;
                log.debug({ title: 'Condition Result', details: 'Sales Tax Reclass condition: ' + conditionMet });
                return conditionMet;
            },
            transformLines: function(context) {
                log.debug({ title: 'Sales Tax Reclass Transform', details: 'Starting transform...' });
                
                try {
                    var transactionRecord = context.transactionRecord;
                    var standardLines = context.standardLines;
                    var customLines = context.customLines;

                    var categoryId = transactionRecord.getValue({fieldId:'custbody_mg_salestax_reclass_category'});
                    var categoryRecord = record.load({
                        type: 'customrecord_mg_salestax_reclass_categor',
                        id: categoryId
                    });

                    var reclassAccountIdRaw = categoryRecord.getValue('custrecord_mg_tax_reclass_account') || 392;
                    var reclassAccountId = Number(reclassAccountIdRaw);

                    var categoryName = categoryRecord.getValue('name'); // for memo

                    log.debug({ title: 'Reclass Account and Category', details: 'reclassAccountId: ' + reclassAccountId + ', categoryName: ' + categoryName });

                    if (!reclassAccountId) {
                        log.debug({ title: 'No Reclass Account', details: 'No reclass account specified, skipping...' });
                        return;
                    }

                    var SALES_TAX_ACCT_ID = 210;

                    var lineCount = standardLines.count;
                    log.debug({ title: 'Line Count', details: 'Standard Lines Count: ' + lineCount });

                    for (var i = 0; i < lineCount; i++) {
                        var stdLine = standardLines.getLine({ index: i });
                        var acct = stdLine.accountId || 9999999;

                        log.debug({title:'Checking Standard Line', details:'Line ' + (i-1) + ' acct:' + acct});

                        if (acct === SALES_TAX_ACCT_ID) {
                            var debitAmt = stdLine.debitAmount || 0;
                            var creditAmt = stdLine.creditAmount || 0;
                            var dept = stdLine.departmentId;
                            var cls = stdLine.classId;
                            var loc = stdLine.locationId;
                            var ent = stdLine.entityId;
                            var originalMemo = stdLine.memo || '';

                            log.debug({
                                title: 'Processing Tax Line',
                                details: 'Line ' + i + ' dept:' + dept + ' class:' + cls + ' loc:' + loc + ' debit:' + debitAmt + ' credit:' + creditAmt
                            });

                            // Offset line
                            var offsetLine = customLines.addNewLine();
                            offsetLine.accountId = SALES_TAX_ACCT_ID;
                            if (creditAmt > 0) {
                                offsetLine.debitAmount = creditAmt;
                            }
                            if (debitAmt > 0) {
                                offsetLine.creditAmount = debitAmt;
                            }
                            if (dept) offsetLine.departmentId = dept;
                            if (cls) offsetLine.classId = cls;
                            if (loc) offsetLine.locationId = loc;
                            if (ent) offsetLine.entityId = ent;

                            var offsetMemo = 'Reclass Sales Tax : ' + categoryName;
                            if (originalMemo.trim() !== '') {
                                offsetMemo += ' | ' + originalMemo;
                            }
                            offsetLine.memo = offsetMemo + ' (Offset)';
                            offsetLine.isBookSpecific = false;

                            // Reclass line
                            var reclassLine = customLines.addNewLine();
                            reclassLine.accountId = reclassAccountId;
                            if (creditAmt > 0) {
                                reclassLine.creditAmount = creditAmt;
                            }
                            if (debitAmt > 0) {
                                reclassLine.debitAmount = debitAmt;
                            }

                            if (dept) reclassLine.departmentId = dept;
                            if (cls) reclassLine.classId = cls;
                            if (loc) reclassLine.locationId = loc;
                            if (ent) reclassLine.entityId = ent;

                            var reclassMemo = 'Reclass Sales Tax : ' + categoryName;
                            if (originalMemo.trim() !== '') {
                                reclassMemo += ' | ' + originalMemo;
                            }
                            reclassLine.memo = reclassMemo;
                            reclassLine.isBookSpecific = false;

                            log.debug({
                                title: 'Lines Created',
                                details: 'Created offset and reclass lines for line ' + i
                            });
                            log.debug({
                                title: 'Lines Created - reclassLine Details',
                                details: reclassLine
                            });
                            log.debug({
                                title: 'Lines Created - offsetLine Details',
                                details: offsetLine
                            });
                        }
                    }
                } catch (e) {
                    log.error({ title: 'Error in Sales Tax Reclass Transform', details: e.toString() });
                }
            }
        }
        // Future rules can be added as objects here...
    ];

    function customizeGlImpact(context) {
        log.debug({ title: 'customizeGlImpact', details: 'Entered customizeGlImpact function' });
        try {
            for (var i = 0; i < rules.length; i++) {
                if (rules[i].condition(context)) {
                    log.debug({ title: 'Rule Match', details: 'Rule ' + rules[i].name + ' matched conditions, transforming lines...' });
                    rules[i].transformLines(context);
                }
            }
        } catch (e) {
            log.error({ title: 'Error in customizeGlImpact', details: e.toString() });
        }
        log.debug({ title: 'customizeGlImpact', details: 'Exiting customizeGlImpact function' });
    }

    return {
        customizeGlImpact: customizeGlImpact
    };
});
