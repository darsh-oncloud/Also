/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * LIVE - creates/edits customer refunds, updates the bank deposit, closes the variance record.
 * Deploy on: Shopify Payout Variance Transaction custom record.
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const CASHBACK_MEMO  = 'variances';
    const REFUND_ACCOUNT = 122;
    const SO_LINK_FIELD  = 'custbody_pcs_netsuite_sales_order';
    const MAX_RETRY      = 3;

    /* apply a customer deposit line on a refund record (used by create and edit paths) */
    const applyDeposit = (refund, cdId, amount) => {
        const cnt = refund.getLineCount({ sublistId: 'deposit' });
        let applied = false;
        for (let i = 0; i < cnt; i++) {
            const mine = String(refund.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i })) === String(cdId);
            refund.setSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i, value: mine });
            if (mine) {
                refund.setSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i, value: amount });
                applied = true;
            }
        }
        return applied;
    };

    /* tick the refund on the bank deposit and shrink the variance cash back line, with retry */
    const updateBankDeposit = (depositId, refundId, amount) => {
        for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
            try {
                const dep = record.load({
                    type: record.Type.DEPOSIT, id: depositId, isDynamic: false,
                    defaultValues: { disablepaymentfilters: true }
                });

                let line = -1;
                const pCount = dep.getLineCount({ sublistId: 'payment' });
                for (let i = 0; i < pCount; i++) {
                    if (String(dep.getSublistValue({ sublistId: 'payment', fieldId: 'id', line: i })) === String(refundId)) { line = i; break; }
                }
                if (line === -1) throw Error('refund ' + refundId + ' is not available on deposit ' + depositId);

                if (dep.getSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: line })) {
                    log.audit('Deposit already ticked', { depositId: depositId, refundId: refundId });
                    return { skipped: true };
                }

                let cbLine = -1;
                const cCount = dep.getLineCount({ sublistId: 'cashback' });
                for (let i = 0; i < cCount; i++) {
                    const memo = dep.getSublistValue({ sublistId: 'cashback', fieldId: 'memo', line: i });
                    if (String(memo || '').trim().toLowerCase() === CASHBACK_MEMO) { cbLine = i; break; }
                }
                if (cbLine === -1) throw Error('no cash back line with memo "' + CASHBACK_MEMO + '" on deposit ' + depositId);

                const before = parseFloat(dep.getSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: cbLine })) || 0;
                const after  = Math.round((before - amount) * 100) / 100;
                if (after < -0.001) throw Error('cash back ' + before + ' is less than refund ' + amount);

                dep.setSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: line, value: true });
                if (Math.abs(after) < 0.001) dep.removeLine({ sublistId: 'cashback', line: cbLine });
                else dep.setSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: cbLine, value: after });

                dep.save({ enableSourcing: true, ignoreMandatoryFields: true });
                return { line: line, cashBackBefore: before, cashBackAfter: after };

            } catch (e) {
                if (e.name === 'RCRD_HAS_BEEN_CHANGED' && attempt < MAX_RETRY) {
                    log.audit('Deposit changed by another process, retrying', 'attempt ' + attempt);
                    continue;
                }
                throw e;
            }
        }
    };

    const afterSubmit = (context) => {
        if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) return;

        const rec = context.newRecord;

        try {
            /* ---------- gates ---------- */
            if (rec.getValue('isinactive')) return;
            if (rec.getValue('custrecord_related_netsuite_transaction')) return;

            const varianceType = rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) || rec.getValue('custrecord_celigo_shpf_trans_var_type');
            const payoutType   = rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) || rec.getValue('custrecord_celigo_shpf_payout_tran_type');
            if (String(varianceType) !== 'Missing Transaction') return;
            if (String(payoutType).toLowerCase() !== 'refund') return;

            const sourceOrderId = rec.getValue('custrecord_celigo_shpf_tran_src_ordr_id');
            const bankDepositId = rec.getValue('custrecord_celigo_shpf_trans_deposit_id');
            const refundAmount  = Math.abs(parseFloat(rec.getValue('custrecord_celigo_shpf_trans_var_amnt')) || 0);
            if (!sourceOrderId || !bankDepositId || !refundAmount) throw Error('missing source order id, deposit id or variance amount');

            log.audit('START', { varianceRecord: rec.id, sourceOrderId, bankDepositId, refundAmount });

            /* ---------- sales order ---------- */
            const so = search.create({
                type: 'salesorder',
                filters: [['mainline', 'is', 'T'], 'AND', ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]],
                columns: ['internalid', 'tranid', 'entity']
            }).run().getRange({ start: 0, end: 2 });

            if (!so.length) throw Error('sales order not found for shopify order ' + sourceOrderId);
            if (so.length > 1) throw Error('more than one sales order matches shopify order ' + sourceOrderId);
            const soId = so[0].id;

            /* ---------- customer deposit ---------- */
            const cdRows = search.create({
                type: 'salesorder',
                settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
                filters: [
                    ['type', 'anyof', 'SalesOrd'], 'AND',
                    ['internalidnumber', 'equalto', soId], 'AND',
                    ['applyingtransaction.type', 'anyof', 'CustDep'], 'AND',
                    ['applyingtransaction.status', 'anyof', 'CustDep:A', 'CustDep:B']
                ],
                columns: [search.createColumn({ name: 'internalid', join: 'applyingTransaction' })]
            }).run().getRange({ start: 0, end: 20 });

            const cdIds = [];
            cdRows.forEach(r => {
                const id = String(r.getValue({ name: 'internalid', join: 'applyingTransaction' }) || '');
                if (id && cdIds.indexOf(id) < 0) cdIds.push(id);
            });

            if (!cdIds.length) throw Error('no customer deposit (status A or B) on sales order ' + soId);
            if (cdIds.length > 1) throw Error('more than one customer deposit on sales order ' + soId + ' - needs manual handling');
            const customerDepositId = cdIds[0];

            const depositInfo = search.lookupFields({
                type: search.Type.DEPOSIT, id: bankDepositId, columns: ['trandate', 'tranid']
            });

            /* ---------- find and classify every candidate refund ---------- */
            const candidates = [];
            const addCandidates = (filters) => {
                search.create({
                    type: 'customerrefund', filters: filters, columns: ['internalid', 'tranid', 'total']
                }).run().getRange({ start: 0, end: 20 }).forEach(r => {
                    if (candidates.filter(c => c.id === String(r.id))[0]) return;
                    candidates.push({ id: String(r.id), tranid: r.getValue('tranid'), total: Math.abs(parseFloat(r.getValue('total')) || 0) });
                });
            };
            addCandidates([['mainline', 'is', 'T'], 'AND', ['createdfrom', 'anyof', soId]]);
            try { addCandidates([['mainline', 'is', 'T'], 'AND', [SO_LINK_FIELD, 'anyof', soId]]); }
            catch (e) { log.audit('SO link field search unavailable', e.message); }

            let reuse = null, needsApply = null, blocked = null;

            candidates.forEach(c => {
                if (Math.abs(c.total - refundAmount) >= 0.01) return;      // wrong amount, ignore

                const rr = record.load({ type: record.Type.CUSTOMER_REFUND, id: c.id });
                let appliesOurs = false, appliesOther = false;
                const dc = rr.getLineCount({ sublistId: 'deposit' });
                for (let i = 0; i < dc; i++) {
                    if (!rr.getSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i })) continue;
                    const doc = String(rr.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i }));
                    if (doc === customerDepositId) appliesOurs = true; else appliesOther = true;
                }

                if (appliesOther && !appliesOurs) { blocked = blocked || (c.tranid + ' applies a different customer deposit'); return; }
                if (appliesOurs)  { reuse      = reuse      || c; return; }
                needsApply = needsApply || c;                              // applies nothing - we can use it
            });

            if (!reuse && !needsApply && blocked) throw Error('BLOCKED: ' + blocked + ' - not creating a duplicate, needs manual review');

            /* ---------- get a usable refund ---------- */
            let refundId, action;

            if (reuse) {
                refundId = reuse.id;
                action = 'REUSED ' + reuse.tranid;

            } else if (needsApply) {
                const rr = record.load({ type: record.Type.CUSTOMER_REFUND, id: needsApply.id });
                if (!applyDeposit(rr, customerDepositId, refundAmount)) throw Error('customer deposit ' + customerDepositId + ' not available on refund ' + needsApply.tranid);
                if (!rr.getValue(SO_LINK_FIELD)) rr.setValue({ fieldId: SO_LINK_FIELD, value: soId });
                refundId = rr.save({ enableSourcing: true, ignoreMandatoryFields: true });
                action = 'APPLIED DEPOSIT TO ' + needsApply.tranid;

            } else {
                const rr = record.transform({
                    fromType: record.Type.CUSTOMER_DEPOSIT, fromId: customerDepositId,
                    toType: record.Type.CUSTOMER_REFUND, isDynamic: false
                });
                rr.setValue({ fieldId: 'account', value: REFUND_ACCOUNT });
                rr.setValue({ fieldId: 'trandate', value: depositInfo.trandate });
                rr.setValue({ fieldId: SO_LINK_FIELD, value: soId });
                if (!applyDeposit(rr, customerDepositId, refundAmount)) throw Error('customer deposit ' + customerDepositId + ' not available on the new refund');
                refundId = rr.save({ enableSourcing: true, ignoreMandatoryFields: true });
                action = 'CREATED new refund';
            }

            log.audit('Refund ready', { action: action, refundId: refundId, amount: refundAmount });

            /* ---------- bank deposit ---------- */
            const depResult = updateBankDeposit(bankDepositId, refundId, refundAmount);
            log.audit('Bank deposit updated', { deposit: depositInfo.tranid, refundId: refundId, result: depResult });

            /* ---------- close the variance record ---------- */
            record.submitFields({
                type: rec.type, id: rec.id,
                values: { custrecord_related_netsuite_transaction: refundId, isinactive: true },
                options: { ignoreMandatoryFields: true }
            });

            log.audit('DONE', { varianceRecord: rec.id, action: action, refundId: refundId });

        } catch (e) {
            log.error('Variance refund FAILED - record ' + rec.id + ' left active', { message: e.message, stack: e.stack });
        }
    };

    return { afterSubmit };
});