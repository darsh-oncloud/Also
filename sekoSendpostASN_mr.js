    /**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/runtime', 'N/record','N/https'], 

	function (file, search, runtime, record,https) {
    function getInputData() {
       
        var results_array = [];


        var searchId = runtime.getCurrentScript().getParameter("custscript_asnsearch");
        var asnSearchObj	= search.load({id: searchId});
        
        var result_set	  = asnSearchObj.run();
        var current_range = result_set.getRange({
            start : 0,
            end : 1000
        });

        var i = 0;  // iterator for all search results
        var j = 0;  // iterator for current result range 0..999

        while ( j < current_range.length ) {

            var result = current_range[j];
            
            var internalid		= result.getValue(result_set.columns[0])

            results_array.push(internalid);

            i++; j++;

            if( j==1000 ) {   // check if it reaches 1000
                j=0;          // reset j an reload the next portion
                current_range = result_set.getRange({
                    start : i,
                    end : i+1000
            });
            }
        }	 


         
        
        return results_array;
    }



    function reduce(context) 
    {
        try
        {
            var search_result	= context.values;
            var to_id = JSON.parse(search_result[0]);
            var companyId = runtime.getCurrentScript().getParameter("custscript_sendasncompanyId");
            var sub_key = runtime.getCurrentScript().getParameter("custscript_sendasnkey");
            var fulfillmentCenterId = runtime.getCurrentScript().getParameter("custscript_sendasnfulfillId");
            var tenantId = runtime.getCurrentScript().getParameter("custscript_sendasntenantId"); 
            log.debug('to_id',to_id)

            
            var toObj = record.load({
                type: record.Type.TRANSFER_ORDER,
                id:parseInt(to_id),
                isDynamic:true
            });
            
            var asn_number = toObj.getValue({
                fieldId: 'tranid'
            });
            var po_number = toObj.getText({
                fieldId: 'custbody_pcs_relponum'
            });
            var deliveryDate = toObj.getValue({
                fieldId: 'custbody_asn_estimateddelivery'
            });
            var asnBillOfLading = toObj.getValue({
                fieldId: 'custbody_pcs_bolnum'
            });
            var specialInstructions = toObj.getValue({
                fieldId: 'custbody_asn_specialinstructions'
            });
            var guidHeader = toObj.getValue({
                fieldId: 'custbody_asn_guid'
            });
            var finalPoString = '';

            for (var i = 0; i < po_number.length; i++) {

                var poNumber = po_number[i].split('#')[1];

                if (i > 0) {
                    finalPoString += ', ';
                }

                finalPoString += poNumber;
            }

            log.debug('finalPoString', finalPoString);            


            //Get transferOrder items
            var itemArray = [];
            var lineCount = toObj.getLineCount({sublistId: 'item'});
            //log.debug('lineCount',lineCount)

            for (var i = 0; i < lineCount; i++) 
            {
                var lineKey = toObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'lineuniquekey',
                    line: i
                });

if (lineKey) {
    toObj.selectLine({
        sublistId: 'item',
        line: i
    });

    toObj.setCurrentSublistValue({
        sublistId: 'item',
        fieldId: 'custcol_3pl_fulfillment_key',
        value: String(lineKey).replace(/,/g, '')
    });

    toObj.commitLine({
        sublistId: 'item'
    });
}
                var invType = toObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });
                var toOrderLine = toObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'orderline',
                    line: i
                });                


                if(invType == 'InvtPart')
                {
                    var itemId = toObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });
                    var itemName = toObj.getSublistText({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var itemQty = toObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    });
                    var setLine = toObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'line',
                        line: i
                    });

                    var itemObj = {
                        "lineKey":lineKey,
                        "itemName":itemName,
                        "itemId":itemId,
                        "itemQty":itemQty,
                        "setLine":setLine
                        
                    };

                    itemArray.push(itemObj);
                }


            }

                log.debug("itemArray",itemArray);
            if(itemArray.length > 0)
            {

                var payload = {
                    "tenantId": tenantId,
                    "companyId": companyId,
                    "fulfillmentCenterId": fulfillmentCenterId,
                    "asn":asn_number,
                    "purchaseOrderNumber":finalPoString,
                    "estimatedDeliveryDate":deliveryDate,
                    "billOfLading":asnBillOfLading,
                    "specialInstructions":specialInstructions,
                    "GUID":guidHeader,
                    "action":"INSERT"
                }
                
                var payloadLine = [];
                for (var x = 0; x < itemArray.length; x++) 
                {
                    var setPayload = {
                            "lineNumber": parseInt(itemArray[x].lineKey),
                            "product": itemArray[x].itemName,
                            "quantityRequired": parseInt(itemArray[x].itemQty),
                            "SupplierCompanyCode": 'DEFSUPALSOINC01',
                            "asn":asn_number,
                            "unitOfMeasureCode":'EACH',
                            "unitOfMeasureQty":1,
                            "GUID":itemArray[x].itemId

                    }
                        payloadLine.push(setPayload);
                        
                }
                payload.details = payloadLine;

                log.debug('SEKO Payload', payload)

    

                var headers = {
                    'Content-Type': 'application/json',
                    'Ocp-Apim-Subscription-Key': sub_key
                };



                var response = https.post({
                    url: 'https://devapi.sekologistics.com/wms/v2/ASN',
                    body: JSON.stringify(payload),
                    headers: headers
                });

                log.debug('SEKO Response', response);
                log.debug('SEKO Response Code', response.code);
                log.debug('SEKO Response Body', response.body);

                if(response.code == 200)
                {
                    toObj.setValue({fieldId: 'custbody_sekotransactioncheck',value:true})
                    toObj.save();
                    log.debug('Transfer Order sent to seko')
                    var itemFulfillmentObj = record.transform({
                        fromType: record.Type.TRANSFER_ORDER,
                        fromId: parseInt(to_id),
                        toType: record.Type.ITEM_FULFILLMENT,
                        isDynamic: true,
                    });
                    var apply_lines = itemFulfillmentObj.getLineCount({
                        sublistId: 'item'
                    }); 

                    itemFulfillmentObj.setValue({fieldId: 'shipstatus',value: 'C'});
                    //log.debug("apply_lines",apply_lines);
                    for (var x = 0; x < apply_lines; x++)
                    {	
                            itemFulfillmentObj.selectLine({
                                sublistId: 'item',
                                line: x
                            });
                            var checkLine =  itemFulfillmentObj.getCurrentSublistValue({
                                        sublistId: 'item',
                                        fieldId: 'item'                                      
                            }); 

                            for (var v = 0; v < itemArray.length; v++) 
                            { 


                                if(checkLine == itemArray[v].itemId)
                                {

                                    itemFulfillmentObj.setCurrentSublistValue({
                                            sublistId: 'item',
                                            fieldId: 'quantity',
                                            value: parseInt(itemArray[v].itemQty)
                                    }); 

                                }

                            }  
                            itemFulfillmentObj.commitLine({ sublistId: 'item' });
                        
                        
                    }


                    var if_id = itemFulfillmentObj.save();
                    log.audit('Item Fulfillment Created', if_id);



                    
                }


            }

        
                         

        }catch(e){
				
            log.audit({
                title: e.name,
                details: e.message
            });	
        }
    }


    function summarize(summary) {
        log.audit({
			title: 'Usage',
			details: summary.usage
		});
		log.audit({
			title: 'Concurrency',
			details: summary.concurrency
		});
		log.audit({
			title: 'Yields',
			details: summary.yields
		});

    }
	function formatDate(x) {
	
		var current_date = new Date(x);
		var trandate = current_date.getDate();
		var tranmonth = current_date.getMonth() + 1;
		var tranyear = current_date.getFullYear();
	
		if (trandate < 10) {
		trandate = '0' + trandate;
		}
	
		if (tranmonth < 10) {
		tranmonth = '0' + tranmonth;
		}
        var fullDate = tranyear +'-'+ tranmonth +'-'+ trandate;

		return fullDate;
	}



    function isNullOrEmpty(objVariable) 
    {
        return (objVariable == null || objVariable == "" || objVariable == undefined || objVariable == 'undefined' || objVariable == 0);
    }



    return {
        getInputData: getInputData,
        reduce: reduce,
        summarize: summarize
    };
});