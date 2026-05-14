/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/runtime', 'N/record','N/https'], 

	function (file, search, runtime, record,https) {
    function getInputData() {
       
        var results_array = [];


        var searchId = runtime.getCurrentScript().getParameter("custscript_itemsearch");
        var soSearchObj	= search.load({id: searchId});
        
        var result_set	  = soSearchObj.run();
        var current_range = result_set.getRange({
            start : 0,
            end : 1000
        });

        var i = 0;  // iterator for all search results
        var j = 0;  // iterator for current result range 0..999

        while ( j < current_range.length ) {

            var result = current_range[j];
            
            var internalid		= result.getValue(result_set.columns[0])
            //var itemType		= result.getValue(result_set.columns[2])

            // var resultObj = {
            //     "internalid":internalid,
            //     "itemType":itemType
            // }
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


         
        log.debug('results_array',results_array)
        return results_array;
    }



    function reduce(context) 
    {
        try
        {
            var search_result	= context.values;
            log.debug('search_result',search_result)
            var itemId = JSON.parse(search_result[0]);
            // var itemId = resultObj.internalid;
            // var itemType = resultObj.internalid;
            var setType;
            var lookup = search.lookupFields({
                type: 'item',
                id: itemId,
                columns: ['recordtype']
            });
            var recType = lookup.recordtype

            // if(itemType == 'InvtPart')
            // {
            //     setType = 'inventoryitem'
            // }else{
            //     setType = 'inventoryitem'
            // }



            var itemObj = record.load({
                type: recType,
                id:parseInt(itemId),
                isDynamic:true
            });
            
            var itemId = itemObj.getValue({
                fieldId: 'itemid'
            });
            
            var description = itemObj.getValue({
                fieldId: 'displayname'
            });
            
            var purchasedescription = itemObj.getValue({
                fieldId: 'purchasedescription'
            });
            
            var sizeCode = itemObj.getText({
                fieldId: 'custitem_also_size'
            });
           
            var countryofmanufacture = itemObj.getText({
                fieldId: 'countryofmanufacture'
            });
            
            var manufacturertariff = itemObj.getText({
                fieldId: 'manufacturertariff'
            });
            
            var itemCategory = itemObj.getText({
                fieldId: 'custitem_also_category'
            });
            
            var mainUomCode = itemObj.getText({
                fieldId: 'weightunit'
            });
            
            var mainBarCode = itemObj.getValue({
                fieldId: 'upccode'
            });
            
            var itemWeight = itemObj.getValue({
                fieldId: 'weight'
            });  
                     
            var leadTime = itemObj.getValue({
                fieldId: 'leadtime'
            });
            
            
            var minimumQuantity = itemObj.getValue({
                fieldId: 'minimumquantity'
            });              
            var currency = itemObj.getValue({
                fieldId: 'currency'
            });                         
            var priceLevel = itemObj.getValue({
                fieldId: 'pricelevel'
            });            
            var hazmat = itemObj.getValue({
                fieldId: 'custitem_ishazmat'
            });
            var hazardous = ''
            if(hazmat == true)
            {
                hazardous = 'Hazardous'
            }
            var vendorCount = itemObj.getLineCount({
                sublistId: 'itemvendor'
            });
            
            var vendors = [];
             log.debug('vendorCount', vendorCount)
            for (var i = 0; i < vendorCount; i++) {
                var vendorIdLine = itemObj.getSublistValue({
                    sublistId: 'itemvendor',
                    fieldId: 'vendor',
                    line: i
                });

                var vendorNameLine = itemObj.getSublistText({
                    sublistId: 'itemvendor',
                    fieldId: 'vendor',
                    line: i
                });

                vendors.push({
                    "vendorIdLine": vendorIdLine,
                    "vendorNameLine": vendorNameLine
                });
            }
            var vendorId = "";
            var vendorName ="";
            if(vendorCount > 0)
            {
                vendorId = vendors[0].vendorIdLine
                vendorName = vendors[0].vendorNameLine
            }


            var payload = {
                "tenantId": "uB1$xT2$yF2)uS7@hE5wB1pC3mO5pU2sIeXw",
                "companyId": "ALSO",
                "product": itemId,
                "description20": description,
                "description50": purchasedescription,
                "sizeCode": sizeCode,
                "countryOrigin":countryofmanufacture,
                "harmonizedTariffCode":manufacturertariff,
                "productCategory01":itemCategory,
                "mainUomCode": mainUomCode,
                //"mainBarCode":mainBarCode,
                "productShippingWeight":itemWeight,
                //"leadTime":leadTime,
                //"MOQ":minimumQuantity,
                //"dangerousGoodsClass":hazardous,
                "currency":'USD',
                "secondaryCurrencyCode":'USD',
                "secondaryPrice":priceLevel,
                "hazardous":hazmat,
                 "List": {
                    "supplierMapping": [{
                        "supplierCode": 'DEFSUPALSOINC01',
                        "supplierDescription": 'Default Supplier ALSO Inc.',
                        "UOM": 0
                    }]
                    

                 },
                "action": "INSERT",
                 "mainBarCodeType": "PRODUCT",
            };  

            if(!isNullOrEmpty(leadTime))
            {
                payload.leadTime = leadTime
            }
            if(!isNullOrEmpty(mainBarCode))
            {
                payload.mainBarCode = mainBarCode
            }
            if(!isNullOrEmpty(minimumQuantity))
            {
                payload.MOQ = minimumQuantity
            }            



            log.debug('SEKO Payload', payload)
 


            var headers = {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': '24317d6663034ad4a19f5fce71b1cbe7'
            };



            var response = https.post({
                url: 'https://devapi.sekologistics.com/wms/v2/productDetail',
                body: JSON.stringify(payload),
                headers: headers
            });

            log.debug('SEKO Response', response);
            log.debug('SEKO Response Code', response.code);
            log.debug('SEKO Response Body', response.body);
            if(response.code == 200)
            {
                itemObj.setValue({fieldId: 'custitem_sekoitemcreated',value:true})
                itemObj.save();
                log.debug('so saved')
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