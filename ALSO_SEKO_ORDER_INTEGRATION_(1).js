/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/record', 'N/log'], function (search, record, log) {

    var SAVED_SEARCH_ID = 'customsearch_also_sales_order_items';
    var LOCATION_ID = 7;

    function getInputData() {
        return search.load({
            id: SAVED_SEARCH_ID
        });
    }

    function map(context) {
        try {
            var result = JSON.parse(context.value);
            var soId = '';

            log.debug('Search Result', result);

            if (result.values) {
                if (result.values['GROUP(internalid)']) {
                    soId = result.values['GROUP(internalid)'].value || result.values['GROUP(internalid)'];
                } else if (result.values.internalid) {
                    soId = result.values.internalid.value || result.values.internalid;
                }
            }

            if (!soId) {
                log.error('Missing Sales Order Internal ID', result);
                return;
            }

            context.write({
                key: soId,
                value: soId
            });

        } catch (e) {
            log.error('MAP ERROR', {
                message: e.message,
                stack: e.stack
            });
        }
    }

    function reduce(context) {
        var soId = context.key;

        try {
            var soRec = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });

            var changed = false;

            var bodyLocation = soRec.getValue({
                fieldId: 'location'
            });

            if (Number(bodyLocation) !== LOCATION_ID) {
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

                var lineLocation = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'location',
                    line: i
                });

                if (Number(lineLocation) !== LOCATION_ID) {
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
            } else {
                log.debug('No Change Needed', soId);
            }

        } catch (e) {
            log.error('REDUCE ERROR', {
                soId: soId,
                message: e.message,
                stack: e.stack
            });
        }
    }

    function summarize(summary) {
        log.audit('SUMMARY', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('MAP SUMMARY ERROR', {
                key: key,
                error: error
            });
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error('REDUCE SUMMARY ERROR', {
                key: key,
                error: error
            });
            return true;
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});