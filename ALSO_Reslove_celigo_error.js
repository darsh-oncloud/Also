/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_ID = '68e8197b53e4a108b091452c';

    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    var WAIT_SECONDS = 5;
    var MAX_WAIT_SECONDS = 45;

    function getInputData() {
        try {
            var url = 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/errors';

            log.audit('GET ERROR URL', url);

            var response = https.get({
                url: url,
                headers: getHeaders()
            });

            log.audit('GET ERROR RESPONSE CODE', response.code);
            log.debug('GET ERROR RESPONSE BODY', response.body);

            if (response.code < 200 || response.code >= 300) {
                log.error('FAILED TO GET CELIGO ERRORS', response.body);
                return [];
            }

            var body = JSON.parse(response.body || '{}');
            var errors = body.errors || body.data || body.results || body || [];

            log.audit('TOTAL ERRORS FOUND', errors.length);

            for (var i = 0; i < errors.length; i++) {
                var err = errors[i];
                var msg = err.message || err.errorMessage || '';
                var code = err.code || err.errorCode || '';

                if (code == 'closed_salesorder' || msg.indexOf('already "Closed"') > -1 || msg.indexOf('closed') > -1) {
                    log.audit('MATCHING CLOSED ORDER ERROR FOUND', JSON.stringify(err));
                    return [err];
                }
            }

            log.audit('NO MATCHING CLOSED ORDER ERROR FOUND', '');
            return [];

        } catch (e) {
            log.error('getInputData ERROR', e);
            return [];
        }
    }

    function map(context) {
        try {
            var err = JSON.parse(context.value);

            log.audit('PROCESS STARTED FOR ERROR', JSON.stringify(err));

            var message = err.message || err.errorMessage || '';
            var errorId = err.errorId || err.id || err._id;
            var retryDataKey = err.retryDataKey;

            log.audit('CELIGO ERROR DETAILS', JSON.stringify({
                errorId: errorId,
                retryDataKey: retryDataKey
            }));

            var shopifyOrderId = getShopifyOrderId(message, err);

            if (!shopifyOrderId) {
                log.error('STOPPED - ORDER ID NOT FOUND FROM ERROR', JSON.stringify(err));
                return;
            }

            log.audit('SHOPIFY ORDER ID FOUND', shopifyOrderId);

            var salesOrderId = findSalesOrder(shopifyOrderId);

            if (!salesOrderId) {
                log.error('STOPPED - SALES ORDER NOT FOUND', shopifyOrderId);
                return;
            }

            log.audit('SALES ORDER FOUND', salesOrderId);

            var openedLines = openAllClosedLines(salesOrderId);

            log.audit('LINES OPENED BEFORE RETRY', JSON.stringify(openedLines));

            var retryResult = retryCeligoError(err);

            log.audit('CELIGO RETRY RESULT', JSON.stringify(retryResult));

            if (!retryResult.success || !retryResult.retryJobId) {
                log.error('RETRY NOT STARTED - LINES LEFT OPEN', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }));
                return;
            }

            var finalStatus = waitForRetryJob(retryResult.retryJobId);

            log.audit('FINAL RETRY JOB STATUS', JSON.stringify(finalStatus));

            if (finalStatus.success === true) {
                closeOnlyOpenedLines(salesOrderId, openedLines);

                log.audit('PROCESS COMPLETE SUCCESS', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    retryJobId: retryResult.retryJobId,
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    openedAndClosedLines: openedLines
                }));
            } else {
                log.error('RETRY NOT SUCCESSFUL YET - LINES LEFT OPEN', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    retryJobId: retryResult.retryJobId,
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    finalStatus: finalStatus
                }));
            }

        } catch (e) {
            log.error('map ERROR', e);
        }
    }

    function retryCeligoError(errorObj) {
        try {
            var retryDataKey = errorObj.retryDataKey;
            var errorId = errorObj.errorId || errorObj.id || errorObj._id;

            if (!retryDataKey) {
                return {
                    success: false,
                    message: 'Missing retryDataKey',
                    errorId: errorId
                };
            }

            var url = 'https://api.integrator.io/v1/flows/' + FLOW_ID + '/' + STEP_ID + '/retry';

            var payload = {
                retryDataKeys: [String(retryDataKey)]
            };

            log.audit('RETRY URL', url);
            log.audit('RETRY PAYLOAD', JSON.stringify(payload));

            var response = https.post({
                url: url,
                headers: getHeaders(),
                body: JSON.stringify(payload)
            });

            log.audit('RETRY RESPONSE CODE', response.code);
            log.debug('RETRY RESPONSE BODY', response.body);

            var body = {};
            try {
                body = JSON.parse(response.body || '{}');
            } catch (parseErr) {
                body = {};
            }

            return {
                success: response.code >= 200 && response.code < 300,
                code: response.code,
                body: response.body,
                retryJobId: body._id || ''
            };

        } catch (e) {
            log.error('retryCeligoError ERROR', e);
            return {
                success: false,
                message: e.message
            };
        }
    }

    function waitForRetryJob(retryJobId) {
        var waited = 0;

        while (waited < MAX_WAIT_SECONDS) {
            waitSeconds(WAIT_SECONDS);
            waited += WAIT_SECONDS;

            var status = getRetryJobStatus(retryJobId);

            log.audit('RETRY JOB CHECK AFTER ' + waited + ' SECONDS', JSON.stringify(status));

            if (status.success === true) {
                return status;
            }

            if (status.completed === true && status.success !== true) {
                return status;
            }
        }

        return {
            success: false,
            completed: false,
            message: 'Retry job not completed within ' + MAX_WAIT_SECONDS + ' seconds',
            retryJobId: retryJobId
        };
    }

    function getRetryJobStatus(retryJobId) {
        try {
            var url = 'https://api.integrator.io/v1/flowJobs/' + retryJobId;

            log.audit('RETRY JOB STATUS URL', url);

            var response = https.get({
                url: url,
                headers: getHeaders()
            });

            log.audit('RETRY JOB STATUS RESPONSE CODE', response.code);
            log.debug('RETRY JOB STATUS RESPONSE BODY', response.body);

            if (response.code < 200 || response.code >= 300) {
                return {
                    success: false,
                    completed: false,
                    code: response.code,
                    body: response.body,
                    retryJobId: retryJobId
                };
            }

            var body = JSON.parse(response.body || '{}');

            var status = body.status || '';
            var numSuccess = Number(body.numSuccess || 0);
            var numError = Number(body.numError || 0);
            var numOpenError = Number(body.numOpenError || 0);
            var doneExporting = body.doneExporting === true;

            var completed = false;
            var success = false;

            if (status == 'completed' || status == 'complete' || status == 'finished' || doneExporting === true) {
                completed = true;
            }

            if (completed && numSuccess > 0 && numError === 0 && numOpenError === 0) {
                success = true;
            }

            return {
                success: success,
                completed: completed,
                status: status,
                doneExporting: doneExporting,
                numSuccess: numSuccess,
                numError: numError,
                numOpenError: numOpenError,
                retryJobId: retryJobId,
                rawBody: body
            };

        } catch (e) {
            log.error('getRetryJobStatus ERROR', e);
            return {
                success: false,
                completed: false,
                message: e.message,
                retryJobId: retryJobId
            };
        }
    }

    function waitSeconds(seconds) {
        var endTime = new Date().getTime() + (seconds * 1000);

        while (new Date().getTime() < endTime) {
            // intentional wait
        }
    }

    function getShopifyOrderId(message, err) {
        var match = message.match(/Shopify order #(\d+)/);
        if (match && match[1]) return match[1];

        if (err.traceKey) return String(err.traceKey);
        if (err.record && err.record.id) return String(err.record.id);
        if (err.data && err.data.id) return String(err.data.id);

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
            columns: ['internalid', 'tranid']
        });

        var result = soSearch.run().getRange({
            start: 0,
            end: 1
        });

        if (result && result.length) {
            log.audit('SALES ORDER MATCHED', JSON.stringify({
                internalId: result[0].getValue('internalid'),
                tranid: result[0].getValue('tranid')
            }));

            return result[0].getValue('internalid');
        }

        return '';
    }

    function openAllClosedLines(salesOrderId) {
        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({
            sublistId: 'item'
        });

        var openedLines = [];

        for (var i = 0; i < lineCount; i++) {
            var isClosed = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'isclosed',
                line: i
            });

            var lineKey = soRec.getSublistValue({
                sublistId: 'item',
                fieldId: 'lineuniquekey',
                line: i
            });

            if (isClosed === true || isClosed === 'T') {
                openedLines.push(String(lineKey));

                soRec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: false
                });

                log.audit('OPENED LINE', lineKey);
            }
        }

        if (openedLines.length) {
            soRec.save({
                enableSourcing: true,
                ignoreMandatoryFields: true
            });

            log.audit('SALES ORDER SAVED AFTER OPENING LINES', salesOrderId);
        } else {
            log.audit('NO CLOSED LINES FOUND TO OPEN', salesOrderId);
        }

        return openedLines;
    }

    function closeOnlyOpenedLines(salesOrderId, openedLines) {
        if (!openedLines || !openedLines.length) {
            log.audit('NO LINES TO CLOSE BACK', salesOrderId);
            return;
        }

        var lineMap = {};

        for (var i = 0; i < openedLines.length; i++) {
            lineMap[String(openedLines[i])] = true;
        }

        var soRec = record.load({
            type: record.Type.SALES_ORDER,
            id: salesOrderId,
            isDynamic: false
        });

        var lineCount = soRec.getLineCount({
            sublistId: 'item'
        });

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

                log.audit('CLOSED LINE BACK', lineKey);
            }
        }

        soRec.save({
            enableSourcing: true,
            ignoreMandatoryFields: true
        });

        log.audit('SALES ORDER SAVED AFTER CLOSING LINES BACK', salesOrderId);
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
            log.error('MAP ERROR FOR KEY ' + key, error);
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