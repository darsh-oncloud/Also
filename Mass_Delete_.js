function massUpdate(recType, recId) {
try{
       nlapiDeleteRecord(recType, recId);
​ nlapiLogExecution('DEBUG', 'Process Error',recId);
} catch (error) {
       if (error.getDetails != undefined) {
             nlapiLogExecution('ERROR', 'Process Error', error.getCode() + ': ' + error.getDetails());
       } else {
              nlapiLogExecution('ERROR', 'Unexpected Error', error.toString());
             }
       } // End log errors
} // End function'
