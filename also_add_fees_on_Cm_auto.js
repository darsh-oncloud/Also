/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log'], (log) => {

    const beforeSubmit = (context) => {

        if (context.type !== context.UserEventType.CREATE) return;

        const rec = context.newRecord;

        log.audit('Item Fields',
            rec.getSublistFields({ sublistId: 'item' })
        );

        for (let i = 0; i < rec.getLineCount({ sublistId: 'item' }); i++) {
            log.audit('Line ' + i, {
                item: rec.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                })
            });
        }
    };

    return { beforeSubmit };
});