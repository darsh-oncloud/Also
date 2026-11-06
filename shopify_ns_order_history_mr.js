/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * SHOPIFY <-> NETSUITE ORDER HISTORY RECONCILIATION
 * --------------------------------------------------
 * For every Sales Order (hardcoded IDs in DRY RUN, saved search in LIVE):
 *   1. Loads the NetSuite Sales Order (header + lines)
 *   2. Walks every related NetSuite transaction (Item Fulfillment, Invoice, Cash Sale,
 *      Customer Deposit, Deposit Application, Customer Payment, Credit Memo, Cash Refund,
 *      Customer Refund, Return Authorization, Item Receipt) through "created from" and
 *      "applied to" links, several levels deep
 *   3. Calls the Shopify Admin GraphQL API for the same order: header, totals, line items,
 *      fulfillments, refunds (line level), returns, payment transactions, timeline events
 *   4. Compares both sides (amounts + item quantities) and lists every mismatch
 *   5. Writes the full history into one Long Text field on the Sales Order
 *
 * NO SCRIPT PARAMETERS. Everything is hardcoded in CONFIG below.
 *
 * DRY RUN  : processes CONFIG.DRY_RUN_SO_IDS only, writes the full text to the Execution Log
 *            (field is NOT updated unless DRY_RUN_WRITE_FIELD = true)
 * LIVE     : processes every Sales Order returned by CONFIG.SAVED_SEARCH_ID and writes the field
 */
