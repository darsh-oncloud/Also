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

            // TEST ORDER
            ['internalidnumber','equalto','1049144']
        ],
        columns:[
            'internalid',
            'lineuniquekey',
            search.createColumn({name:'internalid',join:'item'})
        ]
    });


    // Get all editable/current line values
    const getValues = (rec,line) => {

        const values = {};

        rec.getSublistFields({
            sublistId:'item'
        }).forEach(field => {

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


    // Restore values and return anything NetSuite refused
    const restoreValues = (rec,line,values) => {

        const failed = [];

        Object.keys(values).forEach(field => {

            try{
                rec.setSublistValue({
                    sublistId:'item',
                    fieldId:field,
                    line,
                    value:values[field]
                });
            }
            catch(e){
                failed.push({
                    field,
                    value:values[field],
                    error:e.message
                });
            }
        });

        return failed;
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


            // --------------------------------------------------
            // FIND EXACT AFFECTED LINE
            // --------------------------------------------------

            let line = -1;

            for(let i=0; i<so.getLineCount({sublistId:'item'}); i++){

                const key = String(
                    so.getSublistValue({
                        sublistId:'item',
                        fieldId:'lineuniquekey',
                        line:i
                    }) || ''
                );

                if(key === oldKey){
                    line = i;
                    break;
                }
            }


            if(line < 0){
                log.error('Line Not Found',{soId,oldKey});
                return;
            }


            // --------------------------------------------------
            // CAPTURE ITEM VALUES BEFORE REMOVE
            // --------------------------------------------------

            const itemValues = getValues(so,line);

            log.audit('ITEM - Values Before Remove',{
                soId,
                line,
                itemId,
                oldLineUniqueKey:oldKey,
                fieldCount:Object.keys(itemValues).length,
                values:itemValues
            });


            // --------------------------------------------------
            // CAPTURE RELATED DISCOUNT
            // --------------------------------------------------

            let discount = null;

            if(line + 1 < so.getLineCount({sublistId:'item'})){

                const nextType = String(
                    so.getSublistValue({
                        sublistId:'item',
                        fieldId:'itemtype',
                        line:line + 1
                    }) || ''
                );


                if(nextType === 'Discount' || nextType === 'Markup'){

                    discount = {

                        line:line + 1,

                        item:so.getSublistValue({
                            sublistId:'item',
                            fieldId:'item',
                            line:line + 1
                        }),

                        values:getValues(so,line + 1)
                    };


                    log.audit('DISCOUNT - Values Before Remove',{
                        line:discount.line,
                        item:discount.item,
                        fieldCount:Object.keys(discount.values).length,
                        values:discount.values
                    });
                }
            }


            // --------------------------------------------------
            // REMOVE DISCOUNT FIRST
            // --------------------------------------------------

            if(discount){

                so.removeLine({
                    sublistId:'item',
                    line:discount.line,
                    ignoreRecalc:true
                });

                log.debug('Discount Removed',{
                    line:discount.line,
                    item:discount.item
                });
            }


            // --------------------------------------------------
            // REMOVE OLD ITEM
            // --------------------------------------------------

            so.removeLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });


            log.debug('Old Item Removed',{
                line,
                itemId
            });


            // --------------------------------------------------
            // INSERT SAME ITEM AT SAME POSITION
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


            // Restore item values
            const itemFailed = restoreValues(
                so,
                line,
                itemValues
            );


            // --------------------------------------------------
            // LOG VALUES AFTER ITEM RECREATED
            // --------------------------------------------------

            const newItemValues = getValues(so,line);

            log.audit('ITEM - Values After Re-Add',{
                line,
                itemId,
                fieldCount:Object.keys(newItemValues).length,
                values:newItemValues
            });


            if(itemFailed.length){
                log.error('ITEM - Fields Not Restored',itemFailed);
            }


            // --------------------------------------------------
            // RECREATE DISCOUNT
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


                const discountFailed = restoreValues(
                    so,
                    line + 1,
                    discount.values
                );


                // Log discount after recreation
                const newDiscountValues = getValues(
                    so,
                    line + 1
                );


                log.audit('DISCOUNT - Values After Re-Add',{
                    line:line + 1,
                    item:discount.item,
                    fieldCount:Object.keys(newDiscountValues).length,
                    values:newDiscountValues
                });


                if(discountFailed.length){
                    log.error(
                        'DISCOUNT - Fields Not Restored',
                        discountFailed
                    );
                }
            }


            // --------------------------------------------------
            // FINAL CHECK BEFORE SAVE
            // --------------------------------------------------

            log.audit('Before Save',{
                soId,
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


            // --------------------------------------------------
            // SAVE
            // --------------------------------------------------

            const savedId = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });


            log.audit('SUCCESS',{
                soId:savedId,
                itemId,
                position:line,
                oldLineUniqueKey:oldKey,
                discountRestored:!!discount
            });


        }
        catch(e){

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