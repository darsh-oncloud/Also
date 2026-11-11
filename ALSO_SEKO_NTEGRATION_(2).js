/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Shopify Payout Variance -> link the matching NetSuite transaction.
 *  - Source Type "charge" -> find Customer Deposit
 *  - Source Type "refund" -> find Customer Refund (variance amount is negative, so use the absolute value)
 *  Match on: eTail Order Id (custbody_celigo_etail_order_id) + amount
 *  Sets: custrecord_related_netsuite_transaction on the variance record
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    const SEARCH_ID = 'customsearch_shopify_payout_variance_t_2';
    const REC_TYPE = 'customrecord_celigo_shpf_payout_var_tran';
    const TARGET_FIELD = 'custrecord_related_netsuite_transaction';
    const ETAIL_ORDER_FIELD = 'custbody_celigo_etail_order_id';

    const getInputData = () => search.load({ id: SEARCH_ID });

    const map = (context) => {
        const result = JSON.parse(context.value);
        const v = result.values;
        const recId = result.id;

        const sourceType = String(v.custrecord_celigo_shpf_trans_src_type || '').toLowerCase().trim();
        const orderId = String(v.custrecord_celigo_shpf_tran_src_ordr_id || '').trim();
        const amount = Math.abs(parseFloat(v.custrecord_celigo_shpf_trans_var_amnt) || 0);

        let tranType;
        if (sourceType === 'charge') tranType = 'CustDep';
        else if (sourceType === 'refund') tranType = 'CustRfnd';
        else {
            log.audit('Skipped - unknown source type', `Rec ${recId}: ${sourceType}`);
            return;
        }

        if (!orderId || !amount) {
            log.audit('Skipped - missing order id / amount', `Rec ${recId}`);
            return;
        }

        const matches = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['type', 'anyof', tranType], 'AND',
                ['mainline', 'is', 'T'], 'AND',
                [ETAIL_ORDER_FIELD, 'is', orderId], 'AND',
                ['formulanumeric: ABS({amount})', 'equalto', amount]
            ],
            columns: ['tranid']
        }).run().each((r) => {
            matches.push({ id: r.id, tranid: r.getValue('tranid') });
            return matches.length < 5;
        });

        if (!matches.length) {
            log.audit('No match found', `Rec ${recId} | ${sourceType} | Order ${orderId} | ${amount}`);
            return;
        }
        if (matches.length > 1) {
            log.audit('Multiple matches - using first', `Rec ${recId} | ${JSON.stringify(matches)}`);
        }

        record.submitFields({
            type: REC_TYPE,
            id: recId,
            values: { [TARGET_FIELD]: matches[0].id },
            options: { enableSourcing: false, ignoreMandatoryFields: true }
        });

        log.audit('Linked', `Rec ${recId} -> ${tranType} ${matches[0].tranid} (${matches[0].id})`);
    };

    const summarize = (summary) => {
        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error(`Map error for rec ${key}`, error);
            return true;
        });
        log.audit('Done', `Usage: ${summary.usage}, Yields: ${summary.yields}`);
    };

    return { getInputData, map, summarize };
});