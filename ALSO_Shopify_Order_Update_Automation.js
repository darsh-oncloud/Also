/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'],
(https, search, record, log) => {

    const CELIGO_TOKEN = '71043b5157f14d0980541cce2081edc3';

    const FLOW_ID = '68e819893fe2e005c7712f48';
    const STEP_ID = '68e8197b53e4a108b091452c';

    // ONLY THIS ORDER / ERROR FOR PROD TEST
    const SHOPIFY_ORDER_ID = '6664684142816';
    const ERROR_TEXT = 'Items on this line have been fulfilled';

    // VERIFY THESE ARE CORRECT IN PROD
    const ORDER_ID_FIELD = 'custbody_celigo_etail_order_id';
    const LINE_ID_FIELD = 'custcol_celigo_etail_order_line_id';


    const getInputData = () => {

        const res = https.get({
            url: `https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/errors`,
            headers: {
                Authorization: `Bearer ${CELIGO_TOKEN}`,
                Accept: 'application/json'
            }
        });

        log.audit('CELIGO RESPONSE', {
            code: res.code,
            body: res.body
        });

        if (Number(res.code) !== 200)
            throw `Celigo API Error ${res.code}: ${res.body}`;

        const body = JSON.parse(res.body);
        const errors = body.errors || [];

        const matched = errors.filter(e => {
            const raw = JSON.stringify(e);

            return raw.includes(SHOPIFY_ORDER_ID) &&
                   raw.includes(ERROR_TEXT);
        });

        log.audit('MATCHED TEST ERROR', {
            count: matched.length,
            error: matched[0] || 'NONE'
        });

        // ONLY PROCESS ONE ERROR
        return matched.slice(0, 1);
    };


    const map = context => {

        try {

            const err = JSON.parse(context.value);
            const raw = JSON.stringify(err);


            /*
             * SECOND SAFETY CHECK
             */
            if (
                !raw.includes(SHOPIFY_ORDER_ID) ||
                !raw.includes(ERROR_TEXT)
            ) {
                log.audit('SKIPPED', 'Not the hardcoded production test error');
                return;
            }


            log.audit('MATCHED ERROR', {
                errorId: err.errorId,
                retryDataKey: err.retryDataKey,
                traceKey: err.traceKey,
                message: err.message
            });


            /*
             * GET RETRY DATA KEY FROM CELIGO ERROR
             */
            const retryDataKey = err.retryDataKey;


            if (!retryDataKey) {
                log.error('NO RETRY DATA KEY', err);
                return;
            }


            /*
             * GET ACTUAL FAILED SHOPIFY PAYLOAD
             */
            const retryRes = https.get({
                url: `https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/${retryDataKey}/data`,
                headers: {
                    Authorization: `Bearer ${CELIGO_TOKEN}`,
                    Accept: 'application/json'
                }
            });


            log.audit('RETRY DATA RESPONSE', {
                code: retryRes.code,
                body: retryRes.body
            });


            if (Number(retryRes.code) !== 200) {
                log.error('RETRY DATA API ERROR', {
                    code: retryRes.code,
                    body: retryRes.body
                });
                return;
            }


            /*
             * CELIGO RESPONSE:
             *
             * {
             *    data: { SHOPIFY PAYLOAD },
             *    stage: "...",
             *    traceKey: "..."
             * }
             */
            const retryBody = JSON.parse(retryRes.body);

            let payload = retryBody.data || retryBody;


            /*
             * SOMETIMES DATA MAY BE STRINGIFIED
             */
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {
                    log.error('INVALID PAYLOAD JSON', payload);
                    return;
                }
            }


            /*
             * SOME CELIGO PAYLOADS CAN HAVE RECORD WRAPPER
             */
            if (
                payload &&
                !Array.isArray(payload.line_items) &&
                payload.record
            ) {
                payload = payload.record;
            }


            /*
             * SAFETY - DO NOT TOUCH NETSUITE
             * UNLESS SHOPIFY LINE ITEMS ARE FOUND
             */
            if (!payload || !Array.isArray(payload.line_items)) {

                log.error('SHOPIFY PAYLOAD NOT FOUND', {
                    retryDataKey: retryDataKey,
                    retryBody: retryBody
                });

                return;
            }


            const orderId = String(payload.id || '');


            /*
             * MAKE SURE IT IS OUR TEST ORDER
             */
            if (orderId !== SHOPIFY_ORDER_ID) {

                log.audit('SKIPPED ORDER', {
                    expected: SHOPIFY_ORDER_ID,
                    received: orderId
                });

                return;
            }


            log.audit('PAYLOAD FOUND', {
                orderId: orderId,
                orderName: payload.name,
                fulfillmentStatus: payload.fulfillment_status,
                lineCount: payload.line_items.length
            });


            /*
             * FIND NETSUITE SALES ORDER
             */
            let soId;


            search.create({
                type: search.Type.SALES_ORDER,
                filters: [
                    [ORDER_ID_FIELD, 'is', orderId],
                    'AND',
                    ['mainline', 'is', 'T']
                ],
                columns: ['internalid']
            }).run().each(r => {
                soId = r.id;
                return false;
            });


            if (!soId) {

                log.error('SALES ORDER NOT FOUND', {
                    shopifyOrderId: orderId
                });

                return;
            }


            log.audit('SALES ORDER FOUND', {
                salesOrderId: soId,
                shopifyOrderId: orderId
            });


            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            /*
             * SHOPIFY LINE MAP
             *
             * Shopify line_items[].id
             * =
             * NetSuite eTail Order Line ID
             */
            const shop = {};

            payload.line_items.forEach(x => {
                shop[String(x.id)] = x;
            });


            const existing = {};


            /*
             * CHECK CURRENT NETSUITE LINES
             *
             * BACKWARDS BECAUSE LINES MAY BE REMOVED
             */
            for (
                let i = so.getLineCount({ sublistId: 'item' }) - 1;
                i >= 0;
                i--
            ) {

                const lineId = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: LINE_ID_FIELD,
                        line: i
                    }) || ''
                );


                /*
                 * BLANK ETAIL LINE ID
                 *
                 * CREATED BY NETSUITE AUTOMATION
                 * DO NOT TOUCH
                 */
                if (!lineId) {

                    log.debug('SKIP NETSUITE AUTOMATION LINE', {
                        line: i
                    });

                    continue;
                }


                existing[lineId] = true;

                const s = shop[lineId];


                /*
                 * NOT PRESENT IN SHOPIFY PAYLOAD
                 * LEAVE IT ALONE
                 */
                if (!s) {

                    log.debug('SHOPIFY LINE NOT FOUND - KEEP', {
                        lineId: lineId
                    });

                    continue;
                }


                const itemText = so.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });


                const qty = Number(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    }) || 0
                );


                const fulfilled = Number(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantityfulfilled',
                        line: i
                    }) || 0
                );


                /*
                 * SHOPIFY REMOVED ITEM
                 *
                 * current_quantity = 0
                 */
                if (Number(s.current_quantity) === 0) {


                    /*
                     * NEVER REMOVE ALREADY FULFILLED ITEM
                     */
                    if (
                        fulfilled > 0 ||
                        s.fulfillment_status === 'fulfilled'
                    ) {

                        log.audit('SKIP REMOVAL - FULFILLED', {
                            item: itemText,
                            sku: s.sku,
                            lineId: lineId,
                            fulfilled: fulfilled
                        });

                        continue;
                    }


                    so.removeLine({
                        sublistId: 'item',
                        line: i
                    });


                    log.audit('REMOVED', {
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId
                    });


                    continue;
                }


                /*
                 * EXISTING FULFILLED LINE
                 *
                 * DO NOT TOUCH ITEM / QTY / PRICE
                 */
                if (
                    fulfilled > 0 ||
                    s.fulfillment_status === 'fulfilled'
                ) {

                    log.audit('SKIP FULFILLED', {
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId,
                        fulfilled: fulfilled
                    });

                    continue;
                }


                /*
                 * UPDATE QUANTITY
                 */
                const shopQty = Number(s.current_quantity);


                if (qty !== shopQty) {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i,
                        value: shopQty
                    });


                    log.audit('QUANTITY UPDATED', {
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId,
                        oldQty: qty,
                        newQty: shopQty
                    });
                }
            }


            /*
             * ADD NEW SHOPIFY ITEMS
             */
            payload.line_items.forEach(s => {

                const lineId = String(s.id || '');


                /*
                 * ALREADY EXISTS IN NETSUITE
                 */
                if (existing[lineId]) return;


                /*
                 * REMOVED SHOPIFY LINE
                 */
                if (Number(s.current_quantity) <= 0) return;


                /*
                 * ALREADY FULFILLED SHOPIFY LINE
                 */
                if (s.fulfillment_status === 'fulfilled') return;


                /*
                 * SKU REQUIRED
                 */
                if (!s.sku) {

                    log.error('NEW ITEM HAS NO SKU', {
                        lineId: lineId,
                        item: s
                    });

                    return;
                }


                let itemId;


                /*
                 * FIND NETSUITE ITEM BY SKU
                 */
                search.create({
                    type: search.Type.ITEM,
                    filters: [
                        ['itemid', 'is', s.sku],
                        'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: ['internalid']
                }).run().each(r => {
                    itemId = r.id;
                    return false;
                });


                if (!itemId) {

                    log.error('ITEM NOT FOUND', {
                        sku: s.sku,
                        lineId: lineId
                    });

                    return;
                }


                const line = so.getLineCount({
                    sublistId: 'item'
                });


                /*
                 * ADD ITEM
                 */
                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: line,
                    value: Number(itemId)
                });


                /*
                 * ADD QUANTITY
                 */
                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line: line,
                    value: Number(s.current_quantity)
                });


                /*
                 * ADD ETAIL / SHOPIFY LINE ID
                 */
                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: LINE_ID_FIELD,
                    line: line,
                    value: lineId
                });


                /*
                 * SET SHOPIFY PRICE
                 */
                if (
                    s.price !== undefined &&
                    s.price !== null &&
                    s.price !== ''
                ) {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'price',
                        line: line,
                        value: -1
                    });


                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line: line,
                        value: Number(s.price)
                    });
                }


                log.audit('ADDED', {
                    item: s.name,
                    sku: s.sku,
                    itemId: itemId,
                    lineId: lineId,
                    quantity: s.current_quantity,
                    rate: s.price
                });
            });


            /*
             * SAVE SALES ORDER
             */
            const savedId = so.save({
                enableSourcing: true,
                ignoreMandatoryFields: false
            });


            log.audit('SALES ORDER UPDATED', {
                salesOrderId: savedId,
                shopifyOrderId: orderId,
                errorId: err.errorId,
                retryDataKey: retryDataKey
            });


        } catch (e) {

            log.error('MAP ERROR', {
                name: e.name,
                message: e.message || String(e),
                stack: e.stack
            });
        }
    };


    const summarize = summary => {

        log.audit('SUMMARY', {
            usage: summary.usage,
            yields: summary.yields,
            concurrency: summary.concurrency
        });


        summary.mapSummary.errors.iterator().each((key, error) => {

            log.error('MAP SUMMARY ERROR', {
                key: key,
                error: error
            });

            return true;
        });
    };


    return {
        getInputData,
        map,
        summarize
    };

});