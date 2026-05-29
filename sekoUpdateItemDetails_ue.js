    /**
     * @NApiVersion 2.x
     * @NScriptType UserEventScript
     * @NModuleScope SameAccount
     */
    define(['N/record','N/runtime','N/ui/serverWidget','N/search','N/https'],

        function(record,runtime,serverWidget,search,https) {


            function beforeSubmit(scriptContext) {

                var EVENT_TYPE 		= scriptContext.type;
                var current_record = scriptContext.newRecord;
                var record_id = current_record.id; 
                //log.debug('EVENT_TYPE',EVENT_TYPE)
                    
                if (EVENT_TYPE == 'edit')
                {
                    var newRec = scriptContext.newRecord;
                    var oldRec = scriptContext.oldRecord;
                    var itemId = current_record.getValue({fieldId: 'itemid'});
                    var hasChanges = false;
                    var oldRecDescription = oldRec.getValue({fieldId: 'displayname'});
                    var newRecDescription = newRec.getValue({fieldId: 'displayname'});
                    var oldRecItemWeight = oldRec.getValue({fieldId: 'weight'});     
                    var newRecItemWeight = newRec.getValue({fieldId: 'weight'});        
                    var oldRecHazmat = oldRec.getValue({fieldId: 'custitem_ishazmat'});
                    var newRecHazmat = newRec.getValue({fieldId: 'custitem_ishazmat'});
                    var mainUomCode = newRec.getText({fieldId: 'weightunit'});
                    var payload = {
                        "tenantId": "uB1$xT2$yF2)uS7@hE5wB1pC3mO5pU2sIeXw",
                        "companyId": "ALSO",
                        "product": itemId,
                        "action": "MODIFY",
                        "mainBarCodeType": "PRODUCT",
                        "mainUomCode": mainUomCode,
                        
                    };
                    if(oldRecDescription != newRecDescription)
                    {
                        payload.description20 = newRecDescription
                        hasChanges = true;
                    }                    
                    if(oldRecItemWeight != newRecItemWeight)
                    {
                        payload.productShippingWeight = newRecItemWeight
                        hasChanges = true;
                    }                       
                    // if(oldRecHazmat != newRecHazmat)
                    // {
                    //     payload.productShippingWeight = newRecItemWeight
                    //     hasChanges = true;
                    // }      
                    // var hazardous = ''
                    // if(hazmat == true)
                    // {
                    //     hazardous = 'Hazardous'
                    // }
                    log.debug('payload', payload);
                    if(hasChanges)
                    {
                        
                        var headers = {
                            'Content-Type': 'application/json',
                            'Ocp-Apim-Subscription-Key': '24317d6663034ad4a19f5fce71b1cbe7'
                        };
                        var response = https.post({
                            url: 'https://devapi.sekologistics.com/wms/v2/productDetail',
                            body: JSON.stringify(payload),
                            headers: headers
                        });

                        //log.debug('SEKO Response', response);
                        log.debug('SEKO Response Code', response.code);
                        log.debug('SEKO Response Body', response.body);
                        if(response.code == 200)
                        {
                            current_record.setValue({fieldId: 'custitem_updateitem', value: false});
                            
                        } 
                        

                    }      


                }
            }
            function isNullOrEmpty(objVariable) 
            {
                return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
            }
        return {
            
            beforeSubmit: beforeSubmit
        };
    });
