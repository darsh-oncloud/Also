/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const SKIP = [
        'item','line','lineuniquekey','linenumber','id','sys_id','sys_parentid',
        'itemtype','itemsubtype','isnoninventory','olditemid','item_display',
        'amount','grossamt','tax1amt','taxrate1',
        'quantitycommitted','quantityfulfilled','quantitybilled',
        'quantityshiprecv','quantityavailable','quantityonhand',
        'quantitybackordered','backordered','commitinventory',
        'commitmentfirm','oldcommitmentfirm','inventorydetailavail',
        'linked','discline','orderdoc','orderline','islinefulfilled',
        'itempicked','itempacked','createdpo','origquantity',
        'initquantity','origlocation','origunits'
    ];

    const getInputData = () => search.create({
        type:'salesorder',
        filters:[
            ['mainline','is','F'],'AND',
            ['shipping','is','F'],'AND',
            ['taxline','is','F'],'AND',
            ['item.type','anyof','InvtPart'],'AND',
            ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END','equalto','1'],'AND',
            ['internalidnumber','equalto','1049053']
        ],
        columns:[
            'internalid',
            'lineuniquekey',
            search.createColumn({name:'internalid',join:'item'})
        ]
    });

    const getValues = (rec, line) => {
        const values = {};

        rec.getSublistFields({sublistId:'item'}).forEach(field => {
            if(SKIP.includes(field)) return;

            try{
                values[field] = rec.getSublistValue({
                    sublistId:'item',
                    fieldId:field,
                    line
                });
            }catch(e){}
        });

        return values;
    };

    const restoreValues = (rec, line, values) => {
        Object.keys(values).forEach(field => {
            try{
                rec.setSublistValue({
                    sublistId:'item',
                    fieldId:field,
                    line,
                    value:values[field]
                });
            }catch(e){}
        });
    };

    const map = context => {
        try{
            const r = JSON.parse(context.value);

            const soId = r.id;
            const x = r.values['internalid.item'];
            const itemId = Number(x?.value || x);
            const oldKey = String(r.values.lineuniquekey || '');

            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });

            // Find exact affected line
            let line = -1;

            for(let i=0; i<so.getLineCount({sublistId:'item'}); i++){
                const key = String(so.getSublistValue({
                    sublistId:'item',
                    fieldId:'lineuniquekey',
                    line:i
                }) || '');

                if(key === oldKey){
                    line = i;
                    break;
                }
            }

            if(line < 0){
                log.error('Line Not Found',{soId,oldKey});
                return;
            }

            const itemValues = getValues(so,line);

            /*
             * Capture discount immediately below affected item.
             * Your test order has Promotional Discount below item.
             */
            let discount = null;

            if(line + 1 < so.getLineCount({sublistId:'item'})){

                const nextType = String(so.getSublistValue({
                    sublistId:'item',
                    fieldId:'itemtype',
                    line:line + 1
                }) || '');

                if(nextType === 'Discount' || nextType === 'Markup'){

                    discount = {
                        line: line + 1,

                        item: so.getSublistValue({
                            sublistId:'item',
                            fieldId:'item',
                            line:line + 1
                        }),

                        values: getValues(so,line + 1)
                    };
                }
            }

            log.audit('Captured',{
                soId,
                line,
                itemId,
                hasDiscount:!!discount
            });


            // --------------------------------------------------
            // REMOVE DEPENDENT DISCOUNT FIRST
            // --------------------------------------------------

            if(discount){
                so.removeLine({
                    sublistId:'item',
                    line:discount.line,
                    ignoreRecalc:true
                });
            }


            // --------------------------------------------------
            // REMOVE OLD ITEM LINE
            // --------------------------------------------------

            so.removeLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });


            // --------------------------------------------------
            // INSERT NEW ITEM AT EXACT SAME POSITION
            // --------------------------------------------------

            so.insertLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });

            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:itemId
            });

            restoreValues(so,line,itemValues);


            // --------------------------------------------------
            // PUT DISCOUNT BACK DIRECTLY UNDER ITEM
            // --------------------------------------------------

            if(discount){

                so.insertLine({
                    sublistId:'item',
                    line:line + 1,
                    ignoreRecalc:true
                });

                so.setSublistValue({
                    sublistId:'item',
                    fieldId:'item',
                    line:line + 1,
                    value:discount.item
                });

                restoreValues(
                    so,
                    line + 1,
                    discount.values
                );
            }


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
                quantity:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'quantity',
                    line
                }),
                rate:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'rate',
                    line
                }),
                location:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'location',
                    line
                })
            });


            const savedId = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });


            log.audit('SUCCESS',{
                soId:savedId,
                itemId,
                position:line,
                discountRestored:!!discount
            });

        }catch(e){

            log.error('ERROR',{
                name:e.name,
                message:e.message,
                stack:e.stack
            });
        }
    };

    return {getInputData,map};
});