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
        'quantitybackordered','backordered',

        'commitinventory','commitmentfirm','oldcommitmentfirm',
        'inventorydetailavail',

        'linked','discline','orderdoc','orderline',
        'islinefulfilled','itempicked','itempacked','createdpo',

        'origquantity','initquantity','origlocation','origunits',
        'price_display','pricelevels','unitslist','binitem',
        'locationusesbins','onorder','weightinlb','isposting'
    ];


    const getInputData = () => search.create({
        type:'salesorder',
        filters:[
            ['type','anyof','SalesOrd'],'AND',
            ['mainline','is','F'],'AND',
            ['shipping','is','F'],'AND',
            ['taxline','is','F'],'AND',
            ['status','anyof',
                'SalesOrd:A',
                'SalesOrd:D',
                'SalesOrd:F',
                'SalesOrd:E',
                'SalesOrd:B'
            ],'AND',
            ['item.type','anyof','InvtPart'],'AND',
            ['formulanumeric: CASE WHEN {commit} IS NULL THEN 1 ELSE 0 END','equalto','1'],'AND',

            // TEST ORDER
            ['internalidnumber','equalto','1049144']
        ],
        columns:[
            search.createColumn({name:'internalid'}),
            search.createColumn({name:'tranid'}),
            search.createColumn({name:'item'}),
            search.createColumn({name:'line'}),
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
            const itemResult = r.values['internalid.item'];
            const itemId = Number(itemResult?.value || itemResult);
            const lineKey = String(r.values.lineuniquekey || '');


            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });


            // FIND EXACT OLD LINE
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
                log.error('Line Not Found',{soId,itemId,lineKey});
                return;
            }


            // SAFETY
            const fulfilled = Number(so.getSublistValue({
                sublistId:'item',
                fieldId:'quantityfulfilled',
                line
            }) || 0);

            const billed = Number(so.getSublistValue({
                sublistId:'item',
                fieldId:'quantitybilled',
                line
            }) || 0);


            if(fulfilled > 0 || billed > 0){
                log.error('Skipped - Fulfilled/Billed',{
                    soId,line,fulfilled,billed
                });
                return;
            }


            // STORE OLD LINE VALUES
            const values = {};

            so.getSublistFields({
                sublistId:'item'
            }).forEach(field => {

                if(SKIP.includes(field)) return;

                try{
                    values[field] = so.getSublistValue({
                        sublistId:'item',
                        fieldId:field,
                        line
                    });
                }catch(e){}
            });


            log.audit('Before Replace',{
                soId,
                line,
                itemId,
                lineKey,
                oldItemType:so.getSublistValue({
                    sublistId:'item',
                    fieldId:'itemtype',
                    line
                }),
                savedFields:Object.keys(values).length
            });


            // REMOVE OLD LINE
            so.removeLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });


            // INSERT NEW BLANK LINE AT EXACT SAME POSITION
            so.insertLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });


            // ADD SAME ITEM AGAIN
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:itemId
            });


            // RESTORE OLD LINE VALUES
            let restored = 0;
            const skipped = [];

            Object.keys(values).forEach(field => {

                try{
                    so.setSublistValue({
                        sublistId:'item',
                        fieldId:field,
                        line,
                        value:values[field]
                    });

                    restored++;

                }catch(e){

                    skipped.push({
                        field,
                        error:e.message
                    });
                }
            });


            log.audit('New Line Before Save',{
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
                restored
            });


            if(skipped.length)
                log.debug('Fields Not Restored',skipped);


            const savedId = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });


            log.audit('SUCCESS',{
                soId:savedId,
                itemId,
                line,
                oldLineKey:lineKey,
                restoredFields:restored
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