/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define([], () => {

    const beforeSubmit = (context) => {

        if (context.type !== context.UserEventType.CREATE) return;

        const rec = context.newRecord;
        const count = rec.getLineCount({ sublistId: 'item' });

        for (let i = 0; i < count; i++) {

            const type = String(rec.getSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_item_parentcomp',
                line: i
            }) || '');

            if (['1', '5', '6'].includes(type)) {

                rec.setSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemreceive',
                    line: i,
                    value: true
                });
            }
        }
    };

    return { beforeSubmit };
});
