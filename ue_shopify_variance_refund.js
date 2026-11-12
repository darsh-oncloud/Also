/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Shopify Payout Variance -> Customer Refund (LIVE, with dry-run switch)
 *
 * DRY_RUN = true  -> only logs what it would do; nothing is saved
 * DRY_RUN = false -> creates the Customer Refund from the Customer Deposit
 *                    and writes the refund ID back to the variance record
 *
 * Still does NOT touch the Bank Deposit / cashback (out of scope).
 *
 * Deploy on: Shopify Payout Variance Transaction
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    /* ===================== CONFIG ===================== */
    const DRY_RUN = true;                 // flip to true to test without saving
    const REFUND_ACCOUNT = 122;            // bank/GL account the refund is paid from
    const SO_LINK_FIELD = 'custbody_pcs_netsuite_sales_order';
    const VARIANCE_LINK_FIELD = 'custrecord_related_netsuite_transaction';
    const LINK_EXISTING_REFUND = false;    // true = if a same-amount refund already exists, link it to the variance
    const INACTIVATE_VARIANCE = false;     // true = also inactivate the variance after the refund is created
    /* ================================================== */

    const afterSubmit = (context) => {

        if (
            context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT
        ) return;

        const rec = context.newRecord;

        const result = {
            dryRun: DRY_RUN,
            varianceRecord: rec.id,
            createdRefund: null,
            wouldCreateRefund: false,
            salesOrder: null,
            customerDeposit: null,
            refundAmount: null,
            existingRefund: null,
            stoppedAt: null,
            problems: []
        };

        try {

            /* 1. READ VARIANCE RECORD */
            const inactive = rec.getValue({ fieldId: 'isinactive' });
            const relatedTransaction = rec.getValue({ fieldId: VARIANCE_LINK_FIELD });

            const varianceType =
                rec.getText({ fieldId: 'custrecord_celigo_shpf_trans_var_type' }) ||
                rec.getValue({ fieldId: 'custrecord_celigo_shpf_trans_var_type' });

            const payoutType =
                rec.getText({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' }) ||
                rec.getValue({ fieldId: 'custrecord_celigo_shpf_payout_tran_type' });

            log.audit('1. VARIANCE RECORD', {
                varianceRecord: rec.id, inactive, relatedTransaction, varianceType, payoutType
            });

            /* 2. BASIC VALIDATION */
            if (inactive === true || inactive === 'T') {
                result.stoppedAt = 'Variance record is inactive';
                return;
            }
            if (relatedTransaction) {
                result.stoppedAt = 'Related NetSuite Transaction already populated: ' + relatedTransaction;
                return;
            }
            if (String(varianceType) !== 'Missing Transaction') {
                result.stoppedAt = 'Variance Type is not Missing Transaction';
                return;
            }
            if (String(payoutType).toLowerCase() !== 'refund') {
                result.stoppedAt = 'Payout Type is not refund';
                return;
            }

            /* 3. SOURCE ORDER + AMOUNT */
            const sourceOrderId = rec.getValue({ fieldId: 'custrecord_celigo_shpf_tran_src_ordr_id' });
            const refundAmount = Math.abs(
                parseFloat(rec.getValue({ fieldId: 'custrecord_celigo_shpf_trans_var_amnt' })) || 0
            );
            result.refundAmount = refundAmount;

            log.audit('2. SOURCE DATA', { sourceOrderId, refundAmount });

            if (!sourceOrderId || !refundAmount) {
                result.stoppedAt = 'Missing Source Order ID or Refund Amount';
                return;
            }

            /* 4. FIND SALES ORDER */
            const soResults = search.create({
                type: 'salesorder',
                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    ['custbody_celigo_etail_order_id', 'is', String(sourceOrderId)]
                ],
                columns: ['internalid', 'tranid', 'entity', 'status']
            }).run().getRange({ start: 0, end: 5 });

            log.audit('3. SALES ORDER SEARCH', {
                sourceOrderId,
                matches: soResults.length,
                results: soResults.map(r => ({
                    internalId: r.id,
                    tranid: r.getValue('tranid'),
                    customer: r.getText('entity'),
                    status: r.getText('status')
                }))
            });

            if (!soResults.length) {
                result.stoppedAt = 'No Sales Order found for Source Order ID ' + sourceOrderId;
                return;
            }
            if (soResults.length > 1) {
                result.stoppedAt = 'More than one Sales Order found for Source Order ID ' + sourceOrderId;
                return;
            }

            const soId = String(soResults[0].id);
            const soNumber = soResults[0].getValue('tranid');
            result.salesOrder = { id: soId, tranid: soNumber, customer: soResults[0].getText('entity') };

            /* 5. FIND CUSTOMER DEPOSIT (Not Deposited / Deposited, i.e. not fully applied) */
            const cdRows = search.create({
                type: 'salesorder',
                filters: [
                    ['type', 'anyof', 'SalesOrd'],
                    'AND', ['internalidnumber', 'equalto', soId],
                    'AND', ['applyingtransaction.type', 'anyof', 'CustDep'],
                    'AND', ['applyingtransaction.status', 'anyof', 'CustDep:A', 'CustDep:B']
                ],
                columns: [
                    search.createColumn({ name: 'internalid', join: 'applyingTransaction' }),
                    search.createColumn({ name: 'tranid', join: 'applyingTransaction' }),
                    search.createColumn({ name: 'amount', join: 'applyingTransaction' }),
                    search.createColumn({ name: 'status', join: 'applyingTransaction' })
                ]
            }).run().getRange({ start: 0, end: 20 });

            const customerDeposits = [];
            cdRows.forEach(row => {
                const id = String(row.getValue({ name: 'internalid', join: 'applyingTransaction' }) || '');
                if (id && !customerDeposits.some(d => d.id === id)) {
                    customerDeposits.push({
                        id,
                        tranid: row.getValue({ name: 'tranid', join: 'applyingTransaction' }),
                        amount: row.getValue({ name: 'amount', join: 'applyingTransaction' }),
                        status: row.getText({ name: 'status', join: 'applyingTransaction' })
                    });
                }
            });

            log.audit('4. CUSTOMER DEPOSIT SEARCH', {
                salesOrder: soNumber, found: customerDeposits.length, deposits: customerDeposits
            });

            if (!customerDeposits.length) {
                result.stoppedAt = 'No Customer Deposit found on Sales Order ' + soNumber;
                return;
            }
            if (customerDeposits.length > 1) {
                result.stoppedAt = 'More than one Customer Deposit found on Sales Order ' + soNumber;
                return;
            }

            const customerDeposit = customerDeposits[0];
            result.customerDeposit = customerDeposit;

            /* 6. CHECK EXISTING REFUNDS (duplicate guard) */
            const candidates = [];
            const addRefundCandidates = (filters) => {
                search.create({
                    type: 'customerrefund',
                    filters,
                    columns: ['internalid', 'tranid', 'total', 'trandate']
                }).run().getRange({ start: 0, end: 20 }).forEach(row => {
                    if (candidates.some(c => c.id === String(row.id))) return;
                    candidates.push({
                        id: String(row.id),
                        tranid: row.getValue('tranid'),
                        total: Math.abs(parseFloat(row.getValue('total')) || 0),
                        trandate: row.getValue('trandate')
                    });
                });
            };

            // A refund transformed from a Customer Deposit has createdfrom = the deposit,
            // so check both the SO and the deposit.
            addRefundCandidates([
                ['mainline', 'is', 'T'],
                'AND',
                ['createdfrom', 'anyof', [soId, customerDeposit.id]]
            ]);

            try {
                addRefundCandidates([
                    ['mainline', 'is', 'T'],
                    'AND',
                    [SO_LINK_FIELD, 'anyof', soId]
                ]);
            } catch (e) {
                result.problems.push('SO Link Field search failed: ' + e.message);
            }

            log.audit('5. REFUND CANDIDATES', {
                salesOrder: soNumber, refundAmountRequired: refundAmount, candidates
            });

            /* 7. CHECK SAME AMOUNT */
            const existingRefund = candidates.find(c => Math.abs(c.total - refundAmount) < 0.01) || null;

            if (existingRefund) {
                result.existingRefund = existingRefund;
                result.stoppedAt = 'Matching Customer Refund already exists';
                log.audit('6. MATCHING REFUND ALREADY EXISTS - NOT CREATING', existingRefund);

                if (LINK_EXISTING_REFUND && !DRY_RUN) {
                    updateVariance(rec, existingRefund.id);
                }
                return;
            }

            /* 8. TRANSFORM CUSTOMER DEPOSIT -> CUSTOMER REFUND */
            const refund = record.transform({
                fromType: record.Type.CUSTOMER_DEPOSIT,
                fromId: customerDeposit.id,
                toType: record.Type.CUSTOMER_REFUND,
                isDynamic: false
            });

            refund.setValue({ fieldId: 'account', value: REFUND_ACCOUNT });
            refund.setValue({
                fieldId: 'memo',
                value: 'Shopify refund - order ' + sourceOrderId + ' - variance ' + rec.id
            });

            try {
                refund.setValue({ fieldId: SO_LINK_FIELD, value: soId });
            } catch (e) {
                result.problems.push('Could not set SO link field on refund: ' + e.message);
            }

            const depositLineCount = refund.getLineCount({ sublistId: 'deposit' });
            const depositLines = [];
            let targetLine = -1;

            for (let i = 0; i < depositLineCount; i++) {
                const doc = String(refund.getSublistValue({ sublistId: 'deposit', fieldId: 'doc', line: i }) || '');
                const remaining = parseFloat(
                    refund.getSublistValue({ sublistId: 'deposit', fieldId: 'remaining', line: i })
                );
                depositLines.push({
                    line: i,
                    doc,
                    remaining,
                    amount: refund.getSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: i }),
                    apply: refund.getSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i })
                });

                if (doc === String(customerDeposit.id)) {
                    targetLine = i;
                } else {
                    // make sure only our deposit is applied
                    refund.setSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: i, value: false });
                }
            }

            log.audit('7. REFUND TRANSFORM PREVIEW', {
                customerDeposit, depositLineCount, targetLine, depositLines
            });

            if (targetLine < 0) {
                result.stoppedAt = 'Customer Deposit is not available on transformed Customer Refund';
                return;
            }

            const remainingOnDeposit = depositLines[targetLine].remaining;
            if (!isNaN(remainingOnDeposit) && refundAmount - remainingOnDeposit > 0.005) {
                result.stoppedAt =
                    'Refund amount ' + refundAmount +
                    ' is more than remaining on deposit ' + remainingOnDeposit;
                return;
            }

            refund.setSublistValue({ sublistId: 'deposit', fieldId: 'apply', line: targetLine, value: true });
            refund.setSublistValue({ sublistId: 'deposit', fieldId: 'amount', line: targetLine, value: refundAmount });

            /* 9. SAVE (or stop here in dry run) */
            result.wouldCreateRefund = true;

            if (DRY_RUN) {
                log.audit('8. DRY RUN - WOULD CREATE CUSTOMER REFUND', {
                    fromCustomerDeposit: customerDeposit.id,
                    salesOrderId: soId,
                    refundAmount,
                    refundAccount: REFUND_ACCOUNT,
                    saved: false
                });
                return;
            }

            const refundId = refund.save({ enableSourcing: true, ignoreMandatoryFields: false });
            result.createdRefund = refundId;

            log.audit('8. CUSTOMER REFUND CREATED', {
                refundId,
                fromCustomerDeposit: customerDeposit.id,
                salesOrderId: soId,
                refundAmount
            });

            /* 10. LINK REFUND BACK TO VARIANCE (stops it from running again) */
            updateVariance(rec, refundId);

        } catch (e) {
            result.stoppedAt = 'ERROR: ' + e.message;
            log.error('CUSTOMER REFUND ERROR', {
                varianceRecord: rec.id, message: e.message, stack: e.stack
            });
        } finally {
            log.audit(
                DRY_RUN ? '=== DRY RUN RESULT - NOTHING SAVED ===' : '=== CUSTOMER REFUND RESULT ===',
                result
            );
        }
    };

    const updateVariance = (rec, refundId) => {
        const values = {};
        values[VARIANCE_LINK_FIELD] = refundId;
        if (INACTIVATE_VARIANCE) values.isinactive = true;

        record.submitFields({
            type: rec.type,
            id: rec.id,
            values,
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });

        log.audit('9. VARIANCE UPDATED', { varianceRecord: rec.id, values });
    };

    return { afterSubmit };
});