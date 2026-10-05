/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/search', 'N/record', 'N/log'],
(https, search, record, log) => {

    const CELIGO_TOKEN = 'PASTE_YOUR_CELIGO_TOKEN_HERE';

    // SANDBOX
    const FLOW_ID = '69d94f8865d2a8beb0848e97';
    const STEP_ID = '69d94f8635b6551adf3a9f8c';

    // NETSUITE FIELDS
    const ORDER_ID_FIELD = 'custbody_celigo_etail_order_id';
    const LINE_ID_FIELD = 'custcol_celigo_etail_order_line_id';
    const TYPE_FIELD = 'custcol_item_parentcomp';
    const PARENT_FIELD = 'custcol_parent_item';

    const TYPE_PARENT = '1';
    const TYPE_FILLER = '5';


    const getInputData = () => {

        const res = https.get({
            url: `https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/errors`,
            headers: {
                Authorization: `Bearer ${CELIGO_TOKEN}`,
                Accept: 'application/json'
            }
        });

        if (Number(res.code) !== 200)
            throw `Celigo API Error ${res.code}: ${res.body}`;

        const body = JSON.parse(res.body);
        const errors = body.errors || [];


        const matched = errors.filter(e => {

            const source = String(e.source || '');
            const code = String(e.code || '');
            const msg = String(e.message || '').toLowerCase();

            const sourceMatch =
                source === 'post_submit_hook_ss';

            const codeMatch =
                code === 'cannot_update_lines' ||
                code === 'user_error';

            const messageMatch =
                msg.includes('items on this line have been fulfilled') ||
                msg.includes('fulfillment process is already initiated/in progress');

            return sourceMatch && codeMatch && messageMatch;
        });


        log.audit('DRY RUN - ERROR SUMMARY', {
            totalCeligoErrors: errors.length,
            matchingErrors: matched.length
        });


        return matched;
    };


    const map = context => {

        try {

            const err = JSON.parse(context.value);

            const source = String(err.source || '');
            const code = String(err.code || '');
            const msg = String(err.message || '').toLowerCase();


            // SECOND SAFETY CHECK
            if (
                source !== 'post_submit_hook_ss' ||
                !(
                    code === 'cannot_update_lines' ||
                    code === 'user_error'
                ) ||
                !(
                    msg.includes('items on this line have been fulfilled') ||
                    msg.includes('fulfillment process is already initiated/in progress')
                )
            ) return;


            log.audit('DRY RUN - PROCESSING ERROR', {
                errorId: err.errorId,
                traceKey: err.traceKey,
                code: err.code,
                retryDataKey: err.retryDataKey,
                message: err.message
            });


            if (!err.retryDataKey) {
                log.error('DRY RUN - NO RETRY DATA KEY', err);
                return;
            }


            /*
             * GET CELIGO RETRY PAYLOAD
             */
            const retryRes = https.get({
                url: `https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/${err.retryDataKey}/data`,
                headers: {
                    Authorization: `Bearer ${CELIGO_TOKEN}`,
                    Accept: 'application/json'
                }
            });


            if (Number(retryRes.code) !== 200) {
                log.error('DRY RUN - RETRY DATA ERROR', {
                    code: retryRes.code,
                    body: retryRes.body
                });
                return;
            }


            const retryBody = JSON.parse(retryRes.body);

            let payload = retryBody.data || retryBody;


            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {
                    log.error('DRY RUN - INVALID PAYLOAD', payload);
                    return;
                }
            }


            if (
                payload &&
                !Array.isArray(payload.line_items) &&
                payload.record
            ) {
                payload = payload.record;
            }


            if (!payload || !Array.isArray(payload.line_items)) {
                log.error('DRY RUN - SHOPIFY PAYLOAD NOT FOUND', {
                    errorId: err.errorId
                });
                return;
            }


            const orderId = String(payload.id || '');


            if (!orderId) {
                log.error('DRY RUN - SHOPIFY ORDER ID MISSING', {
                    errorId: err.errorId
                });
                return;
            }


            /*
             * FIND EXISTING NETSUITE SO
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

                log.audit('DRY RUN - SKIP NO EXISTING SO', {
                    shopifyOrderId: orderId
                });

                return;
            }


            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: soId,
                isDynamic: false
            });


            const shop = {};

            payload.line_items.forEach(s => {
                shop[String(s.id)] = s;
            });


            const existing = {};

            let removeCount = 0;
            let fillerRemoveCount = 0;
            let addCount = 0;
            let updateCount = 0;
            let fulfilledSkipCount = 0;
            let automationSkipCount = 0;
            let missingItemCount = 0;


            /*
             * CHECK EXISTING NETSUITE LINES
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
                 * NETSUITE AUTOMATION LINE
                 * IGNORE, EXCEPT FILLER CHECK BELOW
                 */
                if (!lineId) {
                    automationSkipCount++;
                    continue;
                }


                existing[lineId] = true;

                const s = shop[lineId];

                if (!s) continue;


                const itemId = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    }) || ''
                );


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


                const lineType = String(
                    so.getSublistValue({
                        sublistId: 'item',
                        fieldId: TYPE_FIELD,
                        line: i
                    }) || ''
                );


                /*
                 * SHOPIFY REMOVED ITEM
                 */
                if (Number(s.current_quantity) === 0) {


                    if (
                        fulfilled > 0 ||
                        s.fulfillment_status === 'fulfilled'
                    ) {

                        fulfilledSkipCount++;


                        log.audit('DRY RUN - WOULD SKIP FULFILLED REMOVAL', {
                            salesOrderId: soId,
                            item: itemText,
                            sku: s.sku,
                            lineId: lineId,
                            fulfilled: fulfilled
                        });

                        continue;
                    }


                    /*
                     * IF REMOVED ITEM IS PARENT,
                     * FIND RELATED FILLER
                     */
                    if (lineType === TYPE_PARENT) {

                        for (
                            let f = so.getLineCount({ sublistId: 'item' }) - 1;
                            f >= 0;
                            f--
                        ) {

                            if (f === i) continue;


                            const fillerType = String(
                                so.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: TYPE_FIELD,
                                    line: f
                                }) || ''
                            );


                            const fillerParent = String(
                                so.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: PARENT_FIELD,
                                    line: f
                                }) || ''
                            );


                            const fillerQty = Number(
                                so.getSublistValue({
                                    sublistId: 'item',
                                    fieldId: 'quantity',
                                    line: f
                                }) || 0
                            );


                            if (
                                fillerType === TYPE_FILLER &&
                                fillerParent === itemId &&
                                fillerQty === qty
                            ) {

                                const fillerItem = so.getSublistText({
                                    sublistId: 'item',
                                    fieldId: 'item',
                                    line: f
                                });


                                const fillerFulfilled = Number(
                                    so.getSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'quantityfulfilled',
                                        line: f
                                    }) || 0
                                );


                                if (fillerFulfilled > 0) {

                                    log.audit('DRY RUN - WOULD SKIP FULFILLED FILLER', {
                                        salesOrderId: soId,
                                        parent: itemText,
                                        filler: fillerItem
                                    });

                                    continue;
                                }


                                fillerRemoveCount++;


                                log.audit('DRY RUN - WOULD REMOVE FILLER', {
                                    salesOrderId: soId,
                                    parent: itemText,
                                    parentItemId: itemId,
                                    filler: fillerItem,
                                    quantity: fillerQty
                                });
                            }
                        }
                    }


                    removeCount++;


                    log.audit('DRY RUN - WOULD REMOVE', {
                        salesOrderId: soId,
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId,
                        type: lineType,
                        quantity: qty
                    });


                    continue;
                }


                /*
                 * DO NOT MODIFY FULFILLED LINES
                 */
                if (
                    fulfilled > 0 ||
                    s.fulfillment_status === 'fulfilled'
                ) {

                    fulfilledSkipCount++;


                    log.audit('DRY RUN - WOULD SKIP FULFILLED', {
                        salesOrderId: soId,
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId,
                        fulfilled: fulfilled
                    });

                    continue;
                }


                /*
                 * WOULD UPDATE QUANTITY
                 */
                const shopQty = Number(s.current_quantity);


                if (qty !== shopQty) {

                    updateCount++;


                    log.audit('DRY RUN - WOULD UPDATE QTY', {
                        salesOrderId: soId,
                        item: itemText,
                        sku: s.sku,
                        lineId: lineId,
                        netSuiteQty: qty,
                        shopifyQty: shopQty
                    });
                }
            }


            /*
             * CHECK NEW SHOPIFY ITEMS
             */
            payload.line_items.forEach(s => {

                const lineId = String(s.id || '');


                if (existing[lineId]) return;

                if (Number(s.current_quantity) <= 0) return;

                if (s.fulfillment_status === 'fulfilled') return;


                if (!s.sku) {

                    missingItemCount++;


                    log.error('DRY RUN - NEW ITEM HAS NO SKU', {
                        salesOrderId: soId,
                        lineId: lineId,
                        item: s.name
                    });

                    return;
                }


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

                    missingItemCount++;


                    log.error('DRY RUN - ITEM NOT FOUND', {
                        salesOrderId: soId,
                        sku: s.sku,
                        lineId: lineId
                    });

                    return;
                }


                addCount++;


                log.audit('DRY RUN - WOULD ADD', {
                    salesOrderId: soId,
                    item: s.name,
                    sku: s.sku,
                    itemId: itemId,
                    lineId: lineId,
                    quantity: s.current_quantity,
                    rate: s.price
                });
            });


            /*
             * ORDER LEVEL SUMMARY
             */
            log.audit('DRY RUN - ORDER SUMMARY', {
                shopifyOrderId: orderId,
                salesOrderId: soId,

                needsChange:
                    removeCount > 0 ||
                    fillerRemoveCount > 0 ||
                    addCount > 0 ||
                    updateCount > 0,

                wouldRemove: removeCount,
                wouldRemoveFillers: fillerRemoveCount,
                wouldAdd: addCount,
                wouldUpdateQty: updateCount,

                fulfilledLinesSkipped: fulfilledSkipCount,
                automationLinesSkipped: automationSkipCount,
                missingItems: missingItemCount,

                recordSaved: false
            });


            /*
             * DRY RUN ONLY
             *
             * NO removeLine()
             * NO setSublistValue()
             * NO save()
             */

        } catch (e) {

            log.error('DRY RUN - MAP ERROR', {
                name: e.name,
                message: e.message || String(e),
                stack: e.stack
            });
        }
    };


    const summarize = summary => {

        log.audit('DRY RUN - COMPLETE', {
            usage: summary.usage,
            yields: summary.yields,
            concurrency: summary.concurrency,
            salesOrdersChanged: 0
        });


        summary.mapSummary.errors.iterator().each((key, error) => {

            log.error('DRY RUN - SUMMARY ERROR', {
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