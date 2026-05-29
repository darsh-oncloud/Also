/**
 * @NApiVersion 2.x
 * @NScriptType MapReduceScript
 */
define(['N/file', 'N/search', 'N/runtime', 'N/record','N/https'], 

	function (file, search, runtime, record,https) {
    function getInputData() {
       
        var results_array = [];


        var searchId = runtime.getCurrentScript().getParameter("custscript_sosearch");
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


         
        //log.debug('results_array',results_array)
        return results_array;
    }



    function reduce(context) 
    {
        try
        {
            var search_result	= context.values;
            var soId = JSON.parse(search_result[0]);
            
            var soObj = record.load({
                type: record.Type.SALES_ORDER,
                id:parseInt(soId),
                isDynamic:true
            });
            
            var documentNo = soObj.getValue({
                fieldId: 'tranid'
            });
            var entityId = soObj.getValue({
                fieldId: 'entity'
            });
            var delivery_instructions = soObj.getValue({
                fieldId: 'custbody_bol_delivery_instructions'
            });
            var shipaddresslist = soObj.getText({
                fieldId: 'shipaddresslist'
            });


            if (shipaddresslist.length > 20) {
            shipaddresslist = shipaddresslist.substring(0, 20);
            }


            var shipcourier = soObj.getText({
                fieldId: 'shipcarrier'
            });
            var trandate = soObj.getValue({
                fieldId: 'trandate'
            });
            var shipDate = soObj.getValue({
                fieldId: 'shipdate'
            });
            var poNumber = soObj.getValue({
                fieldId: 'otherrefnum'
            }); 
            var notes = soObj.getValue({
                fieldId: 'memo'
            });               
            var shipmentterms = soObj.getValue({
                fieldId: 'custbody_so_bol_freight_terms'
            });
            var taxtotal = soObj.getValue({
                fieldId: 'taxtotal'
            });            
            var subtotal = soObj.getValue({
                fieldId: 'subtotal'
            });
            var currency = soObj.getText({
                fieldId: 'currency'
            });                            
            var etailCeligo = soObj.getText({
                fieldId: 'custbody_celigo_etail_channel'
            });      
            //Get customer details
            var cusObj = record.load({
                type: record.Type.CUSTOMER,
                id:parseInt(entityId),
                isDynamic:true
            });
            var firstName = cusObj.getValue({
                fieldId: 'firstname'
            });
            var lastName = cusObj.getValue({
                fieldId: 'lastname'
            });
            var email = cusObj.getValue({
                fieldId: 'email'
            });
            var phone = cusObj.getValue({
                fieldId: 'phone'
            });



            
      


            //get Shipping and BIlling details
            var shipAddr = soObj.getSubrecord({
                fieldId: 'shippingaddress'
            });

            if (shipAddr) {
                var addr1 = shipAddr.getValue({ fieldId: 'addr1' });
                var addr2 = shipAddr.getValue({ fieldId: 'addr2' });
                var addr3 = shipAddr.getValue({ fieldId: 'attention' });
                var addr4 = shipAddr.getValue({ fieldId: 'addressee' });
                var city  = shipAddr.getValue({ fieldId: 'city' });
                var state = shipAddr.getValue({ fieldId: 'state' });
                var zip   = shipAddr.getValue({ fieldId: 'zip' });
                var country = shipAddr.getValue({ fieldId: 'country' });

                log.debug('Ship To Address', {
                    addr1: addr1,
                    city: city,
                    state: state,
                    zip: zip,
                    country: country
                });
            }
            var billAddr = soObj.getSubrecord({
                fieldId: 'billingaddress'
            });            
            
            if (billAddr) {
                var addressee   = billAddr.getValue({ fieldId: 'addressee' });
                var billaddr1   = billAddr.getValue({ fieldId: 'addr1' });
                var billaddr2   = billAddr.getValue({ fieldId: 'addr2' });
                var billaddr4   = billAddr.getValue({ fieldId: 'attention' });
                var billcity    = billAddr.getValue({ fieldId: 'city' });
                var billstate   = billAddr.getValue({ fieldId: 'state' });
                var billzip     = billAddr.getValue({ fieldId: 'zip' });
                var billcountry = billAddr.getValue({ fieldId: 'country' });

                log.debug('Billing Address', {
                    addr1: billaddr1,
                    city: billcity,
                    state: billstate,
                    zip: billzip,
                    country: billcountry
                });
            }

            //Get SO items
            var lineCount = soObj.getLineCount({
                sublistId: 'item'
            });
            var itemsList = [];
            for (var i = 0; i < lineCount; i++) 
            {
                var itemType = soObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'itemtype',
                    line: i
                });
              var description = soObj.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'description',
                    line: i
                });

              if (itemType === 'NonInvtPart' || (description && description.toLowerCase().indexOf('fenders') !== -1)) {
                    var itemId = soObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });

                    var itemName = soObj.getSublistText({
                        sublistId: 'item',
                        fieldId: 'item',
                        line: i
                    });
                    var itemDesc = soObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'description',
                        line: i
                    });                 
                    var itemQty = soObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'quantity',
                        line: i
                    });                  
                    var itemRate = soObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'rate',
                        line: i
                    }); 
                  var groupKey = soObj.getSublistValue({
                        sublistId: 'item',
                        fieldId: 'custcol_pc_also_group_key',
                        line: i
                    }); 
                    var itemObj = {
                        "itemId"    :itemId,
                        "groupKey":groupKey,
                        "itemName": itemName,
                        "itemDesc": itemDesc,
                        "itemQty": itemQty,
                        "itemRate": itemRate
                    }
                    itemsList.push(itemObj);
                }

            }            
            log.debug("itemsList",itemsList);
            
            

            var payload = {
                "tenantId": "uB1$xT2$yF2)uS7@hE5wB1pC3mO5pU2sIeXw",
                "companyId": "ALSO",
                "fulfillmentCenterId": "SEKOAC1",
                "salesOrderId": documentNo,
                "ShipTo": {
                    "Title":shipaddresslist,
                    "FirstName":firstName,
                    "LastName":lastName,
                    "ShipToId":"WEBORDERALSOINC",
                    "Company":"Web Order",
                    "Line1":addr1,
                    "Line2":addr2,
                    "Line3":addr3,
                    "Line4":addr4,
                    "City":city,
                    "County":state,
                    "CountryCode":country,
                    "PostcodeZip":zip,
                    "PhoneNumber":phone,
                    "EmailAddress":email,
                    "BranchCode":"",
                    "LookupDeliveryAddress":"",
                    "DeliveryContactIDNumber":"111111111",
                    "ContactCode":"11111111"
                },
                "specialInstructions":delivery_instructions,
                "salesOrderType": "Web",//CHeck type
                "giftCardMessage":"",
                "giftCard":"",
                "quoteReferenceNumber":"",
                "carrierId": 'FEDEX',//only currently working with Fedex
                "carrierService": "FEDEX_GROUND",//checkCourService
                "orderDate":formatDate(trandate),
                "plannedShipDate":formatDate(shipDate),
                "purchaseOrderNumber":poNumber,
                "accountingCode":"",
                "query01":"",
                "action": "INSERT",
                "customer.Type":"Web",//check
                "note":notes,
                "shipmentTerms":shipmentterms,
                "controlReferenceNumber":"",
                "GUID":"",
                "billToCompany":addressee,
                "acknowledgement":"",
                "arnReferenceNumber":"",
                "DeliveryAddressLocationType":"RESIDENTIAL",
                "DoNotPushToDC":"",
                "LocationType":"",
                "OnHold":"",
                "Ultimatedestination":"",
                "NotificationMethod":"NotificationMethod",//SMS OR EMAIL
                "ShippingTerm": shipmentterms,
                "TaxTotal":taxtotal,
                "SubTotal":subtotal,
                "Channel": etailCeligo,
                "BillingDetails": {
                    "City": billcity,
                    // "ContactCode":"BILL-JOMI",//check w
                    "CountryCode": billcountry,
                    "County": billstate,
                    "EmailAddress": email,
                    "FirstName": firstName,
                    "LastName": lastName,
                    "Line1": billaddr1,
                    "Line2": billaddr2,
                    "Line3": addressee,
                    "Line4": billaddr4,
                    "PhoneNumber": phone,
                    "PostcodeZip": billzip,
                    "Title":""
                }
            }
            var itemLine = 1;
            var payloadLine = [];
            for (var x = 0; x < itemsList.length; x++) 
            {
                   var setPayload = {
                        "salesOrderId": documentNo,
                        "lineNumber": itemLine,
                        "product": itemsList[x].itemName,
                        "quantity": itemsList[x].itemQty,
                        "price": itemsList[x].itemRate,
                        "discountDollars":0,
                        "customerLineNumber":itemsList[x].groupKey,
                        "customerProductDescription":itemsList[x].itemDesc,
                        "tax":0,//checktax
                        "lot":"",
                        "reference":itemsList[x].itemId,
                        "CurrencyCode": currency
                    }
                    
                    payloadLine.push(setPayload);
                    itemLine++;
            }
            payload.details = payloadLine;

            log.debug('SEKO Payload', payload)
 


            var headers = {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': '24317d6663034ad4a19f5fce71b1cbe7'
            };



            var response = https.post({
                url: 'https://devapi.sekologistics.com/wms/v2/salesOrder',
                body: JSON.stringify(payload),
                headers: headers
            });

            log.debug('SEKO Response', response);
            log.debug('SEKO Response Code', response.code);
            log.debug('SEKO Response Body', response.body);

            if(response.code == 200)
            {
                soObj.setValue({fieldId: 'custbody_sekotransactioncheck',value:true})
                soObj.save();
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