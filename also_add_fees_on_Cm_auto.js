/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/search', 'N/log'], (search, log) => {

    const beforeSubmit = (context) => {

        if (context.type !== context.UserEventType.CREATE) return;

        const cm = context.newRecord;
        const rmaId = cm.getValue({ fieldId: 'createdfrom' });
        if (!rmaId) return;

        log.audit('CM Fee Start', { rmaId });

        const fees = ['6360', '6361'];
        const existing = new Set();

        for (let i = 0; i < cm.getLineCount({ sublistId: 'item' }); i++)
            existing.add(String(cm.getSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                line: i
            })));

        search.create({
            type: 'returnauthorization',
            filters: [
                ['internalid', 'anyof', rmaId],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['item', 'anyof', fees]
            ],
            columns: ['item', 'amount']
        }).run().each(result => {

            const item = String(result.getValue('item'));
            const amount = -Math.abs(Number(result.getValue('amount')) || 0);

            if (!amount || existing.has(item)) return true;

            const line = cm.getLineCount({ sublistId: 'item' });

            cm.insertLine({ sublistId: 'item', line });

            [
                ['item', Number(item)],
                ['quantity', 1],
                ['price', -1],
                ['rate', amount]
            ].forEach(([fieldId, value]) =>
                cm.setSublistValue({
                    sublistId: 'item',
                    fieldId,
                    line,
                    value
                })
            );

            existing.add(item);

            log.audit('CM Fee Added', {
                item,
                amount
            });

            return true;
        });

        log.audit('CM Fee Complete', {
            rmaId,
            lineCount: cm.getLineCount({ sublistId: 'item' })
        });
    };

    return { beforeSubmit };
});