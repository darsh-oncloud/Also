/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const TEMP_ITEM_ID = 9999; // <-- PUT A VALID TEST INVENTORY ITEM ID HERE

    const SKIP = [
        'item','line','lineuniquekey','linenumber','id','sys_id','sys_parentid',
        'itemtype','itemsubtype','isnoninventory','olditemid','item_display',
        'amount','grossamt','tax1amt','taxrate1',
        'quantitycommitted','quantityfulfilled','quantitybilled',
        'quantityshiprecv','quantityavailable','quantityonhand',
        'quantitybackordered','backordered','commitinventory',
        'commitmentfirm','oldcommitmentfirm','inventorydetailavail',
        'linked','discline','orderdoc','orderline','islinefulfilled',
        'itempicked','itempacked','createdpo',
        'origquantity','initquantity','origlocation','origunits',
        'price_display','pricelevels','unitslist','binitem',
        'locationusesbins','onorder','weightinlb','isposting'
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

    const map = context => {
        try {
            const r = JSON.parse(context.value);

            const soId = r.id;
            const itemResult = r.values['internalid.item'];
            const itemId = Number(itemResult?.value || itemResult);
            const lineKey = String(r.values.lineuniquekey || '');

            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });

            // Find exact existing line
            let line = -1;

            for(let i=0; i<so.getLineCount({sublistId:'item'}); i++){
                const key = String(so.getSublistValue({
                    sublistId:'item',
                    fieldId:'lineuniquekey',
                    line:i
                }) || '');

                if(key === lineKey){
                    line = i;
                    break;
                }
            }

            if(line < 0){
                log.error('Line Not Found',{soId,lineKey});
                return;
            }

            // Capture old editable values
            const values = {};

            so.getSublistFields({sublistId:'item'}).forEach(field => {
                if(SKIP.includes(field)) return;

                try{
                    values[field] = so.getSublistValue({
                        sublistId:'item',
                        fieldId:field,
                        line
                    });
                }catch(e){}
            });

            log.audit('Before Change',{
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


            // 1. Change SAME LINE to temporary item
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:TEMP_ITEM_ID
            });

            log.debug('Temporary Item Set',{
                line,
                tempItem:TEMP_ITEM_ID
            });


            // 2. Change SAME LINE back to original item
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:itemId
            });

            log.debug('Original Item Reset',{
                line,
                itemId
            });


            // 3. Restore old values
            Object.keys(values).forEach(field => {
                try{
                    so.setSublistValue({
                        sublistId:'item',
                        fieldId:field,
                        line,
                        value:values[field]
                    });
                }catch(e){}
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
                oldLineKey:lineKey
            });

        } catch(e){
            log.error('Map Error',{
                name:e.name,
                message:e.message,
                stack:e.stack
            });
        }
    };

    return {getInputData,map};
});