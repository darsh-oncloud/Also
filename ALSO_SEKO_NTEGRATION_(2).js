/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search','N/record','N/log'], (search, record, log) => {

    const SKIP = [
        'item','line','lineuniquekey','linenumber','id','sys_id','sys_parentid',
        'itemtype','itemsubtype','isnoninventory','olditemid','item_display',
        'amount','grossamt','quantitycommitted','quantityfulfilled','quantitybilled',
        'quantityshiprecv','quantityavailable','quantityonhand','quantitybackordered',
        'backordered','commitinventory','linked','discline','orderdoc','orderline'
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
            'internalid','item','lineuniquekey',
            search.createColumn({name:'internalid',join:'item'})
        ]
    });

    const map = context => {
        try {
            const r = JSON.parse(context.value);
            const soId = r.id;
            const itemResult = r.values['internalid.item'];
            const itemId = itemResult?.value || itemResult;
            const oldKey = String(r.values.lineuniquekey);

            const so = record.load({
                type:record.Type.SALES_ORDER,
                id:soId,
                isDynamic:false
            });

            // Find exact old line
            let line = -1;

            for(let i=0;i<so.getLineCount({sublistId:'item'});i++){
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

            if(line < 0) return;

            // Store old line values in memory
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

            log.debug('Old Values', values);

            // Remove old line
            so.removeLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });

            // Insert new line at SAME position
            so.insertLine({
                sublistId:'item',
                line,
                ignoreRecalc:true
            });

            // Add SAME item again
            so.setSublistValue({
                sublistId:'item',
                fieldId:'item',
                line,
                value:Number(itemId)
            });

            // Restore old editable values
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

            const id = so.save({
                enableSourcing:true,
                ignoreMandatoryFields:false
            });

            log.audit('Updated', {id,line,itemId});

        } catch(e){
            log.error('Error', e);
        }
    };

    return {getInputData,map};
});