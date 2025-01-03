/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define(['N/record', 'N/search', 'N/log'], (record, search, log) => {

  function getInputData() {
    const searchId = 'customsearch_mg_mr_3plshipmentprocessor';
    log.audit('getInputData', `Loading search ID: ${searchId}`);

    let loadedSearch;
    try {
      loadedSearch = search.load({ id: searchId });
    } catch (e) {
      log.error('getInputData - Error Loading Search', `Search ID: ${searchId}, Error: ${e.message}`);
      throw e;
    }

    log.audit('getInputData', `Search Loaded Successfully: ${searchId}`);
    return loadedSearch;
  }

  /**
   *   For each search result, parse the row, log debug info, group by 3PL shipment key.
   */
  function map(context) {
    try {
      const searchResult = JSON.parse(context.value);
      log.debug('map - Raw Search Result', JSON.stringify(searchResult, null, 2));

      const shipmentRef = searchResult.values['custrecord_pkgitem_shipment'];
      const shipmentId = shipmentRef?.value || null;

      log.debug('map - Shipment ID', shipmentId);

      if (shipmentId) {
        context.write({
          key: shipmentId,
          value: searchResult
        });
      } else {
        log.warning('map - Missing Shipment ID', `Search Result ID: ${searchResult.id}`);
      }

    } catch (e) {
      log.error('map - Error Parsing Context Value', e.message);
    }
  }

  /**
   * reduce():
   *   For each grouped shipment ID:
   *     - Validate totals
   *     - Set status or error
   *     - Load IF, allocate lines, set itemreceive, handle shortships
   *     - Save IF, load SO, update short-ship fields
   *     - Mark final status
   */
  function reduce(context) {
    const shipmentId = context.key;
    log.audit('reduce - ShipmentID', shipmentId);

    // Parse lines from the map stage
    let lines;
    try {
      lines = context.values.map(JSON.parse);
    } catch (e) {
      log.error(`reduce - JSON Parse Error for shipment ${shipmentId}`, e.message);
      // Mark error on the shipment record, skip
      setShipmentStatus(shipmentId, 4, `JSON parse error in reduce: ${e.message}`);
      return;
    }

    log.debug('reduce - lines array', JSON.stringify(lines, null, 2));

    try {
      /************************************************
       * 1) Aggregate data & basic validations
       ************************************************/
      let totalQuantityFromLines = 0;
      let totalQuantityField = 0;
      let distinctPackages = {};
      let totalCartonsField = 0;
      let dateShipped = null;
      let itemFulfillmentId = null;
      let maxLabelCost = 0;

      // For item aggregation
      let aggregatedItems = {};

      lines.forEach(line => {

        log.debug('reduce - processing line', line);

        let itemId = line.values['custrecord_pkgitem_item']?.value;
        let qty = parseFloat(line.values['custrecord_pkgitem_qty']) || 0;
        const pkgId = line.values['custrecord_pkgitem_pkg']?.value;

        totalQuantityFromLines += qty;
        if (pkgId) {
          if (!distinctPackages[pkgId]) {

            const rawWeight = parseFloat(line.values['custrecord_pkg_weight.CUSTRECORD_PKGITEM_PKG']) || 0.001;
            const trackNum = line.values['custrecord_pkg_trackingnum.CUSTRECORD_PKGITEM_PKG'] || '';
            const trackUrl = line.values['custrecord_pkg_trackingurl.CUSTRECORD_PKGITEM_PKG'] || '';
            const carrier = line.values['custrecord_pkg_carrier.CUSTRECORD_PKGITEM_PKG'] || '';


            distinctPackages[pkgId] = {
              pkgId: pkgId,
              weightLbs: rawWeight,
              trackingNum: trackNum,
              trackingUrl: trackUrl,
              carrier: carrier
            };
          }
        }

        itemFulfillmentId = line.values['custrecord_pkgitem_if']?.value;
        dateShipped = line.values['custrecord_shipment_date_shipped.CUSTRECORD_PKGITEM_SHIPMENT'];

        // The "header" fields for total quantity, total cartons
        totalQuantityField = parseFloat(
          line.values['custrecord_shipment_total_quantity.CUSTRECORD_PKGITEM_SHIPMENT']
        ) || 0;

        totalCartonsField = parseFloat(
          line.values['custrecord_shipment_totalcartons.CUSTRECORD_PKGITEM_SHIPMENT']
        ) || 0;

        // Aggregate item quantity from each shipment line
        if (itemId) {
          aggregatedItems[itemId] = (aggregatedItems[itemId] || 0) + qty;
        } else {
          log.warning('reduce - Missing Item ID', `Line: ${JSON.stringify(line)}`);
        }

        // Find the max cost for each shipping label
        const rawCostStr = line.values['custrecord_pkg_label_cost.CUSTRECORD_PKGITEM_PKG'];
        const cost = parseFloat(rawCostStr) || 0;
        if (cost > maxLabelCost) {
          maxLabelCost = cost;
        }
        log.debug('maxLabelCost',maxLabelCost)
      });

      let distinctPackageCount = Object.keys(distinctPackages).length;

      log.debug('reduce - totalQuantityFromLines', totalQuantityFromLines);
      log.debug('reduce - totalQuantityField', totalQuantityField);
      log.debug('reduce - distinctPackageCount', distinctPackageCount);
      log.debug('reduce - totalCartonsField', totalCartonsField);

      // Validate totals
      if (totalQuantityFromLines !== totalQuantityField ||
        distinctPackageCount !== totalCartonsField) {
        let errorMsg = `Mismatch in QTY or Cartons. Summed QTY=${totalQuantityFromLines}, ` +
          `Field QTY=${totalQuantityField}, PackagesFound=${distinctPackageCount}, FieldCartons=${totalCartonsField}`;
        log.error('reduce - Quantity/Carton Mismatch', errorMsg);
        setShipmentStatus(shipmentId, 4, errorMsg);
        return; // Skip processing
      }

      // Mark the shipment as "Processing" = 2
      setShipmentStatus(shipmentId, 2);

      if (!itemFulfillmentId) {
        let errNote = 'No Item Fulfillment Found for this shipment.';
        log.error('reduce - Missing IF', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      /************************************************
       * 2) Load IF, gather lines in ascending line ID
       ************************************************/
      let ifRec;
      try {
        ifRec = record.load({
          type: record.Type.ITEM_FULFILLMENT,
          id: itemFulfillmentId,
          isDynamic: true
        });
      } catch (e) {
        let errNote = `Failed to load IF ${itemFulfillmentId} for shipment ${shipmentId}: ${e.message}`;
        log.error('reduce - Error Loading IF', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }


      // Check if the IF is already shipped
      const currentIFStatus = ifRec.getValue({ fieldId: 'shipstatus' }); // e.g. 'C' means shipped
      if (currentIFStatus === 'C') {
        let errNote = `IF ${itemFulfillmentId} is already in Shipped status. Aborting.`;
        log.error('reduce - IF Already Shipped', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      const soInternalId = ifRec.getValue({ fieldId: 'createdfrom' });
      if (!soInternalId) {
        let errNote = 'No Sales Order on IF. Cannot proceed.';
        log.error('reduce - Missing SO', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      let ifLines = gatherIFLines(ifRec);
      log.debug('reduce - Gathered IF Lines', JSON.stringify(ifLines));

      /************************************************
       * 3) Allocate IF lines & handle short-ship array
       ************************************************/
      let shortShips = [];

      // For each aggregated item, fill lines in ascending line ID
      for (let itemId in aggregatedItems) {
        let qtyToFulfill = aggregatedItems[itemId];
        for (let li of ifLines) {
          if (li.itemId === itemId && qtyToFulfill > 0) {
            const used = Math.min(li.origQty, qtyToFulfill);
            li.usedQty = used;
            li.itemReceive = true;
            qtyToFulfill -= used;
          }
        }
      }

      // Now commit each line
      for (let li of ifLines) {
        let used = li.usedQty || 0;
        let shortShip = li.origQty - used;

        ifRec.selectLine({ sublistId: 'item', line: li.index });

        if (used > 0) {

          ifRec.setCurrentSublistValue({
            sublistId: 'item',
            fieldId: 'itemreceive',
            value: true
          });
          ifRec.setCurrentSublistValue({
            sublistId: 'item',
            fieldId: 'quantity',
            value: used
          });
        } else {
          ifRec.setCurrentSublistValue({
            sublistId: 'item',
            fieldId: 'itemreceive',
            value: false
          });
        }


        ifRec.commitLine({ sublistId: 'item' });

        if (shortShip > 0) {
          shortShips.push({
            orderLine: li.orderLine,
            shortQty: shortShip,
            ifId: itemFulfillmentId,
            docNum: ifRec.getValue({ fieldId: 'tranid' }),
            itemName: li.itemName
          });
        }
      }


      /************************************************
       * 4) Mark IF Shipped, Set Date, add Package Info, save
       ************************************************/
      ifRec.setValue({ fieldId: 'shipstatus', value: 'C' }); // "Shipped"
      if (dateShipped) {
        let dt = parseDateString(dateShipped);
        if (dt) {
          ifRec.setValue({ fieldId: 'trandate', value: dt });
        } else {
          log.warning('reduce - Invalid Date Shipped', `Unable to parse date: ${dateShipped}`);
        }
      }

      let anyShortShip = (shortShips.length > 0);


      if (anyShortShip) {
        const shortShipPayload = shortShips.map(s => ({
          itemName: s.itemName,
          qty: s.shortQty
        }));

        ifRec.setValue({
          fieldId: 'custbody_mg_if_shortshipped_items',
          value: JSON.stringify(shortShipPayload)
        });
      } else {
        ifRec.setValue({
          fieldId: 'custbody_mg_if_shortshipped_items',
          value: '[]'
        });
      }

        ifRec.setValue({
          fieldId: 'custbody_mg_shippinglabel_cost',
          value: maxLabelCost
        });
      
      if (distinctPackageCount > 0) {
        log.debug('reduce', `Found ${distinctPackageCount} packages, adding them to the IF...`);
        addPackagesToIF(ifRec, distinctPackages);
      } else {
        log.debug('reduce', 'No packages found, skipping addPackagesToIF()');
      }

      try {
        ifRec.save();
        log.audit('reduce - IF Saved', `IF ID: ${itemFulfillmentId}, Shipment: ${shipmentId}`);
      } catch (e) {
        let errNote = `Failed to save IF ${itemFulfillmentId}. Error: ${e.message}`;
        log.error('reduce - IF Save Error', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      /************************************************
       * 5) Load SO, update short-ship fields
       ************************************************/
      let soRec;
      try {
        soRec = record.load({
          type: record.Type.SALES_ORDER,
          id: soInternalId,
          isDynamic: true
        });
        log.debug('SO Loaded', soInternalId);
      } catch (e) {
        let errNote = `Failed to load SO ${soInternalId} for short-ship update: ${e.message}`;
        log.error('reduce - SO Load Error', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      // For each shortShip, find the SO line by orderLine
      shortShips.forEach(s => {
        log.debug('SO Shortship Line id s.orderLine', s.orderLine);

        soRec.selectLine({ sublistId: 'item', line: s.orderLine - 1 });

        // increment custcol_mg_shortship_quantity
        let existingShort = parseFloat(
          soRec.getCurrentSublistValue({
            sublistId: 'item',
            fieldId: 'custcol_mg_shortship_quantity'
          })
        ) || 0;
        soRec.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_mg_shortship_quantity',
          value: existingShort + s.shortQty
        });

        // add to shortship_details field
        let existingDetails = soRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_mg_shortship_details'
        }) || '';
        let detailsObj = {};
        if (existingDetails) {
          try {
            detailsObj = JSON.parse(existingDetails);
          } catch (parseErr) {
            log.error('reduce - JSON parse error on shortship details', parseErr.message);
            // fallback to empty
            detailsObj = {};
          }
        }
        let currentVal = detailsObj[s.docNum] || 0;
        detailsObj[s.docNum] = currentVal + s.shortQty;

        soRec.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'custcol_mg_shortship_details',
          value: JSON.stringify(detailsObj)
        });
        log.debug('SO custcol_mg_shortship_details to set', JSON.stringify(detailsObj));

        soRec.commitLine({ sublistId: 'item' });
      });

      if (anyShortShip) {
        soRec.setValue({
          fieldId: 'custbody_mg_fulfillmenthold',
          value: 4
        });
        log.debug('SO custbody_mg_fulfillmenthold set to', '4');
      }

      // Save the SO
      try {
        soRec.save();
        log.audit('reduce - SO Saved', `SO ID: ${soInternalId}, Shipment: ${shipmentId}`);
      } catch (e) {
        let errNote = `Failed to save SO ${soInternalId}. Error: ${e.message}`;
        log.error('reduce - SO Save Error', errNote);
        setShipmentStatus(shipmentId, 4, errNote);
        return;
      }

      /************************************************
       * 6) Mark 3PL Shipment => "Processed"
       ************************************************/
      setShipmentStatus(shipmentId, 3);
      log.audit('reduce - Shipment Processed', `Shipment: ${shipmentId} => Status=Processed (3)`);

    } catch (err) {
      log.error(`reduce - Shipment ${shipmentId} error`, err.message);
      setShipmentStatus(shipmentId, 4, err.message);
    }
  }

  /**
   * summarize():
   *   Log any errors from each stage
   */
  function summarize(summary) {
    log.audit('summarize', 'Script Summary Start');
    if (summary.inputSummary.error) {
      log.error('summarize - Input Error', summary.inputSummary.error);
    }
    summary.mapSummary.errors.iterator().each((key, msg) => {
      log.error(`summarize - Map Error on key ${key}`, msg);
      return true;
    });
    summary.reduceSummary.errors.iterator().each((key, msg) => {
      log.error(`summarize - Reduce Error on key ${key}`, msg);
      return true;
    });
    log.audit('summarize', 'Script Summary End');
  }

  /**************************************
   * Helper: setShipmentStatus()
   **************************************/
  function setShipmentStatus(shipmentId, statusId, errorNotes) {
    try {
      record.submitFields({
        type: 'customrecord_mg_shipment',
        id: shipmentId,
        values: {
          custrecord_shipment_script_processing_st: statusId,
          custrecord_shipment_script_error_notes: errorNotes || ''
        }
      });
      log.debug('setShipmentStatus', `Shipment ${shipmentId} => status ${statusId}, notes=${errorNotes}`);
    } catch (e) {
      log.error('setShipmentStatus Error', `Shipment ${shipmentId}, ${e.message}`);
    }
  }

  /**************************************
   * Helper: gatherIFLines(ifRec)
   *   Return an array sorted by line ID ascending
   **************************************/
  function gatherIFLines(ifRec) {
    let lines = [];
    try {
      let count = ifRec.getLineCount({ sublistId: 'item' });
      for (let i = 0; i < count; i++) {
        ifRec.selectLine({ sublistId: 'item', line: i });

        let lineId = ifRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'line'
        });
        let itemId = ifRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'item'
        });
        let origQty = parseFloat(ifRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'quantity'
        })) || 0;
        let orderLine = parseInt(ifRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'orderline'
        })) || null;
        let itemName = ifRec.getCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'itemname'
        }) || '';
        log.debug('itemName', itemName)

        lines.push({
          index: i,
          lineId: parseInt(lineId),
          itemId: itemId,
          itemName: itemName,
          origQty: origQty,
          orderLine: orderLine,
          usedQty: 0,
          itemReceive: false
        });
      }
      // sort by ascending line ID
      lines.sort((a, b) => a.lineId - b.lineId);
      log.debug('gatherIFLines', `Gathered ${lines.length} lines from IF, sorted asc by lineId`);
    } catch (e) {
      log.error('gatherIFLines Error', e.message);
      // Return partial lines if something fails or empty
    }
    return lines;
  }

  /**************************************
   * Helper: parseDateString()
   **************************************/
  function parseDateString(dateString) {
    if (!dateString) return null;
    let d = new Date(dateString);
    if (isNaN(d.getTime())) {
      log.warning('parseDateString - Invalid Date', `Cannot parse: ${dateString}`);
      return null;
    }
    return d;
  }

  /**************************************
   * Helper: findSOLineByOrderLine()
   **************************************/
  function findSOLineByOrderLine(soRec, orderLineNumber) {
    if (orderLineNumber == null) return null;
    let count = soRec.getLineCount({ sublistId: 'item' });

    for (let i = 0; i < count; i++) {
      soRec.selectLine({ sublistId: 'item', line: i });
      let soOrderLineVal = soRec.getCurrentSublistValue({
        sublistId: 'item',
        fieldId: 'orderline'
      });
      if (parseInt(soOrderLineVal) === orderLineNumber) {
        return i; // found the matching line
      } else {
        soRec.commitLine({ sublistId: 'item' });
      }
    }
    return null;
  }

  /**************************************
   * Helper: addPackagesToIF()
   **************************************/
  function addPackagesToIF(ifRec, distinctPackages) {
    // 1) Clear existing package lines
    let pkgCount = ifRec.getLineCount({ sublistId: 'package' }) || 0;
    for (let i = pkgCount - 1; i >= 0; i--) {
      ifRec.removeLine({ sublistId: 'package', line: i });
    }

    // 2) Add new package lines

    const pkgIds = Object.keys(distinctPackages);
    pkgIds.forEach(pkgId => {
      const pkgObj = distinctPackages[pkgId];

      ifRec.selectNewLine({ sublistId: 'package' });

      ifRec.setCurrentSublistValue({
        sublistId: 'package',
        fieldId: 'packagetrackingnumber',
        value: pkgObj.trackingNum
      });
      ifRec.setCurrentSublistValue({
        sublistId: 'package',
        fieldId: 'packageweight',
        value: pkgObj.weightLbs.toFixed(3)
      });

      ifRec.setCurrentSublistValue({
        sublistId: 'package',
        fieldId: 'packagedescr',
        value: (pkgObj.carrier || '') + '|' + (pkgObj.trackingUrl || '')
      });

      ifRec.commitLine({ sublistId: 'package' });
    });

    log.debug('addPackagesToIF',
      `Added ${pkgIds.length} package(s) to IF ${ifRec.id} from distinctPackages.`);
  }

  return {
    getInputData,
    map,
    reduce,
    summarize
  };
});
