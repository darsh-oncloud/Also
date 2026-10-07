/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * DRY RUN - CUSTOMER REFUND CREATION TEST ONLY
 *
 * Does NOT:
 * - create Customer Refund
 * - update Bank Deposit
 * - apply/tick refund on Bank Deposit
 * - update cashback variance
 * - update/inactivate variance record
 *
 * Deploy on: Shopify Payout Variance Transaction
 */
define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

    const REFUND_ACCOUNT = 122;
    const SO_LINK_FIELD = 'custbody_pcs_netsuite_sales_order';

    const afterSubmit = (context) => {

        if (
            context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT
        ) return;

        const rec = context.newRecord;

        const result = {
            varianceRecord: rec.id,
            wouldCreateRefund: false,
            salesOrder: null,
            customerDeposit: null,
            refundAmount: null,
            existingRefund: null,
            stoppedAt: null,
            problems: []
        };

        try {

            /* =====================================================
             * 1. READ VARIANCE RECORD
             * ===================================================== */

            const inactive = rec.getValue({
                fieldId: 'isinactive'
            });

            const relatedTransaction = rec.getValue({
                fieldId: 'custrecord_related_netsuite_transaction'
            });

            const varianceType =
                rec.getText({
                    fieldId: 'custrecord_celigo_shpf_trans_var_type'
                }) ||
                rec.getValue({
                    fieldId: 'custrecord_celigo_shpf_trans_var_type'
                });

            const payoutType =
                rec.getText({
                    fieldId: 'custrecord_celigo_shpf_payout_tran_type'
                }) ||
                rec.getValue({
                    fieldId: 'custrecord_celigo_shpf_payout_tran_type'
                });


            log.audit('1. VARIANCE RECORD', {
                varianceRecord: rec.id,
                inactive: inactive,
                relatedTransaction: relatedTransaction,
                varianceType: varianceType,
                payoutType: payoutType
            });


            /* =====================================================
             * 2. BASIC VALIDATION
             * ===================================================== */

            if (inactive) {
                result.stoppedAt = 'Variance record is inactive';
                return;
            }

            if (relatedTransaction) {
                result.stoppedAt =
                    'Related NetSuite Transaction already populated: ' +
                    relatedTransaction;
                return;
            }

            if (String(varianceType) !== 'Missing Transaction') {
                result.stoppedAt =
                    'Variance Type is not Missing Transaction';
                return;
            }

            if (String(payoutType).toLowerCase() !== 'refund') {
                result.stoppedAt =
                    'Payout Type is not refund';
                return;
            }


            /* =====================================================
             * 3. SOURCE ORDER + AMOUNT
             *
             * BANK DEPOSIT IS NOT REQUIRED
             * ===================================================== */

            const sourceOrderId = rec.getValue({
                fieldId: 'custrecord_celigo_shpf_tran_src_ordr_id'
            });

            const refundAmount = Math.abs(
                parseFloat(
                    rec.getValue({
                        fieldId: 'custrecord_celigo_shpf_trans_var_amnt'
                    })
                ) || 0
            );

            result.refundAmount = refundAmount;


            log.audit('2. SOURCE DATA', {
                sourceOrderId: sourceOrderId,
                refundAmount: refundAmount,
                bankDepositRequired: false
            });


            if (!sourceOrderId || !refundAmount) {
                result.stoppedAt =
                    'Missing Source Order ID or Refund Amount';
                return;
            }


            /* =====================================================
             * 4. FIND SALES ORDER
             * ===================================================== */

            const soResults = search.create({

                type: 'salesorder',

                filters: [
                    ['mainline', 'is', 'T'],
                    'AND',
                    [
                        'custbody_celigo_etail_order_id',
                        'is',
                        String(sourceOrderId)
                    ]
                ],

                columns: [
                    'internalid',
                    'tranid',
                    'entity',
                    'status'
                ]

            }).run().getRange({
                start: 0,
                end: 5
            });


            log.audit('3. SALES ORDER SEARCH', {
                sourceOrderId: sourceOrderId,
                matches: soResults.length,
                results: soResults.map(row => ({
                    internalId: row.id,
                    tranid: row.getValue('tranid'),
                    customer: row.getText('entity'),
                    status: row.getText('status')
                }))
            });


            if (!soResults.length) {
                result.stoppedAt =
                    'No Sales Order found for Source Order ID ' +
                    sourceOrderId;
                return;
            }


            if (soResults.length > 1) {
                result.stoppedAt =
                    'More than one Sales Order found for Source Order ID ' +
                    sourceOrderId;
                return;
            }


            const soId = String(soResults[0].id);
            const soNumber = soResults[0].getValue('tranid');

            result.salesOrder = {
                id: soId,
                tranid: soNumber,
                customer: soResults[0].getText('entity')
            };


            /* =====================================================
             * 5. FIND CUSTOMER DEPOSIT
             * ===================================================== */

            const cdRows = search.create({

                type: 'salesorder',

                settings: [{
                    name: 'consolidationtype',
                    value: 'ACCTTYPE'
                }],

                filters: [

                    ['type', 'anyof', 'SalesOrd'],

                    'AND',

                    ['internalidnumber', 'equalto', soId],

                    'AND',

                    [
                        'applyingtransaction.type',
                        'anyof',
                        'CustDep'
                    ],

                    'AND',

                    [
                        'applyingtransaction.status',
                        'anyof',
                        'CustDep:A',
                        'CustDep:B'
                    ]
                ],

                columns: [

                    search.createColumn({
                        name: 'internalid',
                        join: 'applyingTransaction'
                    }),

                    search.createColumn({
                        name: 'tranid',
                        join: 'applyingTransaction'
                    }),

                    search.createColumn({
                        name: 'amount',
                        join: 'applyingTransaction'
                    }),

                    search.createColumn({
                        name: 'status',
                        join: 'applyingTransaction'
                    })
                ]

            }).run().getRange({
                start: 0,
                end: 20
            });


            const customerDeposits = [];


            cdRows.forEach(row => {

                const id = String(
                    row.getValue({
                        name: 'internalid',
                        join: 'applyingTransaction'
                    }) || ''
                );

                if (
                    id &&
                    !customerDeposits.some(d => d.id === id)
                ) {

                    customerDeposits.push({

                        id: id,

                        tranid: row.getValue({
                            name: 'tranid',
                            join: 'applyingTransaction'
                        }),

                        amount: row.getValue({
                            name: 'amount',
                            join: 'applyingTransaction'
                        }),

                        status: row.getText({
                            name: 'status',
                            join: 'applyingTransaction'
                        })
                    });
                }
            });


            log.audit('4. CUSTOMER DEPOSIT SEARCH', {
                salesOrder: soNumber,
                found: customerDeposits.length,
                deposits: customerDeposits
            });


            if (!customerDeposits.length) {
                result.stoppedAt =
                    'No Customer Deposit found on Sales Order ' +
                    soNumber;
                return;
            }


            if (customerDeposits.length > 1) {
                result.stoppedAt =
                    'More than one Customer Deposit found on Sales Order ' +
                    soNumber;
                return;
            }


            const customerDeposit = customerDeposits[0];

            result.customerDeposit = customerDeposit;


            /* =====================================================
             * 6. CHECK EXISTING REFUNDS
             * ===================================================== */

            const candidates = [];


            const addRefundCandidates = filters => {

                search.create({

                    type: 'customerrefund',

                    filters: filters,

                    columns: [
                        'internalid',
                        'tranid',
                        'total',
                        'trandate'
                    ]

                }).run().getRange({
                    start: 0,
                    end: 20
                }).forEach(row => {

                    if (
                        candidates.some(
                            c => c.id === String(row.id)
                        )
                    ) return;


                    candidates.push({

                        id: String(row.id),

                        tranid: row.getValue('tranid'),

                        total: Math.abs(
                            parseFloat(
                                row.getValue('total')
                            ) || 0
                        ),

                        trandate: row.getValue('trandate')
                    });
                });
            };


            /*
             * Refunds created from the Sales Order
             */

            addRefundCandidates([
                ['mainline', 'is', 'T'],
                'AND',
                ['createdfrom', 'anyof', soId]
            ]);


            /*
             * Refunds linked by custom Sales Order field
             */

            try {

                addRefundCandidates([
                    ['mainline', 'is', 'T'],
                    'AND',
                    [SO_LINK_FIELD, 'anyof', soId]
                ]);

            } catch (e) {

                result.problems.push(
                    'SO Link Field search failed: ' + e.message
                );
            }


            log.audit('5. REFUND CANDIDATES', {
                salesOrder: soNumber,
                refundAmountRequired: refundAmount,
                candidates: candidates
            });


            /* =====================================================
             * 7. CHECK SAME AMOUNT
             * ===================================================== */

            let existingRefund = null;


            candidates.forEach(candidate => {

                if (
                    Math.abs(
                        candidate.total - refundAmount
                    ) < 0.01 &&
                    !existingRefund
                ) {

                    existingRefund = candidate;
                }
            });


            if (existingRefund) {

                result.existingRefund = existingRefund;

                result.stoppedAt =
                    'Matching Customer Refund already exists';

                log.audit(
                    '6. MATCHING REFUND ALREADY EXISTS - WOULD NOT CREATE',
                    existingRefund
                );

                return;
            }


            /* =====================================================
             * 8. VERIFY CUSTOMER DEPOSIT CAN BE TRANSFORMED
             *
             * IMPORTANT:
             * transform happens in memory only.
             * NO SAVE.
             * ===================================================== */

            const refund = record.transform({

                fromType: record.Type.CUSTOMER_DEPOSIT,

                fromId: customerDeposit.id,

                toType: record.Type.CUSTOMER_REFUND,

                isDynamic: false
            });


            const depositLineCount =
                refund.getLineCount({
                    sublistId: 'deposit'
                });


            const depositLines = [];

            let customerDepositAvailable = false;


            for (let i = 0; i < depositLineCount; i++) {

                const doc = String(
                    refund.getSublistValue({
                        sublistId: 'deposit',
                        fieldId: 'doc',
                        line: i
                    }) || ''
                );


                const amount = refund.getSublistValue({
                    sublistId: 'deposit',
                    fieldId: 'amount',
                    line: i
                });


                const apply = refund.getSublistValue({
                    sublistId: 'deposit',
                    fieldId: 'apply',
                    line: i
                });


                depositLines.push({
                    line: i,
                    doc: doc,
                    amount: amount,
                    apply: apply
                });


                if (doc === String(customerDeposit.id)) {
                    customerDepositAvailable = true;
                }
            }


            log.audit('6. REFUND TRANSFORM PREVIEW', {
                customerDeposit: customerDeposit,
                depositLineCount: depositLineCount,
                customerDepositAvailable: customerDepositAvailable,
                depositLines: depositLines
            });


            if (!customerDepositAvailable) {

                result.stoppedAt =
                    'Customer Deposit is not available on transformed Customer Refund';

                return;
            }


            /* =====================================================
             * 9. FINAL DRY RUN RESULT
             * ===================================================== */

            result.wouldCreateRefund = true;


            log.audit('7. WOULD CREATE CUSTOMER REFUND', {

                fromCustomerDeposit: customerDeposit.id,

                customerDepositNumber: customerDeposit.tranid,

                salesOrderId: soId,

                salesOrderNumber: soNumber,

                refundAmount: refundAmount,

                refundAccount: REFUND_ACCOUNT,

                salesOrderLinkField: SO_LINK_FIELD,

                action:
                    'Transform Customer Deposit -> Customer Refund',

                saved:
                    false
            });


            log.audit('8. WOULD APPLY CUSTOMER DEPOSIT', {

                customerDeposit: customerDeposit.id,

                amountToApply: refundAmount,

                saved: false
            });


            log.audit('9. CONFIRMED - NO BANK DEPOSIT ACTION', {

                bankDepositLoaded: false,

                bankDepositUpdated: false,

                cashbackChanged: false,

                paymentTicked: false
            });


            log.audit('10. CONFIRMED - VARIANCE NOT UPDATED', {

                relatedNetSuiteTransactionUpdated: false,

                inactiveChanged: false
            });


        } catch (e) {

            result.stoppedAt =
                'ERROR: ' + e.message;

            log.error('DRY RUN ERROR', {
                varianceRecord: rec.id,
                message: e.message,
                stack: e.stack
            });

        } finally {

            log.audit(
                '=== CUSTOMER REFUND DRY RUN RESULT - NOTHING SAVED ===',
                result
            );
        }
    };


    return {
        afterSubmit
    };

});