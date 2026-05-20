/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_ID = '68e8197b53e4a108b091452c';

    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    var MAX_RETRY_CHECKS = 8; // 8 * 5 sec = 40 sec

    function getInputData() {
        try {
            var errors = getCeligoErrors();

            for (var i = 0; i < errors.length; i++) {
                var err = errors[i];
                var msg = err.message || '';
                var code = err.code || '';

                if ((code == 'closed_salesorder' || msg.indexOf('already "Closed"') > -1) && err.retry != 'true') {
                    return [err]; // only 1 error per run
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

            if (!retryResult.success || !retryResult.retryJobId) {
                closeOnlyOpenedLines(salesOrderId, openedLines);
                log.error('RETRY API FAILED - LINES CLOSED BACK', JSON.stringify({
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }));
                return;
            }

            var retryFinishStatus = waitUntilRetryJobFinished(retryResult.retryJobId);

            if (retryFinishStatus.finished === true) {
                closeOnlyOpenedLines(salesOrderId, openedLines);

                log.audit('PROCESS COMPLETE', JSON.stringify({
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    originalErrorId: errorId,
                    retryDataKey: retryDataKey,
                    retryJobId: retryResult.retryJobId,
                    openedAndClosedLines: openedLines,
                    retryStatus: retryFinishStatus
                }));
            } else {
                log.error('RETRY NOT FINISHED - LINES LEFT OPEN', JSON.stringify({
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    retryJobId: retryResult.retryJobId,
                    openedLines: openedLines,
                    retryStatus: retryFinishStatus
                }));
            }

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

    function waitUntilRetryJobFinished(retryJobId) {
        var lastStatus = {};

        for (var i = 0; i < MAX_RETRY_CHECKS; i++) {
            waitFiveSeconds();

            lastStatus = getRetryJobStatus(retryJobId);

            if (lastStatus.finished === true) {
                return lastStatus;
            }
        }

        return {
            finished: false,
            result: 'not_finished_after_40_seconds',
            lastStatus: lastStatus
        };
    }

    function waitFiveSeconds() {
        try {
            https.get({
                url: 'https://httpbin.org/delay/5'
            });
        } catch (e) {
            // ignore wait error
        }
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

        var status = body.status || '';
        var doneExporting = body.doneExporting === true;
        var numSuccess = Number(body.numSuccess || 0);
        var numError = Number(body.numError || 0);
        var numOpenError = Number(body.numOpenError || 0);

        var finished = false;
        var result = 'running';

        if (
            status == 'completed' ||
            status == 'complete' ||
            status == 'finished' ||
            status == 'done' ||
            status == 'failed' ||
            doneExporting === true ||
            numSuccess > 0 ||
            numError > 0 ||
            numOpenError > 0
        ) {
            finished = true;
        }

        if (finished) {
            if (numSuccess > 0 && numError === 0 && numOpenError === 0) {
                result = 'retry_success';
            } else if (numError > 0 || numOpenError > 0 || status == 'failed') {
                result = 'retry_failed';
            } else {
                result = 'retry_finished_unknown';
            }
        }

        return {
            finished: finished,
            result: result,
            status: status,
            doneExporting: doneExporting,
            numSuccess: numSuccess,
            numError: numError,
            numOpenError: numOpenError
        };
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