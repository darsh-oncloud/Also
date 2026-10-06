/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const getInputData = () => search.create({
        type:'salesorder',
        filters:[
            ['mainline','is','F'],'AND',
            ['shipping','is','F'],'AND',
            ['taxline','is','F'],'AND',
            ['item.type','anyof','InvtPart'],'AND',
            ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END','equalto','1'],'AND',
            ['internalidnumber','equalto','1049144']
        ],
        columns:[
            search.createColumn({name:'lineuniquekey'}),
            search.createColumn({
                name:'internalid',
                join:'item'
            })
        ]
    });

    const map = context => {
        try {

            const r = JSON.parse(context.value);

            const soId = r.id;

            const x = r.values['internalid.item'];
            const itemId = Number(x?.value || x);

            const lineKey = String(r.values.lineuniquekey || '');

            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });


            // Find exact existing line
            let line = -1;

            for(let i = 0; i < so.getLineCount({sublistId:'item'}); i++){

                const key = String(
                    so.getSublistValue({
                        sublistId:'item',
                        fieldId:'lineuniquekey',
                        line:i
                    }) || ''
                );

                if(key === lineKey){
                    line = i;
                    break;
                }
            }


            if(line < 0){
                log.error('Line Not Found',{soId,lineKey});
                return;
            }


            log.audit('Before',{
                line,
                item:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'item',
                    line
                }),
                itemType:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'itemtype',
                    line
                }),
                lineKey
            });


            /*
             * SAME LINE
             * Clear item first
             */
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:''
            });


            log.debug('Item Cleared',{
                line
            });


            /*
             * SAME LINE
             * Enter SAME item again
             */
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:itemId
            });


            log.debug('Item Re-entered',{
                line,
                itemId
            });


            log.audit('Before Save',{
                line,
                item:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'item',
                    line
                }),
                itemType:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'itemtype',
                    line
                }),
                lineUniqueKey:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'lineuniquekey',
                    line
                })
            });


            const savedId = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });


            log.audit('SUCCESS',{
                soId:savedId,
                line,
                itemId,
                lineKey
            });


        }catch(e){

            log.error('ERROR',{
                name:e.name,
                message:e.message,
                stack:e.stack
            });
        }
    };


    return {
        getInputData,
        map
    };

});