/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'],
(https, search, record, log) => {

    const CELIGO_TOKEN = 'PASTE_YOUR_CELIGO_TOKEN_HERE';

    const FLOW_ID = '68e819893fe2e005c7712f48';
    const STEP_ID = '68e8197b53e4a108b091452c';

    const SHOPIFY_ORDER_ID = '6664684142816';
    const ERROR_TEXT = 'Items on this line have been fulfilled';

    // VERIFY THESE 2 FIELD IDS IN PROD
    const ORDER_ID_FIELD = 'custbody_celigo_etail_order_id';
    const LINE_ID_FIELD  = 'custcol_celigo_etail_order_line_id';


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

        // ONLY ONE ERROR
        return matched.slice(0, 1);
    };


    const map = context => {

        try {

            const err = JSON.parse(context.value);
            const raw = JSON.stringify(err);


            // SECOND SAFETY CHECK
            if (
                !raw.includes(SHOPIFY_ORDER_ID) ||
                !raw.includes(ERROR_TEXT)
            ) {
                log.audit('SKIPPED', 'Not the hardcoded production test error');
                return;
            }


            log.audit('MATCHED ERROR', {
                id: err._id || err.id,
                message: err.message
            });


            /*
             * GET ORIGINAL FAILED SHOPIFY PAYLOAD
             */
            let payload =
                err.retryData?.data ||
                err.retryData ||
                err.data ||
                err.record ||
                err.payload;


            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {}
            }


            /*
             * IF CELIGO PAYLOAD STRUCTURE IS DIFFERENT,
             * DO NOT TOUCH NETSUITE.
             */
            if (!payload || !Array.isArray(payload.line_items)) {

                log.error('PAYLOAD NOT FOUND', {
                    fullError: err
                });

                return;
            }


            const orderId = String(payload.id || '');


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
             * BUILD SHOPIFY LINE MAP
             *
             * Shopify Line ID
             * =
             * NetSuite eTail Order Line ID
             */
            const shop = {};

            payload.line_items.forEach(x => {
                shop[String(x.id)] = x;
            });


            const existing = {};


            /*
             * CHECK NETSUITE EXISTING LINES
             *
             * LOOP BACKWARDS BECAUSE WE MAY REMOVE LINES.
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
                 * NETSUITE AUTOMATION ITEM.
                 * NEVER TOUCH.
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
                 * NOT PRESENT IN PAYLOAD
                 *
                 * DO NOT BLINDLY REMOVE.
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
                 * SHOPIFY REMOVED LINE
                 *
                 * current_quantity = 0
                 */
                if (Number(s.current_quantity) === 0) {


                    /*
                     * NEVER REMOVE FULFILLED LINE
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
                 * ALREADY FULFILLED
                 *
                 * DO NOT CHANGE QTY / ITEM / PRICE.
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
             * ADD NEW SHOPIFY LINES
             */
            payload.line_items.forEach(s => {

                const lineId = String(s.id || '');


                /*
                 * ALREADY EXISTS
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


                let itemId;


                /*
                 * FIND NETSUITE ITEM USING SKU
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
                 * ADD SHOPIFY / ETAIL LINE ID
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
                    s.price !== null
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
                celigoErrorId: err._id || err.id
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