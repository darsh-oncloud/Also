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

        search.create({
            type: 'returnauthorization',
            filters: [
                ['internalid', 'anyof', rmaId],
                'AND',
                ['mainline', 'is', 'F'],
                'AND',
                ['item', 'anyof', '6360', '6361']
            ],
            columns: ['item', 'amount', 'line']
        }).run().each(result => {

            const item = Number(result.getValue('item'));
            const amount = -Math.abs(Number(result.getValue('amount')) || 0);
            const orderLine = Number(result.getValue('line'));

            if (!amount) return true;

            const line = cm.getLineCount({ sublistId: 'item' });

            cm.insertLine({ sublistId: 'item', line });

            [
                ['item', item],
                ['quantity', 1],
                ['price', -1],
                ['rate', amount],
                ['orderdoc', Number(rmaId)],
                ['orderline', orderLine]
            ].forEach(([fieldId, value]) =>
                cm.setSublistValue({
                    sublistId: 'item',
                    fieldId,
                    line,
                    value
                })
            );

            log.audit('CM Fee Linked', {
                item,
                amount,
                orderdoc: rmaId,
                orderline: orderLine
            });

            return true;
        });

        log.audit('CM Fee Complete', {
            rmaId,
            lines: cm.getLineCount({ sublistId: 'item' })
        });
    };

    return { beforeSubmit };
});