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


    // --------------------------------------------------
    // SAVED SEARCH
    // --------------------------------------------------

    const getInputData = () => search.load({
        id:'customsearch4206'
    });


    // --------------------------------------------------
    // GET ALL EXISTING EDITABLE LINE VALUES
    // --------------------------------------------------

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


    // --------------------------------------------------
    // RESTORE LINE VALUES
    // --------------------------------------------------

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

            }catch(e){

                failed.push({
                    field,
                    value:values[field],
                    error:e.message
                });
            }
        });

        return failed;
    };


    // --------------------------------------------------
    // MAP
    // --------------------------------------------------

    const map = context => {

        try{

            const r = JSON.parse(context.value);

            const soId = r.id;

            const x = r.values['internalid.item'];
            const itemId = Number(x?.value || x);

            // USE LINE ID FROM SAVED SEARCH
            const oldLineId = String(r.values.line || '');


            log.audit('Processing',{
                soId,
                itemId,
                oldLineId
            });


            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });


            // --------------------------------------------------
            // FIND EXACT AFFECTED LINE USING LINE ID
            // --------------------------------------------------

            let line = -1;

            for(let i=0; i<so.getLineCount({sublistId:'item'}); i++){

                const currentLineId = String(
                    so.getSublistValue({
                        sublistId:'item',
                        fieldId:'line',
                        line:i
                    }) || ''
                );


                if(currentLineId === oldLineId){

                    line = i;
                    break;
                }
            }


            if(line < 0){

                log.error('Line Not Found',{
                    soId,
                    itemId,
                    oldLineId
                });

                return;
            }


            // --------------------------------------------------
            // CAPTURE ITEM VALUES BEFORE REMOVE
            // --------------------------------------------------

            const itemValues = getValues(so,line);


            log.audit('ITEM - Values Before Remove',{
                soId,
                line,
                lineId:oldLineId,
                itemId,
                fieldCount:Object.keys(itemValues).length,
                values:itemValues
            });


            // --------------------------------------------------
            // CAPTURE RELATED DISCOUNT / MARKUP
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

                        values:getValues(
                            so,
                            line + 1
                        )
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
                lineId:oldLineId,
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


            // --------------------------------------------------
            // RESTORE OLD ITEM VALUES
            // --------------------------------------------------

            const itemFailed = restoreValues(
                so,
                line,
                itemValues
            );


            // --------------------------------------------------
            // LOG ITEM VALUES AFTER RE-ADD
            // --------------------------------------------------

            const newItemValues = getValues(
                so,
                line
            );


            log.audit('ITEM - Values After Re-Add',{
                line,
                itemId,
                fieldCount:Object.keys(newItemValues).length,
                values:newItemValues
            });


            if(itemFailed.length){

                log.error(
                    'ITEM - Fields Not Restored',
                    itemFailed
                );
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
                oldLineId,
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


    return {
        getInputData,
        map
    };

});