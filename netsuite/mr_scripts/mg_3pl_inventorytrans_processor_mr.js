/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Script Name: MG_3PL_InventoryTrans_processor_mr.js
 * Purpose:    Consumes customrecord_mg_3pl_inventory_trans lines,
 *             creates Inventory Adjustments in NetSuite using a
 *             two-pass approach for decrementing available stock.
 */

define(['N/record', 'N/search', 'N/runtime', 'N/log'],
    (record, search, runtime, log) => {
    
      // Configuration data
      const CONFIG = {
        CUSTOM_RECORD_TYPE: 'customrecord_mg_3pl_inventory_trans', 
    
        // Fields on that record
        FIELD_3PL_ID: 'custrecord_invtrans_extid',
        FIELD_INVENTORY_TYPE: 'custrecord_invtrans_inventorytype', // pickable, backstock, defective
        FIELD_QUANTITY: 'custrecord_invtrans_quantity',
        FIELD_ITEM: 'custrecord_invtrans_item',
        FIELD_PROCESS_STATUS: 'custrecord_invtrans_processstatus', // status: null,2,3,4
        FIELD_ADJ_REASON: 'custbody_atlas_inv_adj_reason',
        FIELD_ADJ_REASON_ID: '1', //Shipping Tree Adjustment


        
        // Process status enumerations
        STATUS_NULL: '', 
        STATUS_IN_PROGRESS: 2,
        STATUS_COMPLETED: 3,
        STATUS_ERROR: 4,
    
        // Single location for defective
        DEFECTIVE_LOCATION: '15', 
    
        // The location for inbound increases (for available bucket)
        PRIMARY_AVAILABLE_LOC: '10',   // Shipping Tree - ECOM
    
        // The prioritized locations for outflow of available stock
        DECREMENT_LOCATIONS_AVAILABLE: ['10','11','12','13','14'], //Ecom, Wholesale, Retail, Marketing, Gifting
    
        // Sublist & fields for Inventory Adjustment lines
        ADJ_SUBLIST: 'inventory',
        MEMO_FIELD: 'memo',  
    
        // Default line memo
        DEFAULT_LINE_MEMO: 'Auto adjustment from 3PL:'
      };
    
      /**
       * getInputData:
       *   - Search for all records with processstatus=null.
       *   - Mark them in-progress so as not to be double-processed.
       */
      function getInputData() {
        const srch = search.create({
          type: CONFIG.CUSTOM_RECORD_TYPE,
          filters: [
            [CONFIG.FIELD_PROCESS_STATUS, 'anyof', '@NONE@']
          ],
          columns: ['internalid']
        });
    
        const allIds = [];
        srch.run().each(res => {
          const recId = res.id;
          try {
            record.submitFields({
              type: CONFIG.CUSTOM_RECORD_TYPE,
              id: recId,
              values: { [CONFIG.FIELD_PROCESS_STATUS]: CONFIG.STATUS_IN_PROGRESS }
            });
            allIds.push(recId);
          } catch(e) {
            log.error('getInputData - lock error', `ID=${recId}, e=${e.message}`);
          }
          return true;
        });
    
        return allIds;
      }
    
      /**
       * map():
       *   - Load the custom record, read item, inventory type => bucket, quantity, ext ID
       *   - Write them with key=itemId so reduce can group them
       */
      function map(context) {
        const recId = context.value;
        
        log.debug('starting map');

        try {
          const recObj = record.load({
            type: CONFIG.CUSTOM_RECORD_TYPE,
            id: recId
          });
    
          const itemId = recObj.getValue({ fieldId: CONFIG.FIELD_ITEM });
          const invType = recObj.getValue({ fieldId: CONFIG.FIELD_INVENTORY_TYPE }); 
          const qty = parseFloat(recObj.getValue({ fieldId: CONFIG.FIELD_QUANTITY })) || 0;
          const extId = recObj.getValue({ fieldId: CONFIG.FIELD_3PL_ID }) || '';
    
          // If pickable/backstock => "available", if defective => "defective"
          const bucket = (invType === 'defective') ? 'defective' : 'available';
          log.debug('bucket type',bucket)
    
          const dataObj = {
            recordId: recId,
            itemId: String(itemId),
            bucket: bucket,
            qty: qty,
            extId: extId
          };
    
          context.write({
            key: String(itemId),
            value: JSON.stringify(dataObj)
          });
    
        } catch(e) {
          log.error('map error', e.message);
          // Mark record as error
          record.submitFields({
            type: CONFIG.CUSTOM_RECORD_TYPE,
            id: recId,
            values: { [CONFIG.FIELD_PROCESS_STATUS]: CONFIG.STATUS_ERROR }
          });
        }
      }
    
      /**
       * reduce():
       *   - Group lines by itemId
       *   - Aggregate net for available vs defective
       *   - If net != 0, create an Inventory Adjustment with multi-line logic
       */
      function reduce(context) {
        const itemId = context.key;
        const lines = context.values.map(v => JSON.parse(v));
    
        log.debug('starting reduce');

        let agg = { available: 0, defective: 0 };
        let allRecIds = [];
        let allExtIds = [];
    
        // Aggregate net
        lines.forEach(mov => {
          agg[mov.bucket] = (agg[mov.bucket] || 0) + mov.qty;
          allRecIds.push(mov.recordId);
          if (mov.extId) allExtIds.push(mov.extId);
        });
    
        log.debug('after aggregate');


        // If net zero => skip, mark completed
        if (agg.available === 0 && agg.defective === 0) {
          markCompleted(allRecIds, null);
          return;
        }
    
        // Build comma-delimited ext IDs
        const reasonStr = allExtIds.join(',');
    
        // Attempt to create the Inventory Adjustment
        let adjId;
        try {
          const adjRec = record.create({
            type: record.Type.INVENTORY_ADJUSTMENT,
            isDynamic: true
          });
    
          adjRec.setValue({ fieldId: 'subsidiary', value: '2' });
          adjRec.setValue({ fieldId: 'account', value: '532' });
          adjRec.setValue({ fieldId: 'memo', value: '3PL Inventory Movement' });
          adjRec.setValue({ fieldId: 'department', value: '1' });
          adjRec.setValue({ fieldId: 'class', value: '108' });
          adjRec.setValue({ fieldId: 'adjlocation', value: CONFIG.PRIMARY_AVAILABLE_LOC });
          adjRec.setValue({ fieldId: CONFIG.FIELD_ADJ_REASON, value: CONFIG.FIELD_ADJ_REASON_ID });
          
          // 1) handle available
          if (agg.available > 0) {
            log.debug('agg available > 0');
            // Net + => add to primary loc
            addLine(adjRec, itemId, CONFIG.PRIMARY_AVAILABLE_LOC, agg.available, reasonStr);
          } else if (agg.available < 0) {
            log.debug('agg available < 0');
            let needed = Math.abs(agg.available);
            decrementAvailableTwoPass(adjRec, itemId, needed, reasonStr);
          }
    
          // 2) handle defective
          if (agg.defective !== 0) {
  log.debug('agg.defective is non-zero', `Value: ${agg.defective}`);
  addLine(adjRec, itemId, CONFIG.DEFECTIVE_LOCATION, agg.defective, reasonStr);
}


          adjId = adjRec.save();
          log.audit('Inventory Adjustment Created', `Item=${itemId}, InvAdjID=${adjId}`);
    
        } catch(e) {
          log.error('reduce - adjustment error', e.message);
          markError(allRecIds, e.message);
          return;
        }
    
        // Mark completed
        markCompleted(allRecIds, adjId);
      }
    
      /**
       * summarize():
       *   - Logs any errors in map/reduce
       */
      function summarize(summary) {
        if (summary.inputSummary.error) {
          log.error('inputError', summary.inputSummary.error);
        }
        summary.mapSummary.errors.iterator().each((key, msg) => {
          log.error(`MapError: Key=${key}`, msg);
          return true;
        });
        summary.reduceSummary.errors.iterator().each((key, msg) => {
          log.error(`ReduceError: Key=${key}`, msg);
          return true;
        });
        log.audit('MR Summary', {
          usage: summary.usage,
          concurrency: summary.concurrency,
          yields: summary.yields
        });
      }
    
      // ================= Helper Functions =================
    
      /**
       * addLine => single sublist line for +/- quantity
       */
      function addLine(adjRec, itemId, locationId, quantity, reasonStr) {

        log.debug('addLine');

        adjRec.selectNewLine({ sublistId: CONFIG.ADJ_SUBLIST });
        adjRec.setCurrentSublistValue({ sublistId: CONFIG.ADJ_SUBLIST, fieldId: 'item', value: itemId });
        adjRec.setCurrentSublistValue({ sublistId: CONFIG.ADJ_SUBLIST, fieldId: 'location', value: locationId });
        adjRec.setCurrentSublistValue({ sublistId: CONFIG.ADJ_SUBLIST, fieldId: 'adjustqtyby', value: quantity });
    
        adjRec.setCurrentSublistValue({
          sublistId: CONFIG.ADJ_SUBLIST,
          fieldId: CONFIG.MEMO_FIELD,
          value: `${CONFIG.DEFAULT_LINE_MEMO} | 3PL Ref: ${reasonStr}`
        });
    
        adjRec.commitLine({ sublistId: CONFIG.ADJ_SUBLIST });
      }
    
      /**
       * decrementAvailableTwoPass => uses two loops:
       *   PASS #1: subtract from each location's qtyAvailable
       *   PASS #2: subtract from each location's (qtyOnHand - qtyAvailable)
       *   If still leftover => go negative on the first location
       */
      function decrementAvailableTwoPass(adjRec, itemId, needed, reasonStr) {
        let remainder = needed;

        log.debug('decrementAvailableTwoPass');
    
        // 1) get location info (available + onHand) for each location in priority order
        const locInfos = getLocationQuantities(itemId, CONFIG.DECREMENT_LOCATIONS_AVAILABLE);
    
        // ----- PASS 1: subtract from qtyAvailable
        for (let i = 0; i < locInfos.length; i++) {

            log.debug('pass 1', i);

          if (remainder <= 0) break;
          let loc = locInfos[i];
    
          let usedAvail = Math.min(loc.qtyAvailable, remainder);
          remainder -= usedAvail;
          if (usedAvail > 0) {
            addLine(adjRec, itemId, loc.locId, -usedAvail, reasonStr);
          }
        }
        if (remainder <= 0) return;
    
        // ----- PASS 2: subtract from onHand beyond available
        for (let i = 0; i < locInfos.length; i++) {

            log.debug('pass 2', i);


          if (remainder <= 0) break;
          let loc = locInfos[i];
    
          let beyond = loc.qtyOnHand - loc.qtyAvailable;
          if (beyond < 0) beyond = 0;
    
          let usedOnHand = Math.min(beyond, remainder);
          remainder -= usedOnHand;
          if (usedOnHand > 0) {
            addLine(adjRec, itemId, loc.locId, -usedOnHand, reasonStr);
          }
        }
    
        // If still remainder => go negative in the first location
        if (remainder > 0 && locInfos.length > 0) {

            log.debug('remaining, go negative');

          const firstLoc = locInfos[0].locId;
          addLine(adjRec, itemId, firstLoc, -remainder, reasonStr);
          remainder = 0;
        }
      }
    
      /**
       * decrementDefective => single location
       */
      function decrementDefective(adjRec, itemId, needed, reasonStr) {
        
        log.debug('function decrementDefective');

        addLine(adjRec, itemId, CONFIG.DEFECTIVE_LOCATION, -needed, reasonStr);
      }
    

function getLocationQuantities(itemId, locIds) {
  let results = [];
  if (!locIds || locIds.length === 0) return results;

  // Use an item search to get locationquantityavailable & locationquantityonhand
  const itemSearch = search.create({
    type: search.Type.ITEM,
    filters: [
      ['internalid','anyof', itemId],     // the item
      'AND',
      ['inventorylocation','anyof', locIds]
    ],
    columns: [
      'inventorylocation',
      'locationquantityavailable',
      'locationquantityonhand'
    ]
  });

  itemSearch.run().each(r => {
    const loc = r.getValue({ name: 'inventorylocation' });
    const availStr = r.getValue({ name: 'locationquantityavailable' }) || '0';
    const onHandStr = r.getValue({ name: 'locationquantityonhand' }) || '0';

    results.push({
      locId: loc,
      qtyAvailable: parseFloat(availStr),
      qtyOnHand: parseFloat(onHandStr)
    });
    return true;
  });

  // fill missing locIds with zero
  locIds.forEach(lid => {
    let found = results.find(x => x.locId == lid);
    if (!found) {
      results.push({
        locId: lid,
        qtyAvailable: 0,
        qtyOnHand: 0
      });
    }
  });

  // sort results in the same order as locIds
  results.sort((a, b) => locIds.indexOf(a.locId) - locIds.indexOf(b.locId));
  return results;
}
      
    
      // Mark completed => sets process status = 3
      function markCompleted(recIds, adjId) {
        log.debug('function markCompleted')
        recIds.forEach(rId => {
          try {
            record.submitFields({
              type: CONFIG.CUSTOM_RECORD_TYPE,
              id: rId,
              values: {
                [CONFIG.FIELD_PROCESS_STATUS]: CONFIG.STATUS_COMPLETED
                // If needed, store the adjId in a custom field as well
              }
            });
          } catch (e) {
            log.error('markCompleted error', `ID=${rId}, e=${e.message}`);
          }
        });
      }
    
      // Mark error => sets process status = 4
      function markError(recIds, errMsg) {
        log.debug('function markError')

        recIds.forEach(rId => {
          try {
            record.submitFields({
              type: CONFIG.CUSTOM_RECORD_TYPE,
              id: rId,
              values: {
                [CONFIG.FIELD_PROCESS_STATUS]: CONFIG.STATUS_ERROR
              }
            });
          } catch (e) {
            log.error('markError error', `ID=${rId}, e=${e.message}`);
          }
        });
      }
    
      return {
        getInputData,
        map,
        reduce,
        summarize
      };
    });
