/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search', 'N/log'], (search, log) => {

    const saveRecord = (context) => {
        try {
            const rec = context.currentRecord;
            const po = (rec.getValue('otherrefnum') || '').trim();

            if (!po) return true;

            log.debug('Duplicate PO Check', `PO #: ${po}`);

            const filters = [
                ['mainline', 'is', 'T'],
                'AND',
                ['otherrefnum', 'equalto', po]
            ];

            // Exclude current Sales Order when editing
            if (rec.id) {
                filters.push('AND', ['internalid', 'noneof', rec.id]);
            }

            const results = search.create({
                type: search.Type.SALES_ORDER,
                filters: filters,
                columns: ['internalid', 'tranid']
            }).run().getRange({
                start: 0,
                end: 1
            });

            if (results.length) {
                const soNumber = results[0].getValue('tranid');

                log.debug('Duplicate PO Found', {
                    po: po,
                    salesOrder: soNumber
                });

                alert(
                    `PO # ${po} already exists on Sales Order ${soNumber}.\n\n` +
                    `Please enter a different PO number.`
                );

                return false;
            }

            log.debug('Duplicate PO Check', 'No duplicate found');
            return true;

        } catch (e) {
            log.error('Duplicate PO Check Error', e);
            return true;
        }
    };

    return { saveRecord };
});