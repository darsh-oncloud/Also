/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/runtime', 'N/log'], function (search, record, runtime, log) {

    var LOCATION_ID = 7;

    function getInputData() {
        var searchId = runtime.getCurrentScript().getParameter({
            name: 'customsearch_also_sales_order_items'
        });

        return search.load({
            id: searchId
        });
    }

    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var soId = result.id;

            if (result.values && result.values['GROUP(internalid)']) {
                soId = result.values['GROUP(internalid)'].value || result.values['GROUP(internalid)'];
            }

            if (soId) {
                context.write({
                    key: soId,
                    value: soId
                });
            }

        } catch (e) {
            log.error('MAP ERROR', e);
        }
    }

    function reduce(context) {
        try {
            var soId = context.key;

            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var changed = false;

            if (Number(soRec.getValue({ fieldId: 'location' })) !== LOCATION_ID) {
                soRec.setValue({
                    fieldId: 'location',
                    value: LOCATION_ID
                });
                changed = true;
            }

            var lineCount = soRec.getLineCount({
                sublistId: 'item'
            });

            for (var i = 0; i < lineCount; i++) {
                var itemType = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });

                if (
                    itemType === 'Description' ||
                    itemType === 'Subtotal' ||
                    itemType === 'Group' ||
                    itemType === 'EndGroup'
                ) {
                    continue;
                }

                if (Number(soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                })) !== LOCATION_ID) {
                    soRec.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'location',
                        line: i,
                        value: LOCATION_ID
                    });
                    changed = true;
                }
            }

            if (changed) {
                var saveId = soRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('Sales Order Updated', {
                    soId: soId,
                    saveId: saveId
                });
            }

        } catch (e) {
            log.error('REDUCE ERROR', {
                soId: context.key,
                message: e.message
            });
        }
    }

    function summarize(summary) {
        log.audit('SUMMARY', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});