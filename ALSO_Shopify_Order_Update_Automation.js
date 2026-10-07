/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https','N/search','N/record','N/log'], (https,search,record,log) => {

    const CELIGO_TOKEN = '71043b5157f14d0980541cce2081edc3';
    const FLOW_ID = '68e819893fe2e005c7712f48';
    const STEP_ID = '68e8197b53e4a108b091452c';

    const ORDER_ID_FIELD = 'custbody_celigo_etail_order_id';
    const LINE_ID_FIELD = 'custcol_celigo_etail_order_line_id';
    const TYPE_FIELD = 'custcol_item_parentcomp';
    const PARENT_FIELD = 'custcol_parent_item';

    const TYPE_PARENT = '1', TYPE_FILLER = '5';

    const getInputData = () => {
        const res = https.get({
            url:`https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/errors`,
            headers:{Authorization:`Bearer ${CELIGO_TOKEN}`,Accept:'application/json'}
        });

        if (+res.code !== 200) throw `Celigo API Error ${res.code}: ${res.body}`;

        const errors = JSON.parse(res.body).errors || [];
        const matched = errors.filter(e => {
            const source = String(e.source || ''), code = String(e.code || ''), msg = String(e.message || '').toLowerCase();
            return source === 'post_submit_hook_ss' &&
                (code === 'cannot_update_lines' || code === 'user_error') &&
                (msg.includes('items on this line have been fulfilled') ||
                 msg.includes('fulfillment process is already initiated/in progress'));
        });

        const seen = {};
        const unique = matched.filter(e => {
            const key = String(e.traceKey || e.retryDataKey || e.errorId);
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });

        log.audit('CELIGO ERROR SUMMARY',{totalOpenErrors:errors.length,matchingErrors:matched.length,ordersToProcess:unique.length});
        return unique;
    };

    const map = context => {
        try {
            const err = JSON.parse(context.value);
            const source = String(err.source || ''), code = String(err.code || ''), msg = String(err.message || '').toLowerCase();

            if (
                source !== 'post_submit_hook_ss' ||
                !(code === 'cannot_update_lines' || code === 'user_error') ||
                !(msg.includes('items on this line have been fulfilled') ||
                  msg.includes('fulfillment process is already initiated/in progress'))
            ) return;

            log.audit('PROCESSING CELIGO ERROR',{
                errorId:err.errorId,traceKey:err.traceKey,retryDataKey:err.retryDataKey,code:err.code
            });

            if (!err.retryDataKey || !err.errorId) {
                log.error('MISSING CELIGO ERROR DATA',{errorId:err.errorId,retryDataKey:err.retryDataKey});
                return;
            }

            const retryRes = https.get({
                url:`https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/${err.retryDataKey}/data`,
                headers:{Authorization:`Bearer ${CELIGO_TOKEN}`,Accept:'application/json'}
            });

            if (+retryRes.code !== 200) {
                log.error('RETRY DATA ERROR',{code:retryRes.code,body:retryRes.body});
                return;
            }

            const retryBody = JSON.parse(retryRes.body);
            let payload = retryBody.data || retryBody;

            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); }
                catch(e) { log.error('INVALID SHOPIFY PAYLOAD',payload); return; }
            }

            if (payload && !Array.isArray(payload.line_items) && payload.record) payload = payload.record;

            if (!payload || !Array.isArray(payload.line_items)) {
                log.error('SHOPIFY PAYLOAD NOT FOUND',{errorId:err.errorId});
                return;
            }

            const orderId = String(payload.id || '');
            if (!orderId) {
                log.error('SHOPIFY ORDER ID MISSING',{errorId:err.errorId});
                return;
            }

            let soId;
            search.create({
                type:search.Type.SALES_ORDER,
                filters:[[ORDER_ID_FIELD,'is',orderId],'AND',['mainline','is','T']],
                columns:['internalid']
            }).run().each(r => { soId = r.id; return false; });

            if (!soId) {
                log.error('EXISTING SALES ORDER NOT FOUND',{shopifyOrderId:orderId});
                return;
            }

            const so = record.load({type:record.Type.SALES_ORDER,id:soId,isDynamic:false});
            const shop = {};
            payload.line_items.forEach(s => shop[String(s.id)] = s);

            const existing = {};
            let changed = false, blocked = false;
            let removeCount = 0, fillerRemoveCount = 0, addCount = 0, updateCount = 0, fulfilledSkipCount = 0;

            for (let i = so.getLineCount({sublistId:'item'}) - 1; i >= 0; i--) {

                const lineId = String(so.getSublistValue({sublistId:'item',fieldId:LINE_ID_FIELD,line:i}) || '');
                if (!lineId) continue;

                existing[lineId] = true;
                const s = shop[lineId];
                if (!s) continue;

                const itemId = String(so.getSublistValue({sublistId:'item',fieldId:'item',line:i}) || '');
                const itemText = so.getSublistText({sublistId:'item',fieldId:'item',line:i});
                const qty = +(so.getSublistValue({sublistId:'item',fieldId:'quantity',line:i}) || 0);
                const fulfilled = +(so.getSublistValue({sublistId:'item',fieldId:'quantityfulfilled',line:i}) || 0);
                const lineType = String(so.getSublistValue({sublistId:'item',fieldId:TYPE_FIELD,line:i}) || '');

                if (+s.current_quantity === 0) {

                    if (fulfilled > 0 || s.fulfillment_status === 'fulfilled') {
                        fulfilledSkipCount++;
                        log.audit('SKIP FULFILLED REMOVAL',{salesOrderId:soId,item:itemText,sku:s.sku,lineId,fulfilled});
                        continue;
                    }

                    if (lineType === TYPE_PARENT) {
                        let fillerBlocked = false;

                        for (let f = so.getLineCount({sublistId:'item'}) - 1; f >= 0; f--) {
                            if (f === i) continue;

                            const fillerType = String(so.getSublistValue({sublistId:'item',fieldId:TYPE_FIELD,line:f}) || '');
                            const fillerParent = String(so.getSublistValue({sublistId:'item',fieldId:PARENT_FIELD,line:f}) || '');
                            const fillerQty = +(so.getSublistValue({sublistId:'item',fieldId:'quantity',line:f}) || 0);

                            if (fillerType === TYPE_FILLER && fillerParent === itemId && fillerQty === qty) {
                                const fillerText = so.getSublistText({sublistId:'item',fieldId:'item',line:f});
                                const fillerFulfilled = +(so.getSublistValue({sublistId:'item',fieldId:'quantityfulfilled',line:f}) || 0);

                                if (fillerFulfilled > 0) {
                                    fillerBlocked = blocked = true;
                                    log.error('PARENT REMOVAL BLOCKED - FILLER FULFILLED',{
                                        parent:itemText,filler:fillerText,fillerFulfilled
                                    });
                                    continue;
                                }

                                so.removeLine({sublistId:'item',line:f});
                                fillerRemoveCount++;
                                changed = true;
                                log.audit('FILLER REMOVED',{parent:itemText,filler:fillerText,quantity:fillerQty});
                                if (f < i) i--;
                            }
                        }

                        if (fillerBlocked) continue;
                    }

                    so.removeLine({sublistId:'item',line:i});
                    removeCount++;
                    changed = true;
                    log.audit('ITEM REMOVED',{item:itemText,sku:s.sku,lineId,type:lineType});
                    continue;
                }

                if (fulfilled > 0 || s.fulfillment_status === 'fulfilled') {
                    fulfilledSkipCount++;
                    log.audit('SKIP FULFILLED',{item:itemText,sku:s.sku,lineId,fulfilled});
                    continue;
                }

                const shopQty = +s.current_quantity;

                if (qty !== shopQty) {
                    so.setSublistValue({sublistId:'item',fieldId:'quantity',line:i,value:shopQty});
                    updateCount++;
                    changed = true;
                    log.audit('QUANTITY UPDATED',{item:itemText,sku:s.sku,oldQty:qty,newQty:shopQty});
                }
            }

            payload.line_items.forEach(s => {
                const lineId = String(s.id || '');

                if (existing[lineId] || +s.current_quantity <= 0 || s.fulfillment_status === 'fulfilled') return;

                if (!s.sku) {
                    blocked = true;
                    log.error('NEW SHOPIFY ITEM HAS NO SKU',{name:s.name,lineId});
                    return;
                }

                let itemId;
                search.create({
                    type:search.Type.ITEM,
                    filters:[['itemid','is',s.sku],'AND',['isinactive','is','F']],
                    columns:['internalid']
                }).run().each(r => { itemId = r.id; return false; });

                if (!itemId) {
                    blocked = true;
                    log.error('NETSUITE ITEM NOT FOUND',{sku:s.sku,lineId});
                    return;
                }

                const line = so.getLineCount({sublistId:'item'});

                so.setSublistValue({sublistId:'item',fieldId:'item',line,value:+itemId});
                so.setSublistValue({sublistId:'item',fieldId:'quantity',line,value:+s.current_quantity});
                so.setSublistValue({sublistId:'item',fieldId:LINE_ID_FIELD,line,value:lineId});

                if (s.price !== undefined && s.price !== null && s.price !== '') {
                    so.setSublistValue({sublistId:'item',fieldId:'price',line,value:-1});
                    so.setSublistValue({sublistId:'item',fieldId:'rate',line,value:+s.price});
                }

                addCount++;
                changed = true;

                log.audit('ITEM ADDED',{
                    item:s.name,sku:s.sku,itemId,lineId,quantity:s.current_quantity,rate:s.price
                });
            });

            if (blocked) {
                log.error('ORDER NOT PROCESSED - BLOCKED',{
                    shopifyOrderId:orderId,salesOrderId:soId,celigoErrorId:err.errorId
                });
                return;
            }

            if (changed) {
                const savedId = so.save({enableSourcing:true,ignoreMandatoryFields:false});

                log.audit('SALES ORDER UPDATED SUCCESSFULLY',{
                    salesOrderId:savedId,
                    shopifyOrderId:orderId,
                    removed:removeCount,
                    fillersRemoved:fillerRemoveCount,
                    added:addCount,
                    qtyUpdated:updateCount,
                    fulfilledSkipped:fulfilledSkipCount
                });
            } else {
                log.audit('NO NETSUITE CHANGES REQUIRED',{salesOrderId:soId,shopifyOrderId:orderId});
            }

            const resolveRes = https.put({
                url:`https://api.integrator.io/v1/flows/${FLOW_ID}/${STEP_ID}/resolved`,
                headers:{
                    Authorization:`Bearer ${CELIGO_TOKEN}`,
                    'Content-Type':'application/json',
                    Accept:'application/json'
                },
                body:JSON.stringify({errors:[String(err.errorId)]})
            });

            if (+resolveRes.code >= 200 && +resolveRes.code < 300) {
                log.audit('CELIGO ERROR RESOLVED',{
                    errorId:err.errorId,shopifyOrderId:orderId,responseCode:resolveRes.code
                });
            } else {
                log.error('NETSUITE UPDATED BUT CELIGO RESOLVE FAILED',{
                    errorId:err.errorId,shopifyOrderId:orderId,code:resolveRes.code,body:resolveRes.body
                });
            }

        } catch(e) {
            log.error('MAP ERROR - CELIGO ERROR LEFT OPEN',{
                name:e.name,message:e.message || String(e),stack:e.stack
            });
        }
    };

    const summarize = summary => {
        log.audit('MAP REDUCE COMPLETE',{usage:summary.usage,yields:summary.yields,concurrency:summary.concurrency});
        summary.mapSummary.errors.iterator().each((key,error) => {
            log.error('MAP SUMMARY ERROR',{key,error});
            return true;
        });
    };

    return {getInputData,map,summarize};
});