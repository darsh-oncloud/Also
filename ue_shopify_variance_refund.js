/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * DRY RUN ONLY - reads and logs, never creates or updates anything.
 * Deploy on: Shopify Payout Variance Transaction custom record.
 * Trigger it by opening a variance record, hitting Edit then Save (no changes needed),
 * then read the Execution Log on the script deployment.
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const REFUND_ACCOUNT = 122;                 // account the refund would be created against
    const CASHBACK_MEMO  = 'variances';         // memo on the deposit cash back line

    const afterSubmit = (context) => {

        const plan = {
            varianceRecord : null,
            wouldProceed   : false,
            stoppedAt      : null,
            salesOrder     : null,
            customerDeposit: null,
            refundAction   : null,              // REUSE_EXISTING | CREATE_NEW
            refundId       : null,
            depositPaymentLine : null,
            cashBackBefore : null,
            cashBackAfter  : null,
            problems       : []
        };

        try {
            if (context.type === context.UserEventType.DELETE) return;

            const rec = context.newRecord;
            plan.varianceRecord = rec.id;

            /* ---------- 1. gates ---------- */
            const varianceType = rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) || rec.getValue('custrecord_celigo_shpf_trans_var_type');
            const payoutType   = rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) || rec.getValue('custrecord_celigo_shpf_payout_tran_type');
            const alreadyDone  = rec.getValue('custrecord_related_netsuite_transaction');
            const inactive     = rec.getValue('isinactive');

            log.audit('1. Gate values', {
                contextType: context.type,
                varianceType: varianceType,
                payoutType: payoutType,
                isinactive: inactive,
                relatedTransaction: alreadyDone
            });

            if (inactive)      { plan.stoppedAt = 'record is inactive'; return; }
            if (alreadyDone)   { plan.stoppedAt = 'related transaction already set: ' + alreadyDone; return; }
            if (String(varianceType) !== 'Missing Transaction') { plan.stoppedAt = 'variance type is not Missing Transaction'; return; }
            if (String(payoutType).toLowerCase() !== 'refund')  { plan.stoppedAt = 'payout type is not refund'; return; }

            /* ---------- 2. source fields ---------- */
            const sourceOrderId = rec.getValue('custrecord_celigo_shpf_tran_src_ordr_id');
            const bankDepositId = rec.getValue('custrecord_celigo_shpf_trans_deposit_id');
            const refundAmount  = Math.abs(parseFloat(rec.getValue('custrecord_celigo_shpf_trans_var_amnt')) || 0);

            log.audit('2. Source fields', {
                sourceOrderId: sourceOrderId,
                bankDepositId: bankDepositId,
                refundAmount: refundAmount
            });

            if (!sourceOrderId || !bankDepositId || !refundAmount) {
                plan.stoppedAt = 'missing source order id, deposit id or variance amount';
                return;
            }

            /* ---------- 3. sales order ---------- */
            const soResult = search.create({
                type: 'salesorder',
                filters: [
                    ['mainline', 'is', 'T'], 'AND',
                    ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]
                ],
                columns: ['internalid', 'tranid', 'entity', 'status']
            }).run().getRange({ start: 0, end: 5 });

            log.audit('3. Sales order search', {
                matches: soResult.length,
                rows: soResult.map(r => ({ id: r.id, tranid: r.getValue('tranid'), customer: r.getText('entity'), status: r.getText('status') }))
            });

            if (!soResult.length) { plan.stoppedAt = 'sales order not found for shopify order ' + sourceOrderId; return; }
            if (soResult.length > 1) plan.problems.push('more than one sales order matched this shopify order id');

            const soId = soResult[0].id;
            plan.salesOrder = soId + ' (' + soResult[0].getValue('tranid') + ')';

            /* ---------- 4. bank deposit header ---------- */
            const depositInfo = search.lookupFields({
                type: search.Type.DEPOSIT,
                id: bankDepositId,
                columns: ['trandate', 'total', 'tranid']
            });

            log.audit('4. Bank deposit', {
                depositId: bankDepositId,
                tranid: depositInfo.tranid,
                trandate: depositInfo.trandate,
                total: depositInfo.total
            });

            /* ---------- 5. customer deposit ---------- */
            const customerDeposits = search.create({
                type: 'customerdeposit',
                filters: [
                    ['salesorder', 'anyof', soId], 'AND',
                    ['amountremaining', 'greaterthan', '0.00']
                ],
                columns: ['internalid', 'tranid', 'amount', 'amountremaining',
                    search.createColumn({ name: 'trandate', sort: search.Sort.DESC })]
            }).run().getRange({ start: 0, end: 20 });

            log.audit('5. Customer deposits on this SO', {
                found: customerDeposits.length,
                rows: customerDeposits.map(r => ({
                    id: r.id, tranid: r.getValue('tranid'),
                    amount: r.getValue('amount'), remaining: r.getValue('amountremaining'),
                    date: r.getValue('trandate')
                }))
            });

            let customerDepositId = null;
            for (let i = 0; i < customerDeposits.length; i++) {
                if (Math.abs(parseFloat(customerDeposits[i].getValue('amountremaining')) || 0) >= refundAmount) {
                    customerDepositId = customerDeposits[i].id;
                    break;
                }
            }

            if (!customerDepositId) { plan.stoppedAt = 'no open customer deposit with at least ' + refundAmount; return; }
            plan.customerDeposit = customerDepositId;

            /* ---------- 6. existing refunds - try BOTH links, log which one works ---------- */
            const refundRows = [];

            const runRefundSearch = (label, filters) => {
                try {
                    const rows = search.create({
                        type: 'customerrefund',
                        filters: filters,
                        columns: ['internalid', 'tranid', 'trandate', 'total', 'account']
                    }).run().getRange({ start: 0, end: 20 });

                    rows.forEach(r => {
                        const hit = refundRows.filter(x => x.id === r.id)[0];
                        if (hit) {
                            hit.matchedBy.push(label);
                        } else {
                            refundRows.push({
                                id: r.id,
                                tranid: r.getValue('tranid'),
                                date: r.getValue('trandate'),
                                total: r.getValue('total'),
                                account: r.getText('account'),
                                matchedBy: [label]
                            });
                        }
                    });
                    return rows.length;
                } catch (e) {
                    plan.problems.push('refund search by ' + label + ' failed: ' + e.message);
                    return 'SEARCH FAILED';
                }
            };

            const byCreatedFrom = runRefundSearch('createdfrom', [
                ['mainline', 'is', 'T'], 'AND',
                ['createdfrom', 'anyof', [soId, customerDepositId]]
            ]);

            const byCustomField = runRefundSearch('custbody_pcs_netsuite_sales_order', [
                ['mainline', 'is', 'T'], 'AND',
                ['custbody_pcs_netsuite_sales_order', 'anyof', soId]
            ]);

            log.audit('6. Existing customer refunds for this order', {
                hitsByCreatedFrom: byCreatedFrom,
                hitsByCustomField: byCustomField,
                distinctRefunds: refundRows.length,
                rows: refundRows
            });

            if (byCreatedFrom > 0 && byCustomField === 0) {
                plan.problems.push('refunds found via createdfrom but NOT via custbody_pcs_netsuite_sales_order - the live script must use createdfrom or it will create duplicates');
            }

            /* ---------- 7. bank deposit sublists ---------- */
            const deposit = record.load({
                type: record.Type.DEPOSIT,
                id: bankDepositId,
                isDynamic: false,
                defaultValues: { disablepaymentfilters: true }
            });

            const paymentCount = deposit.getLineCount({ sublistId: 'payment' });
            const refundIdSet  = refundRows.map(r => String(r.id));
            const availableRefundLines = [];
            let matchedLine = -1, matchedRefundId = null;

            for (let i = 0; i < paymentCount; i++) {
                const id      = String(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'id', line: i }));
                const amt     = Math.abs(parseFloat(deposit.getSublistValue({ sublistId: 'payment', fieldId: 'amount', line: i })) || 0);
                const ticked  = deposit.getSublistValue({ sublistId: 'payment', fieldId: 'deposit', line: i });
                const isOurs  = refundIdSet.indexOf(id) >= 0;

                if (isOurs) {
                    availableRefundLines.push({ line: i, transactionId: id, amount: amt, alreadyTicked: ticked });
                    if (!ticked && Math.abs(amt - refundAmount) < 0.01 && matchedLine === -1) {
                        matchedLine = i;
                        matchedRefundId = id;
                    }
                }
            }

            log.audit('7. Deposit payment sublist', {
                totalAvailableLines: paymentCount,
                linesForThisOrder: availableRefundLines
            });

            /* ---------- 8. cash back line ---------- */
            const cashBackCount = deposit.getLineCount({ sublistId: 'cashback' });
            const cashBackRows = [];
            let varianceLine = -1;

            for (let i = 0; i < cashBackCount; i++) {
                const memo = deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'memo', line: i });
                const amt  = parseFloat(deposit.getSublistValue({ sublistId: 'cashback', fieldId: 'amount', line: i })) || 0;
                cashBackRows.push({ line: i, memo: memo, amount: amt });
                if (String(memo || '').trim().toLowerCase() === CASHBACK_MEMO && varianceLine === -1) varianceLine = i;
            }

            log.audit('8. Deposit cash back sublist', { lines: cashBackRows, varianceLineIndex: varianceLine });

            if (varianceLine === -1) plan.problems.push('no cash back line with memo "' + CASHBACK_MEMO + '" - the real script would fail here');

            /* ---------- 9. the plan ---------- */
            if (matchedLine >= 0) {
                plan.refundAction = 'REUSE_EXISTING';
                plan.refundId = matchedRefundId;
                plan.depositPaymentLine = matchedLine;
            } else {
                plan.refundAction = 'CREATE_NEW';
                plan.refundId = 'would transform customer deposit ' + customerDepositId +
                    ' into a customer refund of ' + refundAmount +
                    ' on account ' + REFUND_ACCOUNT +
                    ' dated ' + depositInfo.trandate;
                if (refundRows.length) plan.problems.push('refunds exist for this order but none are un-deposited at ' + refundAmount + ' - check for a duplicate before going live');
            }

            if (varianceLine >= 0) {
                plan.cashBackBefore = cashBackRows[varianceLine].amount;
                plan.cashBackAfter  = Math.round((plan.cashBackBefore - refundAmount) * 100) / 100;
                if (plan.cashBackAfter < -0.001) plan.problems.push('cash back line is smaller than the refund amount - the real script would fail here');
            }

            plan.wouldProceed = true;

        } catch (e) {
            plan.stoppedAt = 'ERROR: ' + e.message;
            log.error('Dry run error', { message: e.message, stack: e.stack });
        } finally {
            log.audit('=== DRY RUN RESULT (nothing was saved) ===', plan);
        }
    };

    return { afterSubmit };
});
