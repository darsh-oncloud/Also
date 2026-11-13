/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Customer Refund - fill eTail Refund ID from Shopify
 *
 * After a Customer Refund is saved (create / edit):
 *   - if eTail Refund ID is empty and eTail Order ID is filled
 *   - get that order's refunds from Shopify
 *   - pick the Shopify refund with the same amount (not already used by another NetSuite record)
 *   - write the Shopify refund ID into custbody_celigo_etail_refund_id
 *
 * Deploy on: Customer Refund
 */
define(['N/search', 'N/record', 'N/https', 'N/log'], (search, record, https, log) => {

    /* ===================== FILL IN ===================== */
    const SHOP_DOMAIN = 'your-store.myshopify.com';    // e.g. also-inc.myshopify.com
    const ACCESS_TOKEN = 'shpat_xxxxxxxxxxxxxxxxxxxx'; // Admin API access token (needs read_orders)
    const API_VERSION = '2026-10';
    /* =================================================== */

    const REFUND_ID_FIELD = 'custbody_celigo_etail_refund_id';
    const ORDER_ID_FIELD = 'custbody_celigo_etail_order_id';

    const afterSubmit = (context) => {

        if (
            context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT
        ) return;

        const rec = context.newRecord;

        try {
            const existingRefundId = rec.getValue({ fieldId: REFUND_ID_FIELD });
            const orderId = String(rec.getValue({ fieldId: ORDER_ID_FIELD }) || '').split(',')[0].trim();
            const amount = Math.abs(parseFloat(rec.getValue({ fieldId: 'total' })) || 0);

            log.audit('1. REFUND', { refundId: rec.id, orderId, amount, existingRefundId });

            if (existingRefundId) return;           // already has it
            if (!orderId || !amount) return;        // nothing to match on

            /* --- Shopify refunds for the order --- */
            const shopifyRefunds = getShopifyRefunds(orderId);
            log.audit('2. SHOPIFY REFUNDS', { orderId, shopifyRefunds });

            if (!shopifyRefunds.length) {
                log.audit('3. NO SHOPIFY REFUNDS FOUND - SKIPPED', { orderId });
                return;
            }

            /* --- don't reuse a refund ID already on another NetSuite record --- */
            const used = getUsedRefundIds(shopifyRefunds.map(r => r.id), rec.id);

            const match = shopifyRefunds.find(s =>
                used.indexOf(s.id) === -1 && Math.abs(s.amount - amount) < 0.01
            );

            if (!match) {
                log.audit('3. NO MATCHING SHOPIFY REFUND - SKIPPED', { orderId, amount, used, shopifyRefunds });
                return;
            }

            /* --- write it --- */
            const values = {};
            values[REFUND_ID_FIELD] = match.id;

            record.submitFields({
                type: rec.type,
                id: rec.id,
                values,
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });

            log.audit('3. REFUND ID SET', { refundId: rec.id, orderId, amount, shopifyRefundId: match.id });

        } catch (e) {
            log.error('SHOPIFY REFUND ID ERROR', { refundId: rec.id, message: e.message, stack: e.stack });
        }
    };

    /* ===================== HELPERS ===================== */

    const getShopifyRefunds = (orderId) => {
        const query =
            'query ($id: ID!) {' +
            '  order(id: $id) {' +
            '    refunds(first: 50) {' +
            '      id' +
            '      createdAt' +
            '      totalRefundedSet { shopMoney { amount } }' +
            '    }' +
            '  }' +
            '}';

        const resp = https.post({
            url: 'https://' + SHOP_DOMAIN + '/admin/api/' + API_VERSION + '/graphql.json',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': ACCESS_TOKEN
            },
            body: JSON.stringify({
                query,
                variables: { id: 'gid://shopify/Order/' + orderId }
            })
        });

        if (resp.code !== 200) {
            throw new Error('Shopify HTTP ' + resp.code + ': ' + resp.body);
        }

        const body = JSON.parse(resp.body);
        if (body.errors) {
            throw new Error('Shopify error: ' + JSON.stringify(body.errors));
        }

        const order = body.data && body.data.order;
        if (!order) return [];

        return (order.refunds || []).map(r => ({
            id: String(r.id).split('/').pop(),              // gid://shopify/Refund/123 -> 123
            amount: Math.abs(parseFloat(r.totalRefundedSet.shopMoney.amount) || 0),
            createdAt: r.createdAt
        }));
    };

    const getUsedRefundIds = (refundIds, currentId) => {
        if (!refundIds.length) return [];

        const idFilter = [];
        refundIds.forEach((id, i) => {
            if (i) idFilter.push('OR');
            idFilter.push([REFUND_ID_FIELD, 'is', id]);
        });

        const used = [];
        search.create({
            type: 'transaction',
            filters: [
                ['mainline', 'is', 'T'],
                'AND', ['type', 'anyof', 'CustRfnd', 'CashRfnd', 'CustCred'],
                'AND', ['internalid', 'noneof', currentId],
                'AND', idFilter
            ],
            columns: [REFUND_ID_FIELD]
        }).run().each(r => {
            used.push(String(r.getValue(REFUND_ID_FIELD)));
            return true;
        });

        return used;
    };

    return { afterSubmit };
});