define(['N/search', 'N/record', 'N/https', 'N/log', 'N/runtime'], (search, record, https, log, runtime) => {

    // ============================================================================
    // CONFIG  -  EVERYTHING HARDCODED HERE
    // ============================================================================
    const CONFIG = {
        // ---- Mode ----
        DRY_RUN: true,                       // true = only DRY_RUN_SO_IDS, false = LIVE (saved search)
        DRY_RUN_SO_IDS: [1234567, 2345678],  // NetSuite Sales Order INTERNAL IDs for the dry run
        DRY_RUN_WRITE_FIELD: false,          // true = also write the long text field during dry run
        // Optional: force a Shopify order for a dry-run SO (if the SO field is empty / wrong)
        // key = SO internal id, value = Shopify order id (numeric) or order name (#1234)
        DRY_RUN_SHOPIFY_OVERRIDE: {
            // '1234567': '5123456789012',
            // '2345678': '#100234'
        },

        // ---- LIVE input ----
        SAVED_SEARCH_ID: 'customsearch_shopify_refund_mismatch', // your 500-order search (Sales Order search)

        // ---- NetSuite fields ----
        RESULT_FIELD_ID: 'custbody_shopify_ns_order_history',    // NEW Long Text body field on Sales Order
        SO_SHOPIFY_ORDER_ID_FIELD: 'custbody_shopify_order_id',  // SO field holding Shopify order id or name (#1234)
        SO_LINE_SHOPIFY_LINE_ID_FIELD: '',                       // optional SO line column holding Shopify line item id (e.g. 'custcol_shopify_line_id')

        // ---- Shopify ----
        SHOPIFY_SHOP_DOMAIN: 'your-store.myshopify.com',
        SHOPIFY_ACCESS_TOKEN: 'shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        SHOPIFY_API_VERSION: '2026-07',

        // ---- Limits ----
        MAX_LINK_LEVELS: 5,          // how deep to follow created-from / applied-to links
        MAX_RELATED_TXNS: 300,       // safety cap per order
        MAX_TEXT_LENGTH: 990000,     // long text field max is 1,000,000
        AMOUNT_TOLERANCE: 0.01
    };

    // ============================================================================
    // CONSTANTS / HELPERS
    // ============================================================================
    const NS_TYPES = {
        SalesOrd: 'Sales Order',
        ItemShip: 'Item Fulfillment',
        CustInvc: 'Invoice',
        CashSale: 'Cash Sale',
        CustDep: 'Customer Deposit',
        DepAppl: 'Deposit Application',
        CustPymt: 'Customer Payment',
        CustCred: 'Credit Memo',
        CashRfnd: 'Cash Refund',
        CustRfnd: 'Customer Refund',
        RtnAuth: 'Return Authorization',
        ItemRcpt: 'Item Receipt'
    };
    const RELATED_TYPE_IDS = Object.keys(NS_TYPES).filter(t => t !== 'SalesOrd');
    const NON_QTY_ITEM_TYPES = ['Discount', 'Subtotal', 'Description', 'Markup', 'Payment', 'EndGroup', 'ShipItem', 'TaxItem', 'TaxGroup'];

    const tol = CONFIG.AMOUNT_TOLERANCE;
    const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
    const money = v => num(v).toFixed(2);
    const pad = (s, n) => { s = String(s == null ? '' : s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
    const gidNum = g => String(g || '').split('/').pop();
    const shopMoney = set => (set && set.shopMoney) ? num(set.shopMoney.amount) : 0;
    const sDate = d => d ? String(d).substring(0, 19).replace('T', ' ') : '';
    const busyWait = ms => { const end = Date.now() + ms; while (Date.now() < end) { /* wait */ } };
    const normKey = s => {
        s = String(s || '').trim();
        if (s.indexOf(' : ') > -1) s = s.split(' : ').pop();
        return s.toUpperCase();
    };
    const stripHtml = s => String(s || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
    const pickValue = v => {
        if (v == null) return '';
        if (Array.isArray(v)) return v.length ? String(v[0].value || v[0].text || '') : '';
        if (typeof v === 'object') return String(v.value || v.text || '');
        return String(v);
    };
    const chunkArr = (arr, size) => {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    };
    const recVal = (rec, f) => { try { return rec.getValue({ fieldId: f }); } catch (e) { return ''; } };
    const recText = (rec, f) => { try { return rec.getText({ fieldId: f }); } catch (e) { return ''; } };
    const lineVal = (rec, f, i) => { try { return rec.getSublistValue({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return ''; } };
    const lineText = (rec, f, i) => { try { return rec.getSublistText({ sublistId: 'item', fieldId: f, line: i }); } catch (e) { return ''; } };

    function logLong(title, text) {
        const parts = [];
        for (let i = 0; i < text.length; i += 3900) parts.push(text.substring(i, i + 3900));
        parts.forEach((p, idx) => log.audit(`${title} [${idx + 1}/${parts.length}]`, p));
    }

    // ============================================================================
    // NETSUITE DATA
    // ============================================================================
    function getNetSuiteData(soId) {
        const so = record.load({ type: record.Type.SALES_ORDER, id: soId });

        const header = {
            id: String(soId),
            tranid: recVal(so, 'tranid'),
            trandate: recText(so, 'trandate'),
            status: recVal(so, 'status') || recText(so, 'orderstatus'),
            customer: recText(so, 'entity'),
            currency: recText(so, 'currency'),
            total: num(recVal(so, 'total')),
            otherrefnum: recVal(so, 'otherrefnum'),
            shopifyRef: CONFIG.SO_SHOPIFY_ORDER_ID_FIELD ? String(recVal(so, CONFIG.SO_SHOPIFY_ORDER_ID_FIELD) || '') : ''
        };

        const lines = [];
        const n = so.getLineCount({ sublistId: 'item' });
        for (let i = 0; i < n; i++) {
            const closedRaw = lineVal(so, 'isclosed', i);
            lines.push({
                line: lineVal(so, 'line', i),
                item: lineText(so, 'item', i),
                itemType: lineVal(so, 'itemtype', i),
                qty: num(lineVal(so, 'quantity', i)),
                fulfilled: num(lineVal(so, 'quantityfulfilled', i)),
                billed: num(lineVal(so, 'quantitybilled', i)),
                committed: num(lineVal(so, 'quantitycommitted', i)),
                rate: lineVal(so, 'rate', i),
                amount: num(lineVal(so, 'amount', i)),
                closed: closedRaw === true || closedRaw === 'T',
                shopifyLineId: CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD ? String(lineVal(so, CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD, i) || '') : ''
            });
        }

        const relatedIds = findRelatedIds(soId);
        const txns = loadTxnHeaders(relatedIds);
        loadTxnLines(txns);
        loadTxnLinks(txns);

        return { header, lines, txns };
    }

    function collectIds(filterExpr, into) {
        try {
            search.create({
                type: search.Type.TRANSACTION,
                filters: filterExpr.concat(['AND', ['type', 'anyof', RELATED_TYPE_IDS]]),
                columns: ['internalid']
            }).run().each(r => { into.add(String(r.id)); return true; });
        } catch (e) {
            log.debug('collectIds skipped', JSON.stringify(filterExpr) + ' :: ' + e.message);
        }
    }

    // Walks: SO -> (created from / applied to) -> children -> grandchildren ...
    function findRelatedIds(soId) {
        const seen = new Set([String(soId)]);
        const related = new Set();
        let frontier = [String(soId)];

        // Customer Deposits linked by the "Sales Order" field
        const deposits = new Set();
        collectIds([['salesorder', 'anyof', String(soId)]], deposits);

        for (let level = 0; level < CONFIG.MAX_LINK_LEVELS && frontier.length; level++) {
            const found = new Set(level === 0 ? Array.from(deposits) : []);
            collectIds([['createdfrom', 'anyof', frontier]], found);
            collectIds([['appliedtotransaction', 'anyof', frontier]], found);

            const next = [];
            found.forEach(id => {
                if (!seen.has(id)) { seen.add(id); related.add(id); next.push(id); }
            });
            if (related.size >= CONFIG.MAX_RELATED_TXNS) break;
            frontier = next;
        }
        return Array.from(related);
    }

    function loadTxnHeaders(ids) {
        const txns = {};
        chunkArr(ids, 1000).forEach(chunk => {
            search.create({
                type: search.Type.TRANSACTION,
                filters: [['internalid', 'anyof', chunk], 'AND', ['mainline', 'is', 'T']],
                columns: ['internalid', 'type', 'tranid', 'trandate', 'statusref', 'fxamount',
                    'amountremaining', 'createdfrom', 'memo', 'currency']
            }).run().each(r => {
                txns[r.id] = {
                    id: String(r.id),
                    type: r.getValue('type'),
                    typeText: NS_TYPES[r.getValue('type')] || r.getText('type'),
                    tranid: r.getValue('tranid'),
                    trandate: r.getValue('trandate'),
                    status: r.getText('statusref') || r.getValue('statusref'),
                    amount: Math.abs(num(r.getValue('fxamount'))),
                    remaining: num(r.getValue('amountremaining')),
                    createdFrom: r.getText('createdfrom'),
                    memo: r.getValue('memo'),
                    currency: r.getText('currency'),
                    lines: [],
                    links: []
                };
                return true;
            });
        });
        return txns;
    }

    function loadTxnLines(txns) {
        const ids = Object.keys(txns);
        if (!ids.length) return;
        const cols = ['internalid', 'line', 'item', 'quantity', 'fxamount', 'memo'];
        if (CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD) cols.push(CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD);
        chunkArr(ids, 1000).forEach(chunk => {
            try {
                search.create({
                    type: search.Type.TRANSACTION,
                    filters: [
                        ['internalid', 'anyof', chunk], 'AND',
                        ['mainline', 'is', 'F'], 'AND',
                        ['taxline', 'is', 'F'], 'AND',
                        ['cogs', 'is', 'F'], 'AND',
                        ['shipping', 'is', 'F'], 'AND',
                        ['item', 'noneof', '@NONE@']
                    ],
                    columns: cols
                }).run().each(r => {
                    const t = txns[r.id];
                    if (t) {
                        t.lines.push({
                            line: r.getValue('line'),
                            item: r.getText('item'),
                            qty: Math.abs(num(r.getValue('quantity'))),
                            amount: Math.abs(num(r.getValue('fxamount'))),
                            memo: r.getValue('memo'),
                            shopifyLineId: CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD ? r.getValue(CONFIG.SO_LINE_SHOPIFY_LINE_ID_FIELD) : ''
                        });
                    }
                    return true;
                });
            } catch (e) {
                log.error('loadTxnLines', e.message);
            }
        });
    }

    function loadTxnLinks(txns) {
        const ids = Object.keys(txns);
        if (!ids.length) return;
        chunkArr(ids, 1000).forEach(chunk => {
            try {
                const dedupe = {};
                search.create({
                    type: search.Type.TRANSACTION,
                    filters: [['internalid', 'anyof', chunk], 'AND', ['appliedtotransaction', 'noneof', '@NONE@']],
                    columns: ['internalid', 'appliedtotransaction', 'appliedtolinkamount', 'appliedtolinktype']
                }).run().each(r => {
                    const key = r.id + '|' + r.getValue('appliedtotransaction') + '|' + r.getValue('appliedtolinkamount');
                    if (!dedupe[key] && txns[r.id]) {
                        dedupe[key] = true;
                        txns[r.id].links.push({
                            to: r.getText('appliedtotransaction'),
                            toId: r.getValue('appliedtotransaction'),
                            amount: Math.abs(num(r.getValue('appliedtolinkamount'))),
                            linkType: r.getText('appliedtolinktype') || r.getValue('appliedtolinktype')
                        });
                    }
                    return true;
                });
            } catch (e) {
                log.error('loadTxnLinks', e.message);
            }
        });
    }

    // ============================================================================
    // SHOPIFY DATA (Admin GraphQL API)
    // ============================================================================
    const MONEY_FRAGMENT = 'fragment M on MoneyBag { shopMoney { amount currencyCode } }';

    const Q_FIND_BY_NAME = `query($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;

    const Q_ORDER = `query($id: ID!) {
      order(id: $id) {
        id legacyResourceId name createdAt processedAt updatedAt closedAt cancelledAt cancelReason
        displayFinancialStatus displayFulfillmentStatus test tags note currencyCode
        subtotalPriceSet { ...M } totalPriceSet { ...M } currentTotalPriceSet { ...M }
        totalRefundedSet { ...M } totalReceivedSet { ...M } netPaymentSet { ...M }
        totalOutstandingSet { ...M } totalShippingPriceSet { ...M } totalTaxSet { ...M } totalDiscountsSet { ...M }
        fulfillments(first: 50) { id name status displayStatus createdAt }
        refunds(first: 50) { id createdAt }
        transactions(first: 100) {
          id kind status gateway createdAt processedAt errorCode
          amountSet { ...M } parentTransaction { id }
        }
      }
    } ${MONEY_FRAGMENT}`;

    const Q_LINES = `query($id: ID!, $after: String) {
      order(id: $id) {
        lineItems(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name sku quantity currentQuantity refundableQuantity unfulfilledQuantity nonFulfillableQuantity
            originalUnitPriceSet { ...M } originalTotalSet { ...M } discountedTotalSet { ...M }
          }
        }
      }
    } ${MONEY_FRAGMENT}`;

    const Q_EVENTS = `query($id: ID!, $after: String) {
      order(id: $id) {
        events(first: 100, after: $after, sortKey: CREATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { id createdAt message appTitle attributeToApp attributeToUser ... on BasicEvent { action subjectType } }
        }
      }
    }`;

    const Q_RETURNS = `query($id: ID!) {
      order(id: $id) { returns(first: 25) { nodes { id name status totalQuantity } } }
    }`;

    const Q_FULFILLMENT = `query($id: ID!) {
      fulfillment(id: $id) {
        id name status displayStatus createdAt
        trackingInfo(first: 5) { company number }
        fulfillmentLineItems(first: 100) { nodes { id quantity lineItem { id sku name } } }
      }
    }`;

    const Q_REFUND = `query($id: ID!) {
      refund(id: $id) {
        id createdAt note
        totalRefundedSet { ...M }
        refundLineItems(first: 100) {
          nodes { quantity restockType restocked lineItem { id sku name } subtotalSet { ...M } totalTaxSet { ...M } }
        }
        transactions(first: 20) {
          nodes { id kind status gateway processedAt amountSet { ...M } }
        }
      }
    } ${MONEY_FRAGMENT}`;

    function shopifyGql(query, variables) {
        const url = `https://${CONFIG.SHOPIFY_SHOP_DOMAIN}/admin/api/${CONFIG.SHOPIFY_API_VERSION}/graphql.json`;
        for (let attempt = 1; attempt <= 5; attempt++) {
            const resp = https.post({
                url: url,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Shopify-Access-Token': CONFIG.SHOPIFY_ACCESS_TOKEN
                },
                body: JSON.stringify({ query: query, variables: variables || {} })
            });

            if (resp.code === 429 || resp.code >= 500) { busyWait(2000 * attempt); continue; }
            if (resp.code !== 200) throw new Error(`Shopify HTTP ${resp.code}: ${String(resp.body).substring(0, 500)}`);

            const body = JSON.parse(resp.body);
            if (body.errors && body.errors.length) {
                const throttled = body.errors.some(e => e.extensions && e.extensions.code === 'THROTTLED');
                if (throttled) { busyWait(2000 * attempt); continue; }
                throw new Error('Shopify GraphQL: ' + body.errors.map(e => e.message).join(' | '));
            }
            // slow down if the bucket is getting low
            try {
                const ts = body.extensions.cost.throttleStatus;
                if (ts.currentlyAvailable < 200) busyWait(1500);
            } catch (e) { /* ignore */ }
            return body.data;
        }
        throw new Error('Shopify API still throttled after 5 attempts');
    }

    function resolveShopifyGid(ref) {
        ref = String(ref || '').trim();
        if (!ref) throw new Error('Empty Shopify order reference');
        if (ref.indexOf('gid://') === 0) return ref;
        if (/^\d{10,}$/.test(ref)) return 'gid://shopify/Order/' + ref; // numeric Shopify order id
        const name = /^\d+$/.test(ref) ? '#' + ref : ref;                // order name like #1234
        const d = shopifyGql(Q_FIND_BY_NAME, { q: `name:${name}` });
        const node = d && d.orders && d.orders.nodes && d.orders.nodes[0];
        if (!node) throw new Error('Shopify order not found by name: ' + name);
        return node.id;
    }

    function paginate(query, gid, connName) {
        const out = [];
        let after = null;
        for (let page = 0; page < 20; page++) {
            const d = shopifyGql(query, { id: gid, after: after });
            const conn = d && d.order && d.order[connName];
            if (!conn) break;
            (conn.nodes || []).forEach(n => out.push(n));
            if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
            after = conn.pageInfo.endCursor;
        }
        return out;
    }

    function getShopifyOrder(ref) {
        const gid = resolveShopifyGid(ref);
        const d = shopifyGql(Q_ORDER, { id: gid });
        if (!d || !d.order) throw new Error(`Shopify order not found: ${ref} (${gid})`);
        const o = d.order;

        o.lineItems = paginate(Q_LINES, gid, 'lineItems');

        o.events = [];
        try { o.events = paginate(Q_EVENTS, gid, 'events'); } catch (e) { o.eventsError = e.message; }

        o.returnList = [];
        try {
            const r = shopifyGql(Q_RETURNS, { id: gid });
            o.returnList = (r.order && r.order.returns && r.order.returns.nodes) || [];
        } catch (e) { o.returnsError = e.message; }

        o.fulfillmentDetails = (o.fulfillments || []).map(f => {
            try { return shopifyGql(Q_FULFILLMENT, { id: f.id }).fulfillment || f; }
            catch (e) { return Object.assign({ error: e.message }, f); }
        });

        o.refundDetails = (o.refunds || []).map(rf => {
            try { return shopifyGql(Q_REFUND, { id: rf.id }).refund || rf; }
            catch (e) { return Object.assign({ error: e.message }, rf); }
        });

        return o;
    }

    // ============================================================================
    // ANALYSIS
    // ============================================================================
    function analyze(ns, shop) {
        const flags = [];
        const txnList = Object.values(ns.txns);
        const counts = {};
        txnList.forEach(t => { counts[t.type] = (counts[t.type] || 0) + 1; });
        const sumType = types => txnList.filter(t => types.indexOf(t.type) > -1).reduce((a, t) => a + t.amount, 0);

        const amounts = {
            nsSoTotal: ns.header.total,
            nsInvoices: sumType(['CustInvc']),
            nsCashSales: sumType(['CashSale']),
            nsDeposits: sumType(['CustDep']),
            nsPayments: sumType(['CustPymt']),
            nsDepositApps: sumType(['DepAppl']),
            nsCreditMemos: sumType(['CustCred']),
            nsCashRefunds: sumType(['CashRfnd']),
            nsCustRefunds: sumType(['CustRfnd'])
        };
        amounts.nsRefundDocs = amounts.nsCreditMemos + amounts.nsCashRefunds;
        amounts.nsNetCash = amounts.nsDeposits + amounts.nsPayments + amounts.nsCashSales
            - amounts.nsCustRefunds - amounts.nsCashRefunds;

        const status = String(ns.header.status || '');
        const soOpen = !/closed|billed|cancel/i.test(status);

        // ---- item comparison ----
        const items = {};
        const get = k => items[k] || (items[k] = {
            s: { ordered: 0, current: 0, fulfilled: 0, refunded: 0 },
            n: { ordered: 0, fulfilled: 0, billed: 0, open: 0, credited: 0, rma: 0, received: 0 },
            inShop: false, inNs: false
        });

        if (shop) {
            const lineKey = {};
            (shop.lineItems || []).forEach(li => {
                const k = normKey(li.sku || li.name);
                lineKey[li.id] = k;
                const it = get(k); it.inShop = true;
                it.s.ordered += num(li.quantity);
                it.s.current += num(li.currentQuantity);
            });
            (shop.fulfillmentDetails || []).forEach(f => {
                if (/CANCEL|ERROR|FAILURE/i.test(f.status || '')) return;
                ((f.fulfillmentLineItems && f.fulfillmentLineItems.nodes) || []).forEach(fl => {
                    const k = (fl.lineItem && lineKey[fl.lineItem.id]) || normKey(fl.lineItem && (fl.lineItem.sku || fl.lineItem.name));
                    get(k).s.fulfilled += num(fl.quantity);
                });
            });
            (shop.refundDetails || []).forEach(rf => {
                ((rf.refundLineItems && rf.refundLineItems.nodes) || []).forEach(rl => {
                    const k = (rl.lineItem && lineKey[rl.lineItem.id]) || normKey(rl.lineItem && (rl.lineItem.sku || rl.lineItem.name));
                    get(k).s.refunded += num(rl.quantity);
                });
            });
        }

        ns.lines.forEach(l => {
            if (NON_QTY_ITEM_TYPES.indexOf(l.itemType) > -1) return;
            const it = get(normKey(l.item)); it.inNs = true;
            it.n.ordered += l.qty;
            it.n.fulfilled += l.fulfilled;
            it.n.billed += l.billed;
            if (!l.closed) it.n.open += Math.max(0, l.qty - l.fulfilled);
        });
        txnList.forEach(t => {
            t.lines.forEach(l => {
                const k = normKey(l.item);
                if (!items[k]) return; // ignore discount / non-order items
                if (t.type === 'CustCred' || t.type === 'CashRfnd') items[k].n.credited += l.qty;
                if (t.type === 'RtnAuth') items[k].n.rma += l.qty;
                if (t.type === 'ItemRcpt') items[k].n.received += l.qty;
            });
        });

        // ---- flags ----
        if (shop) {
            const shopRefunded = shopMoney(shop.totalRefundedSet);
            const fin = shop.displayFinancialStatus || '';

            if (shopRefunded > tol && !counts.CustCred && !counts.CashRfnd) {
                flags.push(`Shopify refunded ${money(shopRefunded)} but NetSuite has NO Credit Memo / Cash Refund.`);
            }
            if (amounts.nsCustRefunds > tol && !counts.CustCred) {
                flags.push(`Customer Refund(s) total ${money(amounts.nsCustRefunds)} exist WITHOUT a Credit Memo (refund likely issued straight against the Customer Deposit).`);
            }
            if (Math.abs(shopRefunded - amounts.nsRefundDocs) > tol) {
                flags.push(`Refund amount mismatch: Shopify refunded ${money(shopRefunded)} vs NetSuite Credit Memo + Cash Refund ${money(amounts.nsRefundDocs)} (diff ${money(shopRefunded - amounts.nsRefundDocs)}).`);
            }
            if (Math.abs(shopRefunded - amounts.nsCustRefunds - amounts.nsCashRefunds) > tol) {
                flags.push(`Money-out mismatch: Shopify refunded ${money(shopRefunded)} vs NetSuite Customer Refund + Cash Refund ${money(amounts.nsCustRefunds + amounts.nsCashRefunds)}.`);
            }
            const shopNet = shopMoney(shop.netPaymentSet);
            if (Math.abs(shopNet - amounts.nsNetCash) > tol) {
                flags.push(`Net payment mismatch: Shopify net payment ${money(shopNet)} vs NetSuite net cash ${money(amounts.nsNetCash)} (deposits + payments + cash sales - customer refunds - cash refunds).`);
            }
            if ((fin === 'REFUNDED' || shop.cancelledAt) && soOpen) {
                flags.push(`Shopify order is ${shop.cancelledAt ? 'CANCELLED / ' : ''}${fin} but NetSuite Sales Order is still "${status}".`);
            }
            if (fin === 'PARTIALLY_REFUNDED' && soOpen) {
                flags.push(`Shopify order is PARTIALLY_REFUNDED and NetSuite Sales Order is "${status}" - check open lines below.`);
            }
        }

        txnList.forEach(t => {
            if (t.type === 'CustDep' && t.remaining > tol) flags.push(`Customer Deposit ${t.tranid} has unapplied amount ${money(t.remaining)} (status: ${t.status}).`);
            if (t.type === 'CustCred' && t.remaining > tol) flags.push(`Credit Memo ${t.tranid} has unapplied amount ${money(t.remaining)} (status: ${t.status}).`);
            if (t.type === 'CustInvc' && t.remaining > tol) flags.push(`Invoice ${t.tranid} still open, amount remaining ${money(t.remaining)}.`);
        });

        Object.keys(items).forEach(k => {
            const it = items[k];
            if (shop && it.inShop && !it.inNs) flags.push(`Item ${k} is on Shopify order but not on NetSuite SO.`);
            if (shop && it.inNs && !it.inShop) flags.push(`Item ${k} is on NetSuite SO but not on Shopify order (check SKU vs item name).`);
            if (!shop || !it.inShop || !it.inNs) return;
            if (it.s.fulfilled !== it.n.fulfilled) flags.push(`Item ${k}: fulfilled qty Shopify ${it.s.fulfilled} vs NetSuite ${it.n.fulfilled}.`);
            if (it.s.refunded !== it.n.credited) flags.push(`Item ${k}: refunded qty Shopify ${it.s.refunded} vs NetSuite credited qty ${it.n.credited}.`);
            const shopRemaining = Math.max(0, it.s.current - it.s.fulfilled);
            if (it.n.open > 0 && shopRemaining === 0) flags.push(`Item ${k}: NetSuite line still open for ${it.n.open} but nothing left to fulfil in Shopify (refunded/removed).`);
        });

        return { flags, counts, amounts, items, soOpen };
    }

    // ============================================================================
    // TEXT BUILDER
    // ============================================================================
    function buildText(ns, shop, shopErr, a) {
        const L = [];
        const H = ns.header;

        L.push('==================== SHOPIFY / NETSUITE ORDER HISTORY ====================');
        L.push(`Generated: ${new Date().toISOString()} | Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
        L.push(`NetSuite SO: ${H.tranid} (id ${H.id}) | Status: ${H.status} | Shopify ref: ${H.shopifyRef || '-'}`);
        if (shop) L.push(`Shopify Order: ${shop.name} (id ${shop.legacyResourceId}) | Financial: ${shop.displayFinancialStatus} | Fulfillment: ${shop.displayFulfillmentStatus}${shop.cancelledAt ? ' | CANCELLED ' + sDate(shop.cancelledAt) : ''}`);
        if (shopErr) L.push(`Shopify ERROR: ${shopErr}`);
        L.push('');

        // ---- flags ----
        L.push(`---------- MISMATCHES / FLAGS (${a.flags.length}) ----------`);
        if (!a.flags.length) L.push('No mismatches detected.');
        a.flags.forEach((f, i) => L.push(`${i + 1}. ${f}`));
        L.push('');

        // ---- counts ----
        L.push('---------- NETSUITE RECORD COUNTS ----------');
        const totalRel = Object.values(a.counts).reduce((x, y) => x + y, 0);
        L.push(`Total related transactions: ${totalRel}`);
        Object.keys(a.counts).forEach(t => L.push(`  ${pad(NS_TYPES[t] || t, 22)}: ${a.counts[t]}`));
        L.push('');

        // ---- amounts ----
        L.push('---------- AMOUNTS ----------');
        if (shop) {
            L.push(`Shopify  Original total     : ${money(shopMoney(shop.totalPriceSet))} ${shop.currencyCode || ''}`);
            L.push(`Shopify  Current total      : ${money(shopMoney(shop.currentTotalPriceSet))}`);
            L.push(`Shopify  Total received     : ${money(shopMoney(shop.totalReceivedSet))}`);
            L.push(`Shopify  Total refunded     : ${money(shopMoney(shop.totalRefundedSet))}`);
            L.push(`Shopify  Net payment        : ${money(shopMoney(shop.netPaymentSet))}`);
            L.push(`Shopify  Outstanding        : ${money(shopMoney(shop.totalOutstandingSet))}`);
            L.push(`Shopify  Shipping / Tax / Disc: ${money(shopMoney(shop.totalShippingPriceSet))} / ${money(shopMoney(shop.totalTaxSet))} / ${money(shopMoney(shop.totalDiscountsSet))}`);
        }
        L.push(`NetSuite SO total           : ${money(a.amounts.nsSoTotal)} ${H.currency || ''}`);
        L.push(`NetSuite Invoices           : ${money(a.amounts.nsInvoices)}`);
        L.push(`NetSuite Cash Sales         : ${money(a.amounts.nsCashSales)}`);
        L.push(`NetSuite Customer Deposits  : ${money(a.amounts.nsDeposits)}`);
        L.push(`NetSuite Deposit Applications: ${money(a.amounts.nsDepositApps)}`);
        L.push(`NetSuite Customer Payments  : ${money(a.amounts.nsPayments)}`);
        L.push(`NetSuite Credit Memos       : ${money(a.amounts.nsCreditMemos)}`);
        L.push(`NetSuite Cash Refunds       : ${money(a.amounts.nsCashRefunds)}`);
        L.push(`NetSuite Customer Refunds   : ${money(a.amounts.nsCustRefunds)}`);
        L.push(`NetSuite Net cash           : ${money(a.amounts.nsNetCash)}`);
        L.push('');

        // ---- item comparison ----
        L.push('---------- ITEM COMPARISON (qty) ----------');
        L.push(`${pad('ITEM/SKU', 28)} | SHOPIFY ord/curr/fulf/refd | NETSUITE ord/fulf/bill/open/cred/rma/rcvd`);
        Object.keys(a.items).forEach(k => {
            const s = a.items[k].s, n = a.items[k].n;
            L.push(`${pad(k, 28)} | ${pad(`${s.ordered}/${s.current}/${s.fulfilled}/${s.refunded}`, 26)} | ${n.ordered}/${n.fulfilled}/${n.billed}/${n.open}/${n.credited}/${n.rma}/${n.received}`);
        });
        L.push('');

        // ---- Shopify detail ----
        if (shop) {
            L.push('==================== SHOPIFY DETAIL (times UTC) ====================');
            L.push(`Order ${shop.name} | id ${shop.legacyResourceId} | created ${sDate(shop.createdAt)} | processed ${sDate(shop.processedAt)} | updated ${sDate(shop.updatedAt)} | closed ${sDate(shop.closedAt) || '-'}`);
            if (shop.cancelledAt) L.push(`Cancelled ${sDate(shop.cancelledAt)} reason ${shop.cancelReason}`);
            if (shop.tags && shop.tags.length) L.push(`Tags: ${shop.tags.join(', ')}`);
            if (shop.note) L.push(`Note: ${shop.note}`);
            L.push('');

            L.push(`---- Line items (${shop.lineItems.length}) ----`);
            shop.lineItems.forEach(li => {
                L.push(`LineID ${gidNum(li.id)} | SKU ${li.sku || '-'} | ${li.name} | qty ${li.quantity} | current ${li.currentQuantity} | refundable ${li.refundableQuantity} | unfulfilled ${li.unfulfilledQuantity} | unit ${money(shopMoney(li.originalUnitPriceSet))} | line total ${money(shopMoney(li.originalTotalSet))} | after disc ${money(shopMoney(li.discountedTotalSet))}`);
            });
            L.push('');

            L.push(`---- Fulfillments (${shop.fulfillmentDetails.length}) ----`);
            shop.fulfillmentDetails.forEach(f => {
                const trk = (f.trackingInfo || []).map(t => `${t.company || ''} ${t.number || ''}`.trim()).join(', ');
                L.push(`Fulfillment ${f.name || gidNum(f.id)} (id ${gidNum(f.id)}) | ${sDate(f.createdAt)} | status ${f.status} / ${f.displayStatus || ''}${trk ? ' | tracking ' + trk : ''}${f.error ? ' | ERROR ' + f.error : ''}`);
                ((f.fulfillmentLineItems && f.fulfillmentLineItems.nodes) || []).forEach(fl => {
                    L.push(`    LineID ${gidNum(fl.lineItem && fl.lineItem.id)} | SKU ${(fl.lineItem && fl.lineItem.sku) || '-'} | ${(fl.lineItem && fl.lineItem.name) || ''} | qty ${fl.quantity}`);
                });
            });
            L.push('');

            L.push(`---- Refunds (${shop.refundDetails.length}) ----`);
            shop.refundDetails.forEach(rf => {
                const total = shopMoney(rf.totalRefundedSet);
                L.push(`Refund id ${gidNum(rf.id)} | ${sDate(rf.createdAt)} | amount ${money(total)}${rf.note ? ' | note: ' + rf.note : ''}${rf.error ? ' | ERROR ' + rf.error : ''}`);
                let lineSum = 0;
                ((rf.refundLineItems && rf.refundLineItems.nodes) || []).forEach(rl => {
                    const sub = shopMoney(rl.subtotalSet), tax = shopMoney(rl.totalTaxSet);
                    lineSum += sub + tax;
                    L.push(`    LineID ${gidNum(rl.lineItem && rl.lineItem.id)} | SKU ${(rl.lineItem && rl.lineItem.sku) || '-'} | ${(rl.lineItem && rl.lineItem.name) || ''} | qty ${rl.quantity} | restock ${rl.restockType}${rl.restocked ? ' (restocked)' : ''} | subtotal ${money(sub)} | tax ${money(tax)}`);
                });
                const other = total - lineSum;
                if (Math.abs(other) > tol) L.push(`    Other (shipping / adjustment / amount-only refund): ${money(other)}`);
                ((rf.transactions && rf.transactions.nodes) || []).forEach(tx => {
                    L.push(`    Txn ${gidNum(tx.id)} | ${tx.kind} | ${tx.status} | ${tx.gateway} | ${sDate(tx.processedAt)} | ${money(shopMoney(tx.amountSet))}`);
                });
            });
            L.push('');

            L.push(`---- Returns (${shop.returnList.length}) ----`);
            if (shop.returnsError) L.push(`(returns not read: ${shop.returnsError})`);
            shop.returnList.forEach(r => L.push(`Return ${r.name} (id ${gidNum(r.id)}) | status ${r.status} | total qty ${r.totalQuantity}`));
            L.push('');

            L.push(`---- Payment transactions (${(shop.transactions || []).length}) ----`);
            (shop.transactions || []).forEach(tx => {
                L.push(`${sDate(tx.processedAt || tx.createdAt)} | id ${gidNum(tx.id)} | ${tx.kind} | ${tx.status} | ${tx.gateway} | ${money(shopMoney(tx.amountSet))}${tx.parentTransaction ? ' | parent ' + gidNum(tx.parentTransaction.id) : ''}${tx.errorCode ? ' | error ' + tx.errorCode : ''}`);
            });
            L.push('');

            L.push(`---- Timeline events (${shop.events.length}) ----`);
            if (shop.eventsError) L.push(`(events not read: ${shop.eventsError})`);
            shop.events.forEach(ev => {
                const who = ev.appTitle ? ` [${ev.appTitle}]` : '';
                const act = ev.action ? ` (${ev.action})` : '';
                L.push(`${sDate(ev.createdAt)}${who}${act} ${stripHtml(ev.message)}`);
            });
            L.push('');
        }

        // ---- NetSuite detail ----
        L.push('==================== NETSUITE DETAIL ====================');
        L.push(`Sales Order ${H.tranid} | id ${H.id} | ${H.trandate} | ${H.customer} | status ${H.status} | total ${money(H.total)} ${H.currency || ''} | PO/ref ${H.otherrefnum || '-'}`);
        L.push('---- SO lines ----');
        ns.lines.forEach(l => {
            L.push(`Line ${l.line} | ${l.item} (${l.itemType}) | qty ${l.qty} | fulfilled ${l.fulfilled} | billed ${l.billed} | committed ${l.committed} | rate ${l.rate} | amount ${money(l.amount)} | ${l.closed ? 'CLOSED' : 'OPEN'}${l.shopifyLineId ? ' | Shopify line ' + l.shopifyLineId : ''}`);
        });
        L.push('');

        const txnList = Object.values(ns.txns).sort((x, y) => num(x.id) - num(y.id));
        L.push(`---- Related transactions (${txnList.length}) ----`);
        txnList.forEach(t => {
            L.push(`[${t.typeText}] ${t.tranid || '-'} | id ${t.id} | ${t.trandate} | status ${t.status} | amount ${money(t.amount)}${t.remaining > tol ? ' | remaining ' + money(t.remaining) : ''} | created from ${t.createdFrom || '-'}${t.memo ? ' | memo: ' + t.memo : ''}`);
            t.lines.forEach(l => {
                L.push(`    Line ${l.line} | ${l.item} | qty ${l.qty} | amount ${money(l.amount)}${l.shopifyLineId ? ' | Shopify line ' + l.shopifyLineId : ''}${l.memo ? ' | ' + l.memo : ''}`);
            });
            t.links.forEach(k => {
                L.push(`    Applied to ${k.to} (id ${k.toId}) | ${money(k.amount)}${k.linkType ? ' | ' + k.linkType : ''}`);
            });
        });
        L.push('');
        L.push('==================== END ====================');

        return L.join('\n');
    }

    function writeField(soId, text) {
        try {
            record.submitFields({
                type: record.Type.SALES_ORDER,
                id: soId,
                values: { [CONFIG.RESULT_FIELD_ID]: text },
                options: { enableSourcing: false, ignoreMandatoryFields: true }
            });
        } catch (e) {
            log.debug('submitFields failed, trying load/save', `SO ${soId}: ${e.message}`);
            const rec = record.load({ type: record.Type.SALES_ORDER, id: soId });
            rec.setValue({ fieldId: CONFIG.RESULT_FIELD_ID, value: text });
            rec.save({ enableSourcing: false, ignoreMandatoryFields: true });
        }
    }

    // ============================================================================
    // MAP / REDUCE ENTRY POINTS
    // ============================================================================
    const getInputData = () => {
        if (CONFIG.DRY_RUN) {
            log.audit('MODE', `DRY RUN for SO ids: ${CONFIG.DRY_RUN_SO_IDS.join(', ')}`);
            return CONFIG.DRY_RUN_SO_IDS.map(id => ({
                soId: String(id),
                shopifyRef: CONFIG.DRY_RUN_SHOPIFY_OVERRIDE[String(id)] || ''
            }));
        }
        log.audit('MODE', `LIVE using saved search ${CONFIG.SAVED_SEARCH_ID}`);
        return search.load({ id: CONFIG.SAVED_SEARCH_ID });
    };

    // Map: just normalises input and de-duplicates by SO id (search may return several lines per SO)
    const map = (context) => {
        const v = JSON.parse(context.value);
        let soId = '';
        let shopifyRef = '';

        if (v.soId) {
            soId = v.soId;
            shopifyRef = v.shopifyRef || '';
        } else {
            soId = v.id;
            const vals = v.values || {};
            if (!soId && vals.internalid) soId = pickValue(vals.internalid);
            if (CONFIG.SO_SHOPIFY_ORDER_ID_FIELD && vals[CONFIG.SO_SHOPIFY_ORDER_ID_FIELD] != null) {
                shopifyRef = pickValue(vals[CONFIG.SO_SHOPIFY_ORDER_ID_FIELD]);
            }
        }
        if (!soId) return;
        context.write({ key: String(soId), value: shopifyRef || '' });
    };

    // Reduce: one Sales Order at a time
    const reduce = (context) => {
        const soId = context.key;
        let shopifyRef = (context.values || []).find(x => x) || '';
        try {
            const ns = getNetSuiteData(soId);
            if (!shopifyRef) shopifyRef = ns.header.shopifyRef;
            ns.header.shopifyRef = shopifyRef;

            let shop = null;
            let shopErr = '';
            if (shopifyRef) {
                try { shop = getShopifyOrder(shopifyRef); }
                catch (e) { shopErr = e.message; log.error(`Shopify fetch failed SO ${soId}`, e.message); }
            } else {
                shopErr = `No Shopify order id on SO (field ${CONFIG.SO_SHOPIFY_ORDER_ID_FIELD})`;
            }

            const analysis = analyze(ns, shop);
            let text = buildText(ns, shop, shopErr, analysis);
            if (text.length > CONFIG.MAX_TEXT_LENGTH) {
                text = text.substring(0, CONFIG.MAX_TEXT_LENGTH) + '\n...[TRUNCATED]';
            }

            const doWrite = !CONFIG.DRY_RUN || CONFIG.DRY_RUN_WRITE_FIELD;
            if (doWrite) writeField(soId, text);

            if (CONFIG.DRY_RUN) {
                logLong(`DRY RUN SO ${soId}`, text);
            } else {
                log.audit(`SO ${soId} done`, `flags=${analysis.flags.length} txns=${Object.keys(ns.txns).length} chars=${text.length}`);
            }

            context.write({
                key: 'OK',
                value: JSON.stringify({ soId, flags: analysis.flags.length, written: doWrite })
            });
        } catch (e) {
            log.error(`FAILED SO ${soId}`, `${e.name}: ${e.message}`);
            context.write({ key: 'ERROR', value: JSON.stringify({ soId, error: `${e.name}: ${e.message}` }) });
        }
    };

    const summarize = (summary) => {
        if (summary.inputSummary.error) log.error('INPUT ERROR', summary.inputSummary.error);
        summary.mapSummary.errors.iterator().each((k, e) => { log.error(`MAP ERROR ${k}`, e); return true; });
        summary.reduceSummary.errors.iterator().each((k, e) => { log.error(`REDUCE ERROR ${k}`, e); return true; });

        let ok = 0, failed = 0, withFlags = 0, written = 0;
        summary.output.iterator().each((key, value) => {
            const o = JSON.parse(value);
            if (key === 'OK') {
                ok++;
                if (o.flags > 0) withFlags++;
                if (o.written) written++;
            } else {
                failed++;
                log.error(`ORDER FAILED SO ${o.soId}`, o.error);
            }
            return true;
        });

        log.audit('SUMMARY', `Mode=${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'} | processed=${ok} | with mismatches=${withFlags} | field written=${written} | failed=${failed} | seconds=${summary.seconds} | usage=${summary.usage}`);
    };

    return { getInputData, map, reduce, summarize };
});
