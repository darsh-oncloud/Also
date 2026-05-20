/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_ID = '68e8197b53e4a108b091452c';

    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    var MAX_ERRORS_PER_RUN = 10;

    function getInputData() {
        try {
            var errors = getCeligoErrors();
            var selectedErrors = [];

            for (var i = 0; i < errors.length; i++) {
                var err = errors[i];
                var msg = err.message || '';
                var code = err.code || '';

                if ((code == 'closed_salesorder' || msg.indexOf('already "Closed"') > -1) && err.retry != 'true') {
                    selectedErrors.push(err);

                    if (selectedErrors.length >= MAX_ERRORS_PER_RUN) {
                        break;
                    }
                }
            }

            log.audit('ERRORS SELECTED', selectedErrors.length);
            return selectedErrors;

        } catch (e) {
            log.error('GET INPUT ERROR', e);
            return [];
        }
    }

    function map(context) {
        try {
            var err = JSON.parse(context.value);

            var errorId = err.errorId || err.id || err._id;
            var retryDataKey = err.retryDataKey;
            var shopifyOrderId = getShopifyOrderId(err.message || '', err);
            var salesOrderId = findSalesOrder(shopifyOrderId);

            if (!salesOrderId) {
                log.error('SO NOT FOUND', shopifyOrderId);
                return;
            }

            var openedLines = openAllClosedLines(salesOrderId);
            var retryResult = retryCeligoError(err);

            context.write({
                key: 'processed',
                value: {
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }
            });

        } catch (e) {
            log.error('MAP ERROR', e);
        }
    }

    function reduce(context) {
        var processedList = [];

        for (var i = 0; i < context.values.length; i++) {
            processedList.push(JSON.parse(context.values[i]));
        }

        log.audit('RETRY SUBMITTED COUNT', processedList.length);

        waitThirtySeconds();

        for (var x = 0; x < processedList.length; x++) {
            var item = processedList[x];

            var jobStatus = {};

            if (item.retryResult && item.retryResult.retryJobId) {
                jobStatus = getRetryJobStatus(item.retryResult.retryJobId);
            } else {
                jobStatus = {
                    result: 'retry_api_failed_or_missing_job_id',
                    retryResult: item.retryResult
                };
            }

            closeOnlyOpenedLines(item.salesOrderId, item.openedLines);

            log.audit('ORDER CLOSED BACK', JSON.stringify({
                shopifyOrderId: item.shopifyOrderId,
                salesOrderId: item.salesOrderId,
                errorId: item.errorId,
                retryDataKey: item.retryDataKey,
                retryJobId: item.retryResult ? item.retryResult.retryJobId : '',
                openedLines: item.openedLines,
                jobStatus: jobStatus
            }));
        }
    }

    function waitThirtySeconds() {
        try {
            https.get({
                url: 'https://httpbin.org/delay/30'
            });
        } catch (e) {
            log.error('WAIT FAILED - CONTINUING', e);
        }
    }

    function getCeligoErrors() {
        var response = https.get({
            url: 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/errors',
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

        var response = https.post({
            url: 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/retry',
            headers: getHeaders(),
            body: JSON.stringify({
                retryDataKeys: [String(retryDataKey)]
            })
        });

        var body = {};
        try {
            body = JSON.parse(response.body || '{}');
        } catch (e) {}

        return {
            success: response.code >= 200 && response.code < 300,
            code: response.code,
            retryJobId: body._id || '',
            body: response.body
        };
    }

    function getRetryJobStatus(retryJobId) {
        var response = https.get({
            url: 'https://api.integrator.io/v1/jobs/' + retryJobId,
            headers: getHeaders()
        });

        if (response.code < 200 || response.code >= 300) {
            return {
                finished: false,
                result: 'job_status_check_failed',
                code: response.code,
                body: response.body
            };
        }

        var body = JSON.parse(response.body || '{}');

        return {
            status: body.status || '',
            doneExporting: body.doneExporting === true,
            numSuccess: Number(body.numSuccess || 0),
            numError: Number(body.numError || 0),
            numOpenError: Number(body.numOpenError || 0)
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

        summary.reduceSummary.errors.iterator().each(function (key, error) {
            log.error('REDUCE ERROR ' + key, error);
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
        reduce: reduce,
        summarize: summarize
    };
});