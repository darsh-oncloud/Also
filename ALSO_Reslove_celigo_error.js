/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_ID = '68e8197b53e4a108b091452c';

    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    var MAX_RETRY_CHECKS = 12;

    function getInputData() {
        try {
            var errors = getCeligoErrors();

            for (var i = 0; i < errors.length; i++) {
                var err = errors[i];
                var msg = err.message || '';
                var code = err.code || '';

                if ((code == 'closed_salesorder' || msg.indexOf('already "Closed"') > -1) && err.retry != 'true') {
                    return [err];
                }
            }

            log.audit('NO ERROR TO PROCESS', 'No new closed_salesorder error found');
            return [];

        } catch (e) {
            log.error('GET INPUT ERROR', e);
            return [];
        }
    }

    function map(context) {
        var salesOrderId = '';
        var openedLines = [];

        try {
            var err = JSON.parse(context.value);

            var errorId = err.errorId || err.id || err._id;
            var retryDataKey = err.retryDataKey;
            var shopifyOrderId = getShopifyOrderId(err.message || '', err);

            salesOrderId = findSalesOrder(shopifyOrderId);

            if (!salesOrderId) {
                log.error('PROCESS FAILED', 'Sales Order not found for Shopify Order: ' + shopifyOrderId);
                return;
            }

            openedLines = openAllClosedLines(salesOrderId);

            var retryResult = retryCeligoError(err);

            if (!retryResult.success) {
                closeOnlyOpenedLines(salesOrderId, openedLines);
                log.error('RETRY API FAILED - LINES CLOSED BACK', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }));
                return;
            }

            var retryFinishStatus = waitUntilRetryFinished(retryDataKey, errorId);

            closeOnlyOpenedLines(salesOrderId, openedLines);

            log.audit('PROCESS COMPLETE', JSON.stringify({
                shopifyOrderId: shopifyOrderId,
                salesOrderId: salesOrderId,
                originalErrorId: errorId,
                retryDataKey: retryDataKey,
                openedAndClosedLines: openedLines,
                retryStatus: retryFinishStatus
            }));

        } catch (e) {
            try {
                if (salesOrderId && openedLines && openedLines.length) {
                    closeOnlyOpenedLines(salesOrderId, openedLines);
                }
            } catch (closeErr) {
                log.error('FAILED TO CLOSE LINES AFTER ERROR', closeErr);
            }

            log.error('PROCESS ERROR', e);
        }
    }

    function waitUntilRetryFinished(retryDataKey, originalErrorId) {
        var lastStatus = {
            finished: false,
            result: 'not_confirmed'
        };

        for (var i = 0; i < MAX_RETRY_CHECKS; i++) {
            var errors = getCeligoErrors();
            var sameRetryErrorFound = false;
            var retryFailedErrorFound = false;

            for (var x = 0; x < errors.length; x++) {
                var err = errors[x];

                if (String(err.retryDataKey) == String(retryDataKey)) {
                    sameRetryErrorFound = true;

                    if (err.retry == 'true' || String(err.errorId) != String(originalErrorId)) {
                        retryFailedErrorFound = true;
                        lastStatus = {
                            finished: true,
                            result: 'retry_failed',
                            retryErrorId: err.errorId,
                            message: err.message
                        };
                    }
                }
            }

            if (retryFailedErrorFound) {
                return lastStatus;
            }

            if (!sameRetryErrorFound) {
                return {
                    finished: true,
                    result: 'retry_success_or_error_resolved'
                };
            }
        }

        return lastStatus;
    }

    function getCeligoErrors() {
        var url = 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/errors';

        var response = https.get({
            url: url,
            headers: getHeaders()
        });

        if (response.code < 200 || response.code >= 300) {
            throw new Error('Failed to get Celigo errors. Code: ' + response.code + ' Body: ' + response.body);
        }

        var body = JSON.parse(response.body || '{}');
        return body.errors || [];
    }

    function retryCeligoError(errorObj) {
        var retryDataKey = errorObj.retryDataKey;

        if (!retryDataKey) {
            return {
                success: false,
                message: 'Missing retryDataKey'
            };
        }

        var url = 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/retry';

        var response = https.post({
            url: url,
            headers: getHeaders(),
            body: JSON.stringify({
                retryDataKeys: [String(retryDataKey)]
            })
        });

        return {
            success: response.code >= 200 && response.code < 300,
            code: response.code,
            body: response.body
        };
    }

    function getShopifyOrderId(message, err) {
        var match = message.match(/Shopify order #(\d+)/);
        if (match && match[1]) return match[1];

        if (err.traceKey) return String(err.traceKey);

        return '';
    }

    function findSalesOrder(shopifyOrderId) {
        var soSearch = search.create({
            type: search.Type.SALES_ORDER,
            filters: [
                ['mainline', 'is', 'T'],
                'AND',
                [SHOPIFY_ORDER_FIELD, 'is', String(shopifyOrderId)]
            ],
            columns: ['internalid']
        });

        var result = soSearch.run().getRange({
            start: 0,
            end: 1
        });

        return result && result.length ? result[0].getValue('internalid') : '';
    }

    function openAllClosedLines(salesOrderId) {
        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var openedLines = [];
        var lineCount = soRec.getLineCount({ sublistId: 'item' });

        for (var i = 0; i < lineCount; i++) {
            var isClosed = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'isclosed',
                line: i
            });

            if (isClosed === true || isClosed === 'T') {
                var lineKey = soRec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

                openedLines.push(String(lineKey));

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: false
                });
            }
        }

        if (openedLines.length) {
            soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });
        }

        return openedLines;
    }

    function closeOnlyOpenedLines(salesOrderId, openedLines) {
        if (!openedLines || !openedLines.length) return;

        var lineMap = {};

        for (var i = 0; i < openedLines.length; i++) {
            lineMap[String(openedLines[i])] = true;
        }

        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({ sublistId: 'item' });

        for (var j = 0; j < lineCount; j++) {
            var lineKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: j
            });

            if (lineMap[String(lineKey)]) {
                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: j,
                    value: true
                });
            }
        }

        soRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });
    }

    function getHeaders() {
        return {
            'Authorization': 'Bearer ' + CELIGO_API_TOKEN,
            'Content-Type': 'application/json'
        };
    }

    function summarize(summary) {
        if (summary.inputSummary.error) {
            log.error('INPUT ERROR', summary.inputSummary.error);
        }

        summary.mapSummary.errors.iterator().each(function (key, error) {
            log.error('MAP ERROR ' + key, error);
            return true;
        });

        log.audit('SUMMARY COMPLETE', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields
        });
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});