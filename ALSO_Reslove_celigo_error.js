/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'], function (https, search, record, log) {

    var CELIGO_API_TOKEN = '511e8201ff034b16bb3aa6b64413246a';

    var FLOW_ID = '68e819893fe2e005c7712f48';
    var STEP_ID = '68e8197b53e4a108b091452c';

    var SHOPIFY_ORDER_FIELD = 'custbody_celigo_etail_order_id';

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

                log.debug('CHECKING ERROR', JSON.stringify({
                    errorId: err.errorId || err.id || err._id,
                    retryDataKey: err.retryDataKey,
                    code: code,
                    message: msg
                }));

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

            log.audit('SHOPIFY ORDER ID FOUND', shopifyOrderId);

            if (!shopifyOrderId) {
                log.error('STOPPED - ORDER ID NOT FOUND FROM ERROR', JSON.stringify(err));
                return;
            }

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

            if (retryResult.success) {
                closeOnlyOpenedLines(salesOrderId, openedLines);

                log.audit('PROCESS COMPLETE SUCCESS', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    openedAndClosedLines: openedLines
                }));
            } else {
                log.error('RETRY FAILED - LINES LEFT OPEN', JSON.stringify({
                    errorId: errorId,
                    retryDataKey: retryDataKey,
                    shopifyOrderId: shopifyOrderId,
                    salesOrderId: salesOrderId,
                    openedLines: openedLines,
                    retryResult: retryResult
                }));
            }

        } catch (e) {
            log.error('map ERROR', e);
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

        var result = soSearch.run().getRange({ start: 0, end: 1 });

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

        var lineCount = soRec.getLineCount({ sublistId: 'item' });
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

            return {
                success: response.code >= 200 && response.code < 300,
                code: response.code,
                body: response.body
            };

        } catch (e) {
            log.error('retryCeligoError ERROR', e);
            return {
                success: false,
                message: e.message
            };
        }
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