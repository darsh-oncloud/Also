/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search'], (search) => {

    const beforeSubmit = (context) => {

        if (context.type !== context.UserEventType.CREATE) return;

        const cm = context.newRecord;
        const rmaId = cm.getValue({ fieldId: 'createdfrom' });

        if (!rmaId) return;

        const feeItems = ['6360', '6361'];

        const existingItems = [];

        for (let i = 0; i < cm.getLineCount({ sublistId: 'item' }); i++) {
            existingItems.push(String(
                cm.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                })
            ));
        }

        search.create({
            type: 'returnauthorization',
            filters: [
                ['internalid', 'anyof', rmaId],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['item', 'anyof', feeItems]
            ],
            columns: ['item', 'amount']
        }).run().each(result => {

            const itemId = String(result.getValue({ name: 'item' }));
            const amount = Number(result.getValue({ name: 'amount' })) || 0;

            if (!amount || existingItems.indexOf(itemId) !== -1) {
                return true;
            }

            const line = cm.getLineCount({ sublistId: 'item' });

            cm.insertLine({
                sublistId: 'item',
                line: line
            });

            cm.setSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: line,
                value: Number(itemId)
            });

            cm.setSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                line: line,
                value: 1
            });

            cm.setSublistValue({
                sublistId: 'item',
                fieldId: 'price',
                line: line,
                value: -1
            });

            cm.setSublistValue({
                sublistId: 'item',
                fieldId: 'rate',
                line: line,
                value: amount
            });

            existingItems.push(itemId);

            return true;
        });
    };

    return { beforeSubmit };
});
