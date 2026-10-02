/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https','N/search','N/record','N/log'], (https, search, record, log) => {

    const CELIGO_TOKEN = '71043b5157f14d0980541cce2081edc3';
    const FLOW_ID = '69d94f8865d2a8beb0848e97';
    const STEP_ID = '69d94f8635b6551adf3a9f8c';

    const SHOPIFY_ORDER_ID = '7602934186047';
    const ERROR_TEXT = 'fulfillment process is already initiated/in progress';

    // VERIFY THESE 2 FIELD IDs BEFORE RUNNING
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

        return (body.errors || []).filter(e =>
            JSON.stringify(e).includes(SHOPIFY_ORDER_ID) &&
            JSON.stringify(e).includes(ERROR_TEXT)
        );
    };


    const map = context => {

        try {

            const err = JSON.parse(context.value);

            log.audit('MATCHED ERROR', {
                id: err._id || err.id,
                message: err.message
            });


            /*
             * FIND ORIGINAL FAILED SHOPIFY RECORD
             */
            let payload =
                err.retryData?.data ||
                err.retryData ||
                err.data ||
                err.record ||
                err.payload;


            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); } catch(e) {}
            }


            /*
             * IMPORTANT:
             * FIRST RUN IS SAFE.
             * If Celigo stores the payload somewhere else,
             * nothing in NetSuite is changed.
             */
            if (!payload || !Array.isArray(payload.line_items)) {

                log.error('PAYLOAD NOT FOUND', {
                    fullError: err
                });

                return;
            }


            const orderId = String(payload.id || '');

            if (orderId !== SHOPIFY_ORDER_ID) return;


            log.audit('PAYLOAD FOUND', {
                orderId,
                orderName: payload.name,
                status: payload.fulfillment_status,
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


            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            /*
             * SHOPIFY LINES BY ETAIL LINE ID
             */
            const shop = {};

            payload.line_items.forEach(x => {
                shop[String(x.id)] = x;
            });


            const existing = {};


            /*
             * CHECK EXISTING NETSUITE LINES
             *
             * IMPORTANT:
             * Blank eTail Line ID = NetSuite automation line.
             * NEVER TOUCH.
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


                // NETSUITE AUTOMATION ITEM - IGNORE COMPLETELY
                if (!lineId) continue;


                existing[lineId] = true;

                const s = shop[lineId];


                // Not part of current Shopify payload - leave it
                if (!s) continue;


                const item = so.getSublistText({
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
                 * current_quantity = 0
                 */
                if (Number(s.current_quantity) === 0) {

                    // NEVER REMOVE FULFILLED LINE
                    if (
                        fulfilled > 0 ||
                        s.fulfillment_status === 'fulfilled'
                    ) {

                        log.audit('SKIP REMOVAL - FULFILLED', {
                            item,
                            sku: s.sku,
                            lineId,
                            fulfilled
                        });

                        continue;
                    }


                    so.removeLine({
                        sublistId: 'item',
                        line: i
                    });


                    log.audit('REMOVED', {
                        item,
                        sku: s.sku,
                        lineId
                    });

                    continue;
                }


                /*
                 * ALREADY FULFILLED
                 * RESERVATION ITEM WILL COME HERE
                 */
                if (
                    fulfilled > 0 ||
                    s.fulfillment_status === 'fulfilled'
                ) {

                    log.audit('SKIP FULFILLED', {
                        item,
                        sku: s.sku,
                        lineId,
                        fulfilled
                    });

                    continue;
                }


                /*
                 * UPDATE QUANTITY
                 */
                if (qty !== Number(s.current_quantity)) {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i,
                        value: Number(s.current_quantity)
                    });


                    log.audit('QUANTITY UPDATED', {
                        item,
                        sku: s.sku,
                        oldQty: qty,
                        newQty: s.current_quantity
                    });
                }
            }


            /*
             * ADD NEW SHOPIFY ITEMS
             */
            payload.line_items.forEach(s => {

                const lineId = String(s.id);


                if (
                    existing[lineId] ||
                    Number(s.current_quantity) <= 0 ||
                    s.fulfillment_status === 'fulfilled'
                ) return;


                let itemId;


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
                        lineId
                    });

                    return;
                }


                const line = so.getLineCount({
                    sublistId: 'item'
                });


                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line,
                    value: Number(itemId)
                });


                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'quantity',
                    line,
                    value: Number(s.current_quantity)
                });


                so.setSublistValue({
                    sublistId: 'item',
                    fieldId: LINE_ID_FIELD,
                    line,
                    value: lineId
                });


                /*
                 * CUSTOM PRICE FROM SHOPIFY
                 */
                if (
                    s.price !== undefined &&
                    s.price !== null
                ) {

                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'price',
                        line,
                        value: -1
                    });


                    so.setSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line,
                        value: Number(s.price)
                    });
                }


                log.audit('ADDED', {
                    sku: s.sku,
                    itemId,
                    lineId,
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
    };


    return {
        getInputData,
        map,
        summarize
    };
});
