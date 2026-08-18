/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search'], (search) => {

    const saveRecord = (context) => {
        const rec = context.currentRecord;
        const po = (rec.getValue({ fieldId: 'otherrefnum' }) || '').trim();

        if (!po) return true;

        const filters = [
            ['mainline', 'is', 'T'],
            'AND',
            ['otherrefnum', 'equalto', po]
        ];

        // When editing an existing SO, don't match itself
        if (rec.id) {
            filters.push('AND', ['internalid', 'noneof', rec.id]);
        }

        const duplicate = search.create({
            type: search.Type.SALES_ORDER,
            filters: filters,
            columns: ['tranid']
        }).run().getRange({ start: 0, end: 1 });

        if (duplicate.length) {
            alert(
                'PO# ' + po +
                ' already exists on Sales Order ' +
                duplicate[0].getValue({ name: 'tranid' }) +
                '.'
            );
            return false;
        }

        return true;
    };

    return { saveRecord };
});
