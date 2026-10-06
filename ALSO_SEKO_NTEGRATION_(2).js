/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Re-adds Sales Order lines whose item was converted from Non-Inventory to Inventory.
 * The old line keeps its old item type forever, so the line is removed and a new line
 * with the same values is inserted at the SAME position. Only the item line is touched;
 * discount/promotion lines are left exactly as they are.
 */
define(['N/search', 'N/record', 'N/log'], (search, record, log) => {

    // Order matters: price level before rate, rate before amount.
    const FIELDS = [
        'quantity', 'units', 'description', 'price', 'rate', 'amount',
        'location', 'taxcode', 'department', 'class',
        'expectedshipdate', 'requesteddate', 'isclosed'
    ];

    const getInputData = () => search.create({
        type: 'salesorder',
        filters: [
            ['mainline', 'is', 'F'], 'AND',
            ['shipping', 'is', 'F'], 'AND',
            ['taxline', 'is', 'F'], 'AND',
            ['item.type', 'anyof', 'InvtPart'], 'AND',
            ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END', 'equalto', '1'], 'AND',
            ['internalidnumber', 'equalto', '1049053'] // TEST ORDER - remove when ready
        ],
        columns: ['lineuniquekey']
    });

    // Group all lines by Sales Order so each order is loaded/saved only once
    const map = context => {
        const r = JSON.parse(context.value);
        context.write({ key: r.id, value: String(r.values.lineuniquekey) });
    };

    const readLine = (so, line) => {
        const data = {
            item: so.getSublistValue({ sublistId: 'item', fieldId: 'item', line })
        };
        const customFields = so.getSublistFields({ sublistId: 'item' })
            .filter(f => f.startsWith('custcol'));

        [...FIELDS, ...customFields].forEach(fieldId => {
            data[fieldId] = so.getSublistValue({ sublistId: 'item', fieldId, line });
        });
        return data;
    };

    const insertLine = (so, line, data) => {
        so.insertLine({ sublistId: 'item', line });
        so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: data.item });

        Object.keys(data).forEach(fieldId => {
            if (fieldId === 'item') return;
            const value = data[fieldId];
            if (value === null || value === undefined || value === '') return;
            try {
                so.setCurrentSublistValue({ sublistId: 'item', fieldId, value });
            } catch (e) {
                log.debug('Skipped field', { fieldId, value, msg: e.message });
            }
        });

        so.commitLine({ sublistId: 'item' });
    };

    const reduce = context => {
        const soId = context.key;
        const keys = new Set(context.values);

        try {
            const so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: true });

            // Find target lines, then work bottom-up so indexes don't shift
            const targets = [];
            for (let i = 0; i < so.getLineCount({ sublistId: 'item' }); i++) {
                const key = String(so.getSublistValue({ sublistId: 'item', fieldId: 'lineuniquekey', line: i }));
                if (keys.has(key)) targets.push(i);
            }
            targets.sort((a, b) => b - a);

            targets.forEach(idx => {
                const fulfilled = Number(so.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfilled', line: idx }) || 0);
                const billed = Number(so.getSublistValue({ sublistId: 'item', fieldId: 'quantitybilled', line: idx }) || 0);
                if (fulfilled > 0 || billed > 0) {
                    log.error('Skipped - line already fulfilled/billed', { soId, idx });
                    return;
                }

                const itemData = readLine(so, idx);

                // Remove only this item line, then put it back at the same index.
                // Lines below it (e.g. the discount line) shift up and then back down,
                // so they end up in the same place, untouched.
                so.removeLine({ sublistId: 'item', line: idx, ignoreRecalc: true });
                insertLine(so, idx, itemData);

                log.audit('Line rebuilt', { soId, line: idx, item: itemData.item });
            });

            const savedId = so.save({ enableSourcing: true, ignoreMandatoryFields: true });
            log.audit('Sales Order saved', { soId: savedId, linesRebuilt: targets.length });

        } catch (e) {
            log.error('Error on SO ' + soId, { name: e.name, message: e.message, stack: e.stack });
        }
    };

    const summarize = summary => {
        summary.reduceSummary.errors.iterator().each((key, err) => {
            log.error('Reduce error ' + key, err);
            return true;
        });
    };

    return { getInputData, map, reduce, summarize };
});