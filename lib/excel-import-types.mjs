/**
 * Excel Import agents — what each SAP object looks like to the import engine
 * (controllers/excel-import-agent.mjs).
 *
 * Per type:
 *   entity / lineCollection   Service Layer resource and its line collection (if any)
 *   tables                    SAP tables (header, line) — UDFs are read from these
 *   fields                    the catalog the mapper offers (target "header.X" / "line.X")
 *                             lookup: checked / resolved against SAP master data
 *                             (see LOOKUPS in the engine); core: SAP needs it
 *   summary(rec)              code / name / date / due / ref shown in the lists
 *   value(rec)                the amount shown in the lists (null → no value column)
 *   payload(rec, ctx)         the body sent to SAP; result(r, rec) → { docEntry, docNum }
 *   rules(rec)                type-specific checks on one record (beyond required / types)
 *   templateCheck(tpl)        type-specific template validation messages
 *   standard                  the built-in templates every company starts with
 */

const H = (field, label, type, extra = {}) => ({ target: `header.${field}`, field, level: 'header', label, type, ...extra });
const L = (field, label, type, extra = {}) => ({ target: `line.${field}`, field, level: 'line', label, type, ...extra });
// Built-in template column
const C = (id, heading, target, extra = {}) => ({ id, heading, aliases: [], target, required: false, default: '', groupKey: false, example: '', ...extra });

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const blank = v => v == null || v === '';

// ── Sales Order ───────────────────────────────────────────────────────────────
const ORDER_FIELDS = [
  H('CardCode', 'Customer Code', 'text', { lookup: 'customer', core: true, aliases: ['customercode', 'cardcode', 'bpcode', 'custcode', 'partycode', 'customerid', 'customer'] }),
  H('DocDate', 'Posting Date', 'date', { aliases: ['postingdate', 'docdate', 'orderdate', 'documentdate', 'date'] }),
  H('DocDueDate', 'Delivery Date', 'date', { core: true, aliases: ['deliverydate', 'duedate', 'docduedate', 'requireddate', 'shipdate', 'reqdate', 'shipby', 'mustshipby', 'requestedshipdate', 'requesteddeliverydate', 'mustarriveby'] }),
  H('TaxDate', 'Document Date', 'date', { aliases: ['taxdate'] }),
  H('NumAtCard', 'Customer Ref. / PO No', 'text', { max: 100, aliases: ['customerpono', 'customerpo', 'custpono', 'pono', 'ponumber', 'customerref', 'customerreference', 'numatcard', 'customerrefno'] }),
  H('Comments', 'Remarks', 'text', { max: 254, aliases: ['remarks', 'comments', 'headerremarks', 'orderremarks', 'note', 'notes'] }),
  H('JournalMemo', 'Journal Remark', 'text', { max: 254, aliases: ['journalremark', 'journalmemo'] }),
  H('SalesPersonCode', 'Sales Employee (code or name)', 'text', { lookup: 'salesPerson', aliases: ['salesemployee', 'salesperson', 'salespersoncode', 'slpcode', 'salesemployeecode', 'salesemployeename'] }),
  H('DocumentsOwner', 'Owner (employee ID)', 'int', { aliases: ['owner', 'ownercode', 'documentsowner'] }),
  H('BPL_IDAssignedToInvoice', 'Branch (ID or name)', 'text', { lookup: 'branch', aliases: ['branch', 'branchid', 'bplid', 'bplname', 'branchname'] }),
  H('DocCurrency', 'Document Currency', 'text', { max: 3, aliases: ['currency', 'doccurrency', 'doccur'] }),
  H('DocRate', 'Exchange Rate', 'number', { aliases: ['exchangerate', 'docrate'] }),
  H('PaymentGroupCode', 'Payment Terms (code or name)', 'text', { lookup: 'paymentTerms', aliases: ['paymentterms', 'paymenttermscode', 'paymentgroupcode', 'groupnum'] }),
  H('ShipToCode', 'Ship-to Address ID', 'text', { max: 50, aliases: ['shipto', 'shiptocode', 'shiptoaddress', 'deliveryaddress'] }),
  H('PayToCode', 'Bill-to Address ID', 'text', { max: 50, aliases: ['billto', 'paytocode', 'billtoaddress'] }),
  H('TransportationCode', 'Shipping Type Code', 'int', { aliases: ['shippingtype', 'transportationcode', 'trnspcode'] }),
  H('ContactPersonCode', 'Contact Person Code', 'int', { aliases: ['contactperson', 'contactpersoncode', 'cntctcode'] }),
  H('Series', 'Numbering Series', 'int', { aliases: ['series', 'numberingseries'] }),
  H('Project', 'Project (header)', 'text', { aliases: ['project', 'projectcode'] }),
  H('DiscountPercent', 'Header Discount %', 'number', { aliases: ['headerdiscount', 'documentdiscount'] }),
  L('ItemCode', 'Item Code', 'text', { lookup: 'salesItem', core: true, aliases: ['itemcode', 'itemno', 'sku', 'productcode', 'materialcode', 'item', 'vendoritem', 'vendoritemno', 'supplieritem', 'vendorstockno', 'vendorsku', 'partno', 'partnumber'] }),
  L('ItemDescription', 'Item Description (overrides SAP name)', 'text', { max: 200 }),
  L('Quantity', 'Quantity', 'number', { core: true, aliases: ['quantity', 'qty', 'orderqty', 'orderedqty', 'cases', 'units', 'pcs', 'qtyordered', 'quantityordered'] }),
  L('UnitPrice', 'Unit Price (before discount)', 'number', { aliases: ['unitprice', 'price', 'rate', 'priceperunit', 'cost', 'unitcost', 'listprice'] }),
  L('Price', 'Price after Discount', 'number', { aliases: ['priceafterdiscount', 'netprice'] }),
  L('DiscountPercent', 'Line Discount %', 'number', { aliases: ['discount', 'discountpercent', 'discountpct', 'disc', 'discpercent'] }),
  L('Currency', 'Line Currency', 'text', { max: 3, aliases: ['linecurrency'] }),
  L('TaxCode', 'Tax Code', 'text', { lookup: 'tax', aliases: ['taxcode', 'tax', 'gstcode'] }),
  L('VatGroup', 'VAT Group', 'text', { lookup: 'tax', aliases: ['vatgroup', 'vatcode'] }),
  L('WarehouseCode', 'Warehouse', 'text', { lookup: 'warehouse', aliases: ['warehouse', 'warehousecode', 'whscode', 'whs'] }),
  L('UoMCode', 'UoM Code', 'text', { aliases: ['uom', 'uomcode', 'unit', 'unitofmeasure'] }),
  L('FreeText', 'Line Remarks (free text)', 'text', { max: 100, aliases: ['lineremarks', 'linecomments', 'freetext', 'linenote', 'linetext'] }),
  L('ShipDate', 'Line Delivery Date', 'date', { aliases: ['linedeliverydate', 'lineshipdate'] }),
  L('ProjectCode', 'Project (line)', 'text', { aliases: ['lineproject'] }),
  L('CostingCode', 'Distribution Rule 1', 'text', { aliases: ['costcenter', 'costingcode', 'distributionrule', 'ocrcode'] }),
  L('CostingCode2', 'Distribution Rule 2', 'text', { aliases: ['costingcode2', 'ocrcode2'] }),
  L('CostingCode3', 'Distribution Rule 3', 'text', { aliases: ['costingcode3', 'ocrcode3'] }),
  L('CostingCode4', 'Distribution Rule 4', 'text', { aliases: ['costingcode4', 'ocrcode4'] }),
  L('CostingCode5', 'Distribution Rule 5', 'text', { aliases: ['costingcode5', 'ocrcode5'] }),
  L('SalesPersonCode', 'Sales Employee — line (code or name)', 'text', { lookup: 'salesPerson', aliases: ['linesalesemployee'] }),
  L('AccountCode', 'G/L Account (number or name)', 'text', { lookup: 'account', aliases: ['glaccount', 'accountcode'] }),
  L('BarCode', 'Bar Code', 'text', { aliases: ['barcode', 'ean', 'upc'] }),
  L('SupplierCatNum', 'Customer Catalog No.', 'text', { aliases: ['customercatalogno', 'catalogno', 'suppliercatnum', 'customeritemcode'] }),
];

const docLineTotal = s => {
  const q = Number(s.Quantity) || 0;
  if (s.UnitPrice != null) return q * Number(s.UnitPrice) * (1 - (Number(s.DiscountPercent) || 0) / 100);
  if (s.Price != null) return q * Number(s.Price);
  return 0;
};
const fallbackComments = (rec, ctx, what) => blank(rec.header.sap.Comments)
  ? { Comments: `Imported from Excel${ctx.fileName ? ` ${ctx.fileName}` : ''} — ${what} ${rec.orderKey}`.slice(0, 254) } : {};
const docLines = rec => rec.lines.map(l => ({ ...l.sap }));

const order = {
  key: 'order', title: 'Sales Order Excel Import', short: 'Sales Orders', uploadTitle: 'Upload sales order sheet', icon: '📥', color: '#0070F2',
  subtitle: 'Map Excel columns to SAP fields · validate · post Sales Orders through the Service Layer',
  noun: 'Sales order', nouns: 'sales orders', docLabel: 'SO',
  perm: 'sales.workflow.so_excel_import', templatesPerm: ['sales.workflow.so_excel_import_templates'],
  entity: '/Orders', lineCollection: 'DocumentLines', tables: { header: 'ORDR', line: 'RDR1' },
  headerLabel: 'Documents — header (ORDR)', lineLabel: 'DocumentLines — lines (RDR1)',
  linesRequired: true,
  fields: ORDER_FIELDS,
  listLabels: { code: 'Customer', date: 'Posting date', due: 'Delivery date', ref: 'Customer PO' },
  valueLabel: 'Value (before tax)',
  summary: (rec, x) => ({ code: rec.header.sap.CardCode, name: x.cardName, date: rec.header.sap.DocDate, due: rec.header.sap.DocDueDate, ref: rec.header.sap.NumAtCard }),
  value: rec => r2(rec.lines.reduce((s, l) => s + docLineTotal(l.sap), 0)),
  lineTotal: docLineTotal,
  defaults: rec => { if (!rec.header.sap.DocDate) rec.header.sap.DocDate = new Date().toISOString().slice(0, 10); },
  rules: rec => {
    const out = [];
    const h = rec.header.sap;
    if (h.DocDueDate && h.DocDate && h.DocDueDate < h.DocDate) out.push(`Delivery Date ${h.DocDueDate} is before Posting Date ${h.DocDate}`);
    return out;
  },
  lineRules: s => {
    const out = [];
    if (s.Quantity != null && s.Quantity <= 0) out.push('Quantity must be more than 0');
    if (s.UnitPrice != null && s.UnitPrice < 0) out.push('Unit Price cannot be negative');
    if (s.Price != null && s.Price < 0) out.push('Price cannot be negative');
    if (s.DiscountPercent != null && (s.DiscountPercent < 0 || s.DiscountPercent > 100)) out.push('Discount % must be between 0 and 100');
    return out;
  },
  payload: (rec, ctx) => ({ ...rec.header.sap, ...fallbackComments(rec, ctx, 'order'), DocumentLines: docLines(rec) }),
  result: r => ({ docEntry: r?.DocEntry, docNum: r?.DocNum }),
  standard: [{
    name: 'Standard Sales Order',
    description: 'One row per order line; rows with the same Order No form one sales order.',
    dateFormat: 'DMY', layout: 'table',
    columns: [
      C('orderKey', 'Order No', 'key', { required: true, groupKey: true, example: 'SO-1001', aliases: ['SO No', 'Sales Order No', 'Order Ref', 'Ref No', 'Document No'] }),
      C('cardCode', 'Customer Code', 'header.CardCode', { required: true, example: 'C00175', aliases: ['Card Code', 'BP Code', 'Party Code', 'Customer ID'] }),
      C('cardName', 'Customer Name', 'info.header', { example: 'Walmart, Inc.', aliases: ['Card Name', 'Party Name', 'BP Name'] }),
      C('docDate', 'Posting Date', 'header.DocDate', { example: '30/10/2026', aliases: ['Doc Date', 'Order Date', 'Document Date', 'Date'] }),
      C('dueDate', 'Delivery Date', 'header.DocDueDate', { required: true, example: '06/11/2026', aliases: ['Due Date', 'Required Date', 'Ship Date', 'Req Date'] }),
      C('numAtCard', 'Customer PO No', 'header.NumAtCard', { example: 'PO-7781', aliases: ['Customer PO', 'Cust PO No', 'PO No', 'PO Number', 'Customer Ref', 'Customer Reference'] }),
      C('salesPerson', 'Sales Employee', 'header.SalesPersonCode', { aliases: ['Sales Person', 'Sales Person Code', 'Slp Code'] }),
      C('branch', 'Branch', 'header.BPL_IDAssignedToInvoice', { aliases: ['Branch ID', 'BPL ID', 'Branch Name'] }),
      C('remarks', 'Remarks', 'header.Comments', { aliases: ['Comments', 'Order Remarks', 'Notes', 'Note'] }),
      C('itemCode', 'Item Code', 'line.ItemCode', { required: true, example: 'FG0100101006PD0EN01', aliases: ['Item No', 'SKU', 'Product Code', 'Material Code', 'Item'] }),
      C('itemName', 'Item Description', 'info.line', { example: 'Scrub Daddy 1ct x 6', aliases: ['Item Name', 'Description', 'Product Name'] }),
      C('quantity', 'Quantity', 'line.Quantity', { required: true, example: '10', aliases: ['Qty', 'Order Qty', 'Ordered Qty'] }),
      C('unitPrice', 'Unit Price', 'line.UnitPrice', { aliases: ['Price', 'Rate', 'Price per Unit'] }),
      C('discount', 'Discount %', 'line.DiscountPercent', { aliases: ['Discount', 'Disc', 'Disc %', 'Discount Percent'] }),
      C('taxCode', 'Tax Code', 'line.TaxCode', { aliases: ['Tax', 'GST Code'] }),
      C('warehouse', 'Warehouse', 'line.WarehouseCode', { example: '17SH', aliases: ['Warehouse Code', 'Whs Code', 'Whs'] }),
      C('uomCode', 'UoM', 'line.UoMCode', { aliases: ['UoM Code', 'Unit', 'Unit of Measure'] }),
      C('lineRemarks', 'Line Remarks', 'line.FreeText', { aliases: ['Line Comments', 'Free Text', 'Line Note'] }),
    ],
  }],
};

// ── Item Master ───────────────────────────────────────────────────────────────
const YES = { tYES: ['y', 'yes', 'true', '1', 'tyes'], tNO: ['n', 'no', 'false', '0', 'tno'] };
const item = {
  key: 'item', title: 'Item Master Import', short: 'Items', uploadTitle: 'Upload item master sheet', icon: '📦', color: '#0f766e',
  subtitle: 'Create or update SAP items from Excel · map columns to Item fields · price lists',
  noun: 'Item', nouns: 'items', docLabel: 'Item',
  perm: 'master.excel_import.item',
  entity: '/Items', lineCollection: 'ItemPrices', tables: { header: 'OITM', line: 'ITM1' },
  headerLabel: 'Items — item master (OITM)', lineLabel: 'ItemPrices — price lists (ITM1)',
  updatable: true, masterKey: 'ItemCode', keyEntity: (v, esc) => `/Items('${esc(v)}')`,
  fields: [
    H('ItemCode', 'Item Code', 'text', { lookup: 'newItem', core: true, max: 50, aliases: ['itemcode', 'itemno', 'sku', 'code', 'productcode', 'materialcode', 'partno'] }),
    H('ItemName', 'Item Description', 'text', { core: true, max: 200, aliases: ['itemname', 'description', 'itemdescription', 'productname', 'name'] }),
    H('ForeignName', 'Foreign Name', 'text', { max: 200, aliases: ['foreignname', 'foreigndescription', 'frgnname'] }),
    H('ItemsGroupCode', 'Item Group (number or name)', 'text', { lookup: 'itemGroup', aliases: ['itemgroup', 'group', 'itemsgroupcode', 'itmsgrpcod', 'category'] }),
    H('ItemType', 'Item Type', 'enum', { enum: { itItems: ['items', 'item', 'inventory', 'i'], itLabor: ['labor', 'labour', 'l'], itTravel: ['travel', 't'], itFixedAssets: ['fixedasset', 'fixedassets', 'asset', 'f'] }, aliases: ['itemtype'] }),
    H('InventoryItem', 'Inventory Item (Y/N)', 'enum', { enum: YES, aliases: ['inventoryitem', 'invntitem', 'stockitem'] }),
    H('SalesItem', 'Sales Item (Y/N)', 'enum', { enum: YES, aliases: ['salesitem', 'sellitem'] }),
    H('PurchaseItem', 'Purchase Item (Y/N)', 'enum', { enum: YES, aliases: ['purchaseitem', 'prchseitem'] }),
    H('BarCode', 'Bar Code', 'text', { max: 254, aliases: ['barcode', 'ean', 'upc', 'codebars'] }),
    H('Manufacturer', 'Manufacturer (code)', 'int', { aliases: ['manufacturer', 'firmcode'] }),
    H('SupplierCatalogNo', 'Mfr Catalog No.', 'text', { max: 50, aliases: ['mfrcatalogno', 'suppliercatalogno', 'suppcatnum', 'catalogno'] }),
    H('Mainsupplier', 'Preferred Vendor', 'text', { lookup: 'supplier', aliases: ['preferredvendor', 'mainsupplier', 'vendor', 'supplier', 'cardcode'] }),
    H('UoMGroupEntry', 'UoM Group (entry)', 'int', { aliases: ['uomgroup', 'uomgroupentry', 'ugpentry'] }),
    H('InventoryUOM', 'Inventory UoM', 'text', { max: 100, aliases: ['inventoryuom', 'invntryuom', 'uom', 'unit'] }),
    H('SalesUnit', 'Sales UoM', 'text', { max: 100, aliases: ['salesunit', 'salesuom'] }),
    H('PurchaseUnit', 'Purchasing UoM', 'text', { max: 100, aliases: ['purchaseunit', 'purchaseuom', 'buyunitmsr'] }),
    H('SalesItemsPerUnit', 'Items per Sales Unit', 'number', { aliases: ['salesitemsperunit', 'numinsale'] }),
    H('PurchaseItemsPerUnit', 'Items per Purchase Unit', 'number', { aliases: ['purchaseitemsperunit', 'numinbuy'] }),
    H('ManageBatchNumbers', 'Manage Batch Numbers (Y/N)', 'enum', { enum: YES, aliases: ['managebatchnumbers', 'batch', 'batchmanaged'] }),
    H('ManageSerialNumbers', 'Manage Serial Numbers (Y/N)', 'enum', { enum: YES, aliases: ['manageserialnumbers', 'serial', 'serialmanaged'] }),
    H('DefaultWarehouse', 'Default Warehouse', 'text', { lookup: 'warehouse', aliases: ['defaultwarehouse', 'dfltwh', 'warehouse', 'whscode'] }),
    H('MinInventory', 'Minimum Inventory', 'number', { aliases: ['mininventory', 'minlevel', 'minstock', 'reorderlevel'] }),
    H('MaxInventory', 'Maximum Inventory', 'number', { aliases: ['maxinventory', 'maxlevel', 'maxstock'] }),
    H('MinOrderQuantity', 'Minimum Order Qty', 'number', { aliases: ['minorderquantity', 'minordrqty', 'moq'] }),
    H('LeadTime', 'Lead Time (days)', 'int', { aliases: ['leadtime', 'leadtimedays'] }),
    H('SalesVATGroup', 'Sales Tax / VAT Group', 'text', { lookup: 'tax', aliases: ['salesvatgroup', 'salestaxcode', 'vatgourpsa'] }),
    H('PurchaseVATGroup', 'Purchase Tax / VAT Group', 'text', { lookup: 'tax', aliases: ['purchasevatgroup', 'purchasetaxcode', 'vatgroupPu'] }),
    H('GLMethod', 'G/L Accounts by', 'enum', { enum: { glm_WH: ['warehouse', 'wh'], glm_ItemClass: ['itemgroup', 'group', 'itemclass'], glm_ItemLevel: ['itemlevel', 'item'] }, aliases: ['glmethod', 'setglaccountsby'] }),
    H('CostAccountingMethod', 'Valuation Method', 'enum', { enum: { bis_MovingAverage: ['movingaverage', 'average', 'ma'], bis_Standard: ['standard', 's'], bis_FIFO: ['fifo'], bis_SNB: ['serialbatch', 'snb'] }, aliases: ['valuationmethod', 'costaccountingmethod', 'evalsystem'] }),
    H('PlanningSystem', 'Planning Method', 'enum', { enum: { bop_MRP: ['mrp'], bop_None: ['none', 'no'] }, aliases: ['planningsystem', 'planningmethod'] }),
    H('ProcurementMethod', 'Procurement Method', 'enum', { enum: { bom_Buy: ['buy', 'purchase'], bom_Make: ['make', 'produce', 'production'] }, aliases: ['procurementmethod', 'prcrmntmtd'] }),
    H('User_Text', 'Remarks', 'text', { aliases: ['remarks', 'usertext', 'notes', 'comments'] }),
    H('Valid', 'Active (Y/N)', 'enum', { enum: YES, aliases: ['active', 'valid', 'validfor'] }),
    H('Frozen', 'Inactive (Y/N)', 'enum', { enum: YES, aliases: ['inactive', 'frozen', 'frozenfor'] }),
    L('PriceList', 'Price List No.', 'int', { aliases: ['pricelist', 'pricelistno', 'pricelistnum'] }),
    L('Price', 'Price', 'number', { aliases: ['price', 'unitprice', 'listprice', 'rate'] }),
    L('Currency', 'Price Currency', 'text', { max: 3, aliases: ['currency', 'pricecurrency'] }),
  ],
  listLabels: { code: 'Item', date: null, due: null, ref: 'Group' },
  valueLabel: null,
  summary: (rec, x) => ({ code: rec.header.sap.ItemCode, name: rec.header.sap.ItemName || x.name, ref: rec.header.cells?.__groupName || String(rec.header.sap.ItemsGroupCode ?? '') }),
  value: () => null,
  lineRules: s => (s.PriceList == null && s.Price != null ? ['Price List No. is missing for this price'] : []),
  payload: (rec, ctx) => {
    const body = { ...rec.header.sap };
    const prices = rec.lines.map(l => l.sap).filter(s => s.PriceList != null);
    if (prices.length) body.ItemPrices = prices;
    if (rec.header.mode === 'update') delete body.ItemCode;
    return body;
  },
  result: (r, rec) => ({ docEntry: null, docNum: r?.ItemCode || rec.header.sap.ItemCode }),
  standard: [{
    name: 'Standard Item Master', description: 'One row per item. Add rows with the same Item Code to load more than one price list.',
    dateFormat: 'DMY', layout: 'table', options: { onExisting: 'error' },
    columns: [
      C('itemCode', 'Item Code', 'header.ItemCode', { required: true, groupKey: true, example: 'FG0100101006PD0EN99', aliases: ['Item No', 'SKU', 'Code'] }),
      C('itemName', 'Item Description', 'header.ItemName', { required: true, example: 'Scrub Daddy - Blue 1ct', aliases: ['Item Name', 'Description', 'Name'] }),
      C('foreignName', 'Foreign Name', 'header.ForeignName'),
      C('group', 'Item Group', 'header.ItemsGroupCode', { example: '100', aliases: ['Group', 'Category'] }),
      C('inv', 'Inventory Item', 'header.InventoryItem', { example: 'Y' }),
      C('sales', 'Sales Item', 'header.SalesItem', { example: 'Y' }),
      C('purch', 'Purchase Item', 'header.PurchaseItem', { example: 'Y' }),
      C('uom', 'Inventory UoM', 'header.InventoryUOM', { example: 'EA', aliases: ['UoM', 'Unit'] }),
      C('salesUnit', 'Sales UoM', 'header.SalesUnit', { example: 'Case' }),
      C('purchUnit', 'Purchasing UoM', 'header.PurchaseUnit', { example: 'Case' }),
      C('barcode', 'Bar Code', 'header.BarCode', { aliases: ['UPC', 'EAN'] }),
      C('vendor', 'Preferred Vendor', 'header.Mainsupplier', { aliases: ['Vendor', 'Supplier'] }),
      C('whs', 'Default Warehouse', 'header.DefaultWarehouse', { example: '17SH', aliases: ['Warehouse'] }),
      C('batch', 'Manage Batch', 'header.ManageBatchNumbers', { example: 'N', aliases: ['Batch'] }),
      C('serial', 'Manage Serial', 'header.ManageSerialNumbers', { example: 'N', aliases: ['Serial'] }),
      C('min', 'Min Stock', 'header.MinInventory', { aliases: ['Minimum Inventory', 'Reorder Level'] }),
      C('max', 'Max Stock', 'header.MaxInventory', { aliases: ['Maximum Inventory'] }),
      C('remarks', 'Remarks', 'header.User_Text', { aliases: ['Notes'] }),
      C('priceList', 'Price List', 'line.PriceList', { example: '1', aliases: ['Price List No'] }),
      C('price', 'Price', 'line.Price', { example: '4.85', aliases: ['List Price', 'Unit Price'] }),
      C('currency', 'Currency', 'line.Currency', { example: 'USD' }),
    ],
  }],
};

// ── Business Partner ──────────────────────────────────────────────────────────
const bp = {
  key: 'bp', title: 'Business Partner Import', short: 'Business Partners', uploadTitle: 'Upload business partner sheet', icon: '🤝', color: '#1d4ed8',
  subtitle: 'Create or update customers, vendors and leads from Excel · with bill-to / ship-to addresses',
  noun: 'Business partner', nouns: 'business partners', docLabel: 'BP',
  perm: 'master.excel_import.bp',
  entity: '/BusinessPartners', lineCollection: 'BPAddresses', tables: { header: 'OCRD', line: 'CRD1' },
  headerLabel: 'BusinessPartners — master (OCRD)', lineLabel: 'BPAddresses — addresses (CRD1)',
  updatable: true, masterKey: 'CardCode', keyEntity: (v, esc) => `/BusinessPartners('${esc(v)}')`,
  fields: [
    H('CardCode', 'BP Code', 'text', { lookup: 'newBP', core: true, max: 50, aliases: ['bpcode', 'cardcode', 'customercode', 'vendorcode', 'suppliercode', 'partycode', 'code'] }),
    H('CardName', 'BP Name', 'text', { core: true, max: 100, aliases: ['bpname', 'cardname', 'customername', 'vendorname', 'suppliername', 'partyname', 'name', 'companyname'] }),
    H('CardType', 'BP Type (Customer / Vendor / Lead)', 'enum', { core: true, enum: { cCustomer: ['customer', 'c', 'cust', 'ccustomer'], cSupplier: ['vendor', 'supplier', 's', 'v', 'csupplier'], cLid: ['lead', 'l', 'clid'] }, aliases: ['bptype', 'cardtype', 'type'] }),
    H('GroupCode', 'BP Group (code or name)', 'text', { lookup: 'bpGroup', aliases: ['bpgroup', 'groupcode', 'group', 'customergroup', 'vendorgroup'] }),
    H('CardForeignName', 'Foreign Name', 'text', { max: 100, aliases: ['foreignname', 'cardfname'] }),
    H('Currency', 'Currency', 'text', { max: 3, aliases: ['currency', 'bpcurrency'] }),
    H('FederalTaxID', 'Federal Tax ID / PAN', 'text', { max: 32, aliases: ['federaltaxid', 'taxid', 'licTradNum', 'pan', 'ein', 'vatno'] }),
    H('Phone1', 'Telephone 1', 'text', { max: 20, aliases: ['phone', 'phone1', 'telephone', 'tel'] }),
    H('Phone2', 'Telephone 2', 'text', { max: 20, aliases: ['phone2', 'telephone2'] }),
    H('Cellular', 'Mobile', 'text', { max: 50, aliases: ['mobile', 'cellular', 'cell', 'mobileno'] }),
    H('Fax', 'Fax', 'text', { max: 20, aliases: ['fax'] }),
    H('EmailAddress', 'E-mail', 'text', { max: 100, aliases: ['email', 'emailaddress', 'mail'] }),
    H('Website', 'Website', 'text', { max: 100, aliases: ['website', 'web', 'url'] }),
    H('ContactPerson', 'Contact Person', 'text', { max: 90, aliases: ['contactperson', 'contact', 'cntctprsn'] }),
    H('PayTermsGrpCode', 'Payment Terms (code or name)', 'text', { lookup: 'paymentTerms', aliases: ['paymentterms', 'paytermsgrpcode', 'terms', 'groupnum'] }),
    H('PriceListNum', 'Price List No.', 'int', { aliases: ['pricelist', 'pricelistnum', 'listnum'] }),
    H('CreditLimit', 'Credit Limit', 'number', { aliases: ['creditlimit', 'creditline'] }),
    H('MaxCommitment', 'Commitment Limit', 'number', { aliases: ['commitmentlimit', 'maxcommitment', 'debtline'] }),
    H('DiscountPercent', 'Discount %', 'number', { aliases: ['discount', 'discountpercent'] }),
    H('SalesPersonCode', 'Sales Employee (code or name)', 'text', { lookup: 'salesPerson', aliases: ['salesemployee', 'salesperson', 'slpcode'] }),
    H('DebitorAccount', 'Control Account (number or name)', 'text', { lookup: 'account', aliases: ['controlaccount', 'debitoraccount', 'arapaccount', 'debpayacct'] }),
    H('Industry', 'Industry (code)', 'int', { aliases: ['industry', 'industrycode'] }),
    H('FreeText', 'Remarks', 'text', { aliases: ['remarks', 'freetext', 'notes', 'comments'] }),
    H('Valid', 'Active (Y/N)', 'enum', { enum: YES, aliases: ['active', 'valid'] }),
    H('Frozen', 'Inactive (Y/N)', 'enum', { enum: YES, aliases: ['inactive', 'frozen', 'blocked'] }),
    L('AddressName', 'Address ID', 'text', { max: 50, aliases: ['addressid', 'addressname', 'address', 'location', 'siteid'] }),
    L('AddressType', 'Address Type (Bill to / Ship to)', 'enum', { enum: { bo_BillTo: ['billto', 'bill', 'b', 'billing', 'invoice'], bo_ShipTo: ['shipto', 'ship', 's', 'shipping', 'delivery'] }, aliases: ['addresstype', 'adrestype'] }),
    L('Street', 'Street', 'text', { max: 100, aliases: ['street', 'address1', 'addressline1', 'streetaddress'] }),
    L('Block', 'Block / Street 2', 'text', { max: 100, aliases: ['block', 'address2', 'addressline2', 'area'] }),
    L('BuildingFloorRoom', 'Building / Floor / Room', 'text', { aliases: ['building', 'buildingfloorroom', 'floor'] }),
    L('City', 'City', 'text', { max: 100, aliases: ['city', 'town'] }),
    L('ZipCode', 'Zip / PIN Code', 'text', { max: 20, aliases: ['zip', 'zipcode', 'pincode', 'postalcode', 'postcode'] }),
    L('County', 'County / District', 'text', { max: 100, aliases: ['county', 'district'] }),
    L('State', 'State (code)', 'text', { max: 3, aliases: ['state', 'statecode', 'province'] }),
    L('Country', 'Country (code)', 'text', { max: 3, aliases: ['country', 'countrycode'] }),
    L('AddressName2', 'Address Name 2', 'text', { aliases: ['addressname2'] }),
    L('AddressName3', 'Address Name 3', 'text', { aliases: ['addressname3'] }),
  ],
  lineKey: 'AddressName',
  listLabels: { code: 'Business partner', date: null, due: null, ref: 'Type' },
  valueLabel: null,
  summary: rec => ({ code: rec.header.sap.CardCode, name: rec.header.sap.CardName, ref: ({ cCustomer: 'Customer', cSupplier: 'Vendor', cLid: 'Lead' })[rec.header.sap.CardType] || '' }),
  value: () => null,
  lineRules: s => {
    const out = [];
    if (blank(s.AddressName)) out.push('Address ID is missing for this address');
    if (blank(s.AddressType)) out.push('Address Type (Bill to / Ship to) is missing');
    return out;
  },
  rules: rec => {
    const seen = new Set(), out = [];
    for (const l of rec.lines) {
      const k = `${l.sap.AddressType}|${String(l.sap.AddressName || '').toLowerCase()}`;
      if (seen.has(k)) out.push(`Address "${l.sap.AddressName}" appears twice as ${l.sap.AddressType === 'bo_ShipTo' ? 'ship-to' : 'bill-to'}`);
      seen.add(k);
    }
    return out;
  },
  payload: rec => {
    const body = { ...rec.header.sap };
    if (rec.lines.length) body.BPAddresses = rec.lines.map(l => ({ ...l.sap }));
    if (rec.header.mode === 'update') delete body.CardCode;
    return body;
  },
  result: (r, rec) => ({ docEntry: null, docNum: r?.CardCode || rec.header.sap.CardCode }),
  standard: [{
    name: 'Standard Business Partner', description: 'One row per address; rows with the same BP Code form one business partner. A BP without addresses needs just one row.',
    dateFormat: 'DMY', layout: 'table', options: { onExisting: 'error' },
    columns: [
      C('cardCode', 'BP Code', 'header.CardCode', { required: true, groupKey: true, example: 'C00901', aliases: ['Customer Code', 'Vendor Code', 'Code'] }),
      C('cardName', 'BP Name', 'header.CardName', { required: true, example: 'Acme Retail LLC', aliases: ['Name', 'Customer Name', 'Vendor Name'] }),
      C('cardType', 'BP Type', 'header.CardType', { required: true, example: 'Customer', aliases: ['Type'] }),
      C('group', 'BP Group', 'header.GroupCode', { aliases: ['Group'] }),
      C('currency', 'Currency', 'header.Currency', { example: 'USD' }),
      C('taxId', 'Tax ID', 'header.FederalTaxID', { aliases: ['Federal Tax ID', 'PAN', 'EIN'] }),
      C('phone', 'Phone', 'header.Phone1', { aliases: ['Telephone'] }),
      C('mobile', 'Mobile', 'header.Cellular'),
      C('email', 'Email', 'header.EmailAddress', { aliases: ['E-mail'] }),
      C('contact', 'Contact Person', 'header.ContactPerson', { aliases: ['Contact'] }),
      C('terms', 'Payment Terms', 'header.PayTermsGrpCode', { aliases: ['Terms'] }),
      C('credit', 'Credit Limit', 'header.CreditLimit'),
      C('remarks', 'Remarks', 'header.FreeText', { aliases: ['Notes'] }),
      C('addrId', 'Address ID', 'line.AddressName', { example: 'Main', aliases: ['Address Name', 'Location'] }),
      C('addrType', 'Address Type', 'line.AddressType', { example: 'Bill to' }),
      C('street', 'Street', 'line.Street', { aliases: ['Address 1', 'Address Line 1'] }),
      C('block', 'Street 2', 'line.Block', { aliases: ['Address 2', 'Address Line 2'] }),
      C('city', 'City', 'line.City'),
      C('zip', 'Zip Code', 'line.ZipCode', { aliases: ['PIN Code', 'Postal Code'] }),
      C('state', 'State', 'line.State'),
      C('country', 'Country', 'line.Country', { example: 'US' }),
    ],
  }],
};

// ── Bill of Materials ─────────────────────────────────────────────────────────
const bom = {
  key: 'bom', title: 'Bill of Materials Import', short: 'Bills of Materials', uploadTitle: 'Upload bill of materials sheet', icon: '🧬', color: '#d97706',
  subtitle: 'Create production / sales / assembly BOMs from Excel · one parent item with its components',
  noun: 'BOM', nouns: 'bills of materials', docLabel: 'BOM',
  perm: 'master.excel_import.bom',
  entity: '/ProductTrees', lineCollection: 'ProductTreeLines', tables: { header: 'OITT', line: 'ITT1' },
  headerLabel: 'ProductTrees — BOM header (OITT)', lineLabel: 'ProductTreeLines — components (ITT1)',
  linesRequired: true,
  fields: [
    H('TreeCode', 'Parent Item (BOM code)', 'text', { lookup: ['item', 'newBOM'], core: true, aliases: ['parentitem', 'treecode', 'bomcode', 'fgcode', 'finishedgood', 'parent', 'productcode'] }),
    H('TreeType', 'BOM Type', 'enum', { enum: { iProductionTree: ['production', 'p', 'prod'], iSalesTree: ['sales', 's'], iAssemblyTree: ['assembly', 'a'], iTemplateTree: ['template', 't'] }, aliases: ['bomtype', 'treetype', 'type'] }),
    H('Quantity', 'Parent Quantity', 'number', { aliases: ['parentqty', 'parentquantity', 'bomqty', 'batchsize'] }),
    H('Warehouse', 'Parent Warehouse', 'text', { lookup: 'warehouse', aliases: ['parentwarehouse', 'towarehouse', 'towh'] }),
    H('PriceList', 'Price List No.', 'int', { aliases: ['pricelist'] }),
    H('PlanAvgProdSize', 'Planned Avg. Production Size', 'number', { aliases: ['planavgprodsize', 'avgprodsize'] }),
    H('DistributionRule', 'Distribution Rule', 'text', { aliases: ['distributionrule', 'ocrcode', 'costcenter'] }),
    H('Project', 'Project', 'text', { aliases: ['project'] }),
    L('ItemCode', 'Component Item', 'text', { lookup: 'item', core: true, aliases: ['componentitem', 'component', 'itemcode', 'childitem', 'rawmaterial', 'material', 'code'] }),
    L('Quantity', 'Component Quantity', 'number', { core: true, aliases: ['quantity', 'qty', 'componentqty', 'qtyper', 'usage'] }),
    L('Warehouse', 'Issue Warehouse', 'text', { lookup: 'warehouse', aliases: ['warehouse', 'issuewarehouse', 'whs', 'fromwarehouse'] }),
    L('IssueMethod', 'Issue Method (Backflush / Manual)', 'enum', { enum: { im_Backflush: ['backflush', 'b', 'auto'], im_Manual: ['manual', 'm'] }, aliases: ['issuemethod', 'issuemthd'] }),
    L('ItemType', 'Component Type (Item / Resource / Text)', 'enum', { enum: { pit_Item: ['item', 'i'], pit_Resource: ['resource', 'r'], pit_Text: ['text', 't'] }, aliases: ['componenttype'] }),
    L('Price', 'Component Price', 'number', { aliases: ['price', 'componentprice'] }),
    L('PriceList', 'Component Price List', 'int', { aliases: ['componentpricelist'] }),
    L('AdditionalQuantity', 'Additional Quantity', 'number', { aliases: ['additionalquantity', 'scrap', 'addqty'] }),
    L('Comment', 'Comment', 'text', { aliases: ['comment', 'remarks', 'note'] }),
    L('DistributionRule', 'Distribution Rule (line)', 'text', { aliases: ['linedistributionrule'] }),
    L('Project', 'Project (line)', 'text', { aliases: ['lineproject'] }),
  ],
  listLabels: { code: 'Parent item', date: null, due: null, ref: 'BOM type' },
  valueLabel: null,
  summary: (rec, x) => ({ code: rec.header.sap.TreeCode, name: x.name, ref: ({ iProductionTree: 'Production', iSalesTree: 'Sales', iAssemblyTree: 'Assembly', iTemplateTree: 'Template' })[rec.header.sap.TreeType || 'iProductionTree'] }),
  value: () => null,
  rules: rec => {
    const out = [];
    const parent = String(rec.header.sap.TreeCode || '').toUpperCase();
    if (parent && rec.lines.some(l => String(l.sap.ItemCode || '').toUpperCase() === parent)) out.push('The parent item is also listed as its own component');
    const seen = new Map();
    for (const l of rec.lines) { const k = String(l.sap.ItemCode || '').toUpperCase(); if (k) seen.set(k, (seen.get(k) || 0) + 1); }
    for (const [k, n] of seen) if (n > 1) out.push(`Component ${k} is listed ${n} times`);
    if (rec.header.sap.Quantity != null && rec.header.sap.Quantity <= 0) out.push('Parent Quantity must be more than 0');
    return out;
  },
  lineRules: s => (s.Quantity != null && s.Quantity <= 0 ? ['Component Quantity must be more than 0'] : []),
  payload: rec => ({ TreeType: 'iProductionTree', Quantity: 1, ...rec.header.sap, ProductTreeLines: docLines(rec) }),
  result: (r, rec) => ({ docEntry: null, docNum: r?.TreeCode || rec.header.sap.TreeCode }),
  standard: [{
    name: 'Standard Bill of Materials', description: 'One row per component; rows with the same Parent Item form one BOM.',
    dateFormat: 'DMY', layout: 'table',
    columns: [
      C('parent', 'Parent Item', 'header.TreeCode', { required: true, groupKey: true, example: 'FG0100101006PD0EN01', aliases: ['FG Code', 'BOM Code', 'Finished Good'] }),
      C('parentName', 'Parent Description', 'info.header', { aliases: ['FG Description'] }),
      C('bomType', 'BOM Type', 'header.TreeType', { example: 'Production', default: 'Production' }),
      C('parentQty', 'Parent Qty', 'header.Quantity', { example: '1', default: '1', aliases: ['Batch Size'] }),
      C('parentWhs', 'Parent Warehouse', 'header.Warehouse', { example: '17SH' }),
      C('component', 'Component', 'line.ItemCode', { required: true, example: 'RF0100101999EA0EN01', aliases: ['Component Item', 'Raw Material', 'Item Code'] }),
      C('componentName', 'Component Description', 'info.line', { aliases: ['Description'] }),
      C('qty', 'Quantity', 'line.Quantity', { required: true, example: '6', aliases: ['Qty', 'Qty Per'] }),
      C('issueWhs', 'Issue Warehouse', 'line.Warehouse', { example: '17SH', aliases: ['Warehouse'] }),
      C('issue', 'Issue Method', 'line.IssueMethod', { example: 'Backflush' }),
      C('comment', 'Comment', 'line.Comment'),
    ],
  }],
};

// ── A/P Expense (service) Invoice ─────────────────────────────────────────────
const apservice = {
  key: 'apservice', title: 'A/P Expense Invoice Import', short: 'A/P Expense Invoices', uploadTitle: 'Upload vendor expense bills', icon: '🧾', color: '#b45309',
  subtitle: 'Book vendor expense bills from Excel as service A/P invoices · G/L account lines',
  noun: 'A/P invoice', nouns: 'A/P invoices', docLabel: 'A/P Inv',
  perm: 'purchase.workflow.apinv_excel_import',
  entity: '/PurchaseInvoices', lineCollection: 'DocumentLines', tables: { header: 'OPCH', line: 'PCH1' },
  headerLabel: 'Documents — A/P invoice header (OPCH)', lineLabel: 'DocumentLines — expense lines (PCH1)',
  linesRequired: true,
  // A vendor invoice number already booked for the same vendor is reported, not posted twice.
  dupCheck: { entity: '/PurchaseInvoices', fields: ['CardCode', 'NumAtCard'], label: (h, d) => `Vendor invoice ${h.NumAtCard} of ${h.CardCode} is already booked in SAP (A/P Invoice ${d.DocNum})` },
  fields: [
    H('CardCode', 'Vendor Code', 'text', { lookup: 'supplier', core: true, aliases: ['vendorcode', 'suppliercode', 'cardcode', 'vendor', 'supplier', 'partycode', 'bpcode'] }),
    H('NumAtCard', 'Vendor Invoice No.', 'text', { max: 100, aliases: ['vendorinvoiceno', 'invoiceno', 'billno', 'supplierinvoiceno', 'vendorref', 'numatcard', 'invoicenumber', 'billnumber'] }),
    H('DocDate', 'Posting Date', 'date', { aliases: ['postingdate', 'docdate', 'date'] }),
    H('TaxDate', 'Invoice / Document Date', 'date', { aliases: ['invoicedate', 'billdate', 'documentdate', 'taxdate'] }),
    H('DocDueDate', 'Due Date', 'date', { aliases: ['duedate', 'paymentduedate', 'docduedate'] }),
    H('Comments', 'Remarks', 'text', { max: 254, aliases: ['remarks', 'comments', 'narration', 'notes'] }),
    H('JournalMemo', 'Journal Remark', 'text', { max: 254, aliases: ['journalremark', 'journalmemo'] }),
    H('DocCurrency', 'Currency', 'text', { max: 3, aliases: ['currency', 'doccurrency'] }),
    H('DocRate', 'Exchange Rate', 'number', { aliases: ['exchangerate', 'docrate'] }),
    H('BPL_IDAssignedToInvoice', 'Branch (ID or name)', 'text', { lookup: 'branch', aliases: ['branch', 'branchid', 'bplid'] }),
    H('PaymentGroupCode', 'Payment Terms (code or name)', 'text', { lookup: 'paymentTerms', aliases: ['paymentterms', 'terms'] }),
    H('Project', 'Project (header)', 'text', { aliases: ['project'] }),
    H('Series', 'Numbering Series', 'int', { aliases: ['series'] }),
    H('DocumentsOwner', 'Owner (employee ID)', 'int', { aliases: ['owner'] }),
    L('AccountCode', 'Expense G/L Account (number or name)', 'text', { lookup: 'account', core: true, aliases: ['glaccount', 'account', 'accountcode', 'expenseaccount', 'expensehead', 'ledger', 'gl', 'glcode', 'acctcode'] }),
    L('ItemDescription', 'Description', 'text', { max: 100, aliases: ['description', 'particulars', 'narration', 'expense', 'itemdescription', 'details'] }),
    L('LineTotal', 'Amount (before tax)', 'number', { core: true, aliases: ['amount', 'linetotal', 'value', 'total', 'netamount', 'taxableamount', 'basicamount'] }),
    L('TaxCode', 'Tax Code', 'text', { lookup: 'tax', aliases: ['taxcode', 'tax', 'gstcode', 'gst'] }),
    L('VatGroup', 'VAT Group', 'text', { lookup: 'tax', aliases: ['vatgroup', 'vatcode'] }),
    L('CostingCode', 'Distribution Rule 1 / Cost Center', 'text', { aliases: ['costcenter', 'costingcode', 'distributionrule', 'ocrcode', 'department'] }),
    L('CostingCode2', 'Distribution Rule 2', 'text', { aliases: ['costingcode2', 'ocrcode2'] }),
    L('CostingCode3', 'Distribution Rule 3', 'text', { aliases: ['costingcode3', 'ocrcode3'] }),
    L('CostingCode4', 'Distribution Rule 4', 'text', { aliases: ['costingcode4'] }),
    L('CostingCode5', 'Distribution Rule 5', 'text', { aliases: ['costingcode5'] }),
    L('ProjectCode', 'Project (line)', 'text', { aliases: ['lineproject', 'projectcode'] }),
    L('FreeText', 'Line Remarks', 'text', { max: 100, aliases: ['lineremarks', 'freetext'] }),
  ],
  listLabels: { code: 'Vendor', date: 'Posting date', due: 'Due date', ref: 'Vendor invoice' },
  valueLabel: 'Amount (before tax)',
  summary: (rec, x) => ({ code: rec.header.sap.CardCode, name: x.cardName, date: rec.header.sap.DocDate, due: rec.header.sap.DocDueDate, ref: rec.header.sap.NumAtCard }),
  value: rec => r2(rec.lines.reduce((s, l) => s + (Number(l.sap.LineTotal) || 0), 0)),
  lineTotal: s => Number(s.LineTotal) || 0,
  defaults: rec => { if (!rec.header.sap.DocDate) rec.header.sap.DocDate = new Date().toISOString().slice(0, 10); },
  lineRules: s => (s.LineTotal != null && s.LineTotal === 0 ? ['Amount is 0'] : []),
  payload: (rec, ctx) => ({
    ...rec.header.sap, DocType: 'dDocument_Service', ...fallbackComments(rec, ctx, 'vendor invoice'),
    DocumentLines: rec.lines.map(l => ({ ItemDescription: (l.accountName || 'Expense').slice(0, 100), ...l.sap })),
  }),
  result: r => ({ docEntry: r?.DocEntry, docNum: r?.DocNum }),
  standard: [{
    name: 'Standard Expense Invoice', description: 'One row per expense line; rows with the same Vendor + Vendor Invoice No. form one A/P invoice.',
    dateFormat: 'DMY', layout: 'table',
    columns: [
      C('vendor', 'Vendor Code', 'header.CardCode', { required: true, groupKey: true, example: 'V00070', aliases: ['Supplier Code', 'Vendor'] }),
      C('vendorName', 'Vendor Name', 'info.header', { aliases: ['Supplier Name'] }),
      C('invNo', 'Vendor Invoice No', 'header.NumAtCard', { required: true, groupKey: true, example: 'INV-5521', aliases: ['Invoice No', 'Bill No', 'Supplier Invoice No'] }),
      C('invDate', 'Invoice Date', 'header.TaxDate', { example: '28/10/2026', aliases: ['Bill Date', 'Document Date'] }),
      C('postDate', 'Posting Date', 'header.DocDate', { example: '30/10/2026' }),
      C('dueDate', 'Due Date', 'header.DocDueDate'),
      C('remarks', 'Remarks', 'header.Comments', { aliases: ['Narration', 'Notes'] }),
      C('account', 'G/L Account', 'line.AccountCode', { required: true, example: '61015010101', aliases: ['Expense Account', 'Account', 'Ledger', 'Expense Head'] }),
      C('desc', 'Description', 'line.ItemDescription', { example: 'Payroll processing fee — Oct 2026', aliases: ['Particulars', 'Details'] }),
      C('amount', 'Amount', 'line.LineTotal', { required: true, example: '1250.00', aliases: ['Net Amount', 'Taxable Amount', 'Value'] }),
      C('tax', 'Tax Code', 'line.TaxCode', { aliases: ['GST Code', 'Tax'] }),
      C('cc', 'Cost Center', 'line.CostingCode', { aliases: ['Distribution Rule', 'Department'] }),
      C('project', 'Project', 'line.ProjectCode'),
    ],
  }],
};

// ── Salary → Journal Entry ────────────────────────────────────────────────────
// Salary heads: header-level amount columns with target "head"; each carries its own
// G/L account and Debit / Credit side and becomes one JE line. Explicit JE line rows
// (account, debit, credit) can be mapped too, for a general journal import.
const fmtMonth = v => {
  const m = String(v ?? '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  return m ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m[2] - 1]}-${m[1]}` : String(v ?? '');
};
// "{Employee Name}" → that column's value (dates as Mon-YYYY for month / period columns)
export function fillPattern(pattern, rec, cols, extra = {}) {
  return String(pattern || '').replace(/\{([^}]+)\}/g, (_, name) => {
    const n = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (n in extra) return extra[n] ?? '';
    const c = cols.find(c => String(c.heading || '').toLowerCase().replace(/[^a-z0-9]/g, '') === n);
    if (!c) return '';
    const v = rec.header.cells?.[c.id];
    if (v == null) return '';
    return /month|period/.test(n) || /month|period/i.test(c.heading) ? fmtMonth(v) : String(v);
  }).replace(/\s+-\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}
const HEAD = (id, heading, side, account, extra = {}) => C(id, heading, 'head', { side, account, ...extra });

const je = {
  key: 'je', title: 'Salary → Journal Entry', short: 'Salary JVs', uploadTitle: 'Upload salary register or salary slips', icon: '💰', color: '#047857',
  subtitle: 'Post one journal entry per employee from the salary register or salary slips · heads mapped to G/L accounts',
  noun: 'Journal entry', nouns: 'journal entries', docLabel: 'JE',
  perm: 'finance.salary_jv_import',
  entity: '/JournalEntries', lineCollection: 'JournalEntryLines', tables: { header: 'OJDT', line: 'JDT1' },
  headerLabel: 'JournalEntries — header (OJDT)', lineLabel: 'JournalEntryLines — lines (JDT1)',
  hasHeads: true, jeLines: true,
  fields: [
    { target: 'head', level: 'header', label: 'Salary head → JE line (G/L account + Debit / Credit)', type: 'number', special: true, multi: true },
    H('ReferenceDate', 'Posting Date', 'date', { core: true, aliases: ['postingdate', 'referencedate', 'jvdate', 'date', 'salarydate', 'paydate'] }),
    H('DueDate', 'Due Date', 'date', { aliases: ['duedate'] }),
    H('TaxDate', 'Document Date', 'date', { aliases: ['documentdate', 'taxdate'] }),
    H('Memo', 'Remarks / Narration (overrides the pattern)', 'text', { max: 50, aliases: ['memo', 'narration', 'remarks'] }),
    H('Reference', 'Reference 1 (e.g. employee code)', 'text', { max: 100, aliases: ['reference', 'ref1', 'reference1', 'empcode', 'employeecode', 'employeeid', 'empid', 'empno'] }),
    H('Reference2', 'Reference 2 (e.g. salary month)', 'text', { max: 100, aliases: ['reference2', 'ref2'] }),
    H('Reference3', 'Reference 3', 'text', { max: 27, aliases: ['reference3', 'ref3'] }),
    H('ProjectCode', 'Project', 'text', { aliases: ['project', 'projectcode'] }),
    H('TransactionCode', 'Transaction Code', 'text', { max: 4, aliases: ['transactioncode', 'transcode'] }),
    H('Series', 'Numbering Series', 'int', { aliases: ['series'] }),
    H('LinesCostingCode', 'Cost Center — all lines (Dist. Rule 1)', 'text', { aliases: ['costcenter', 'department', 'costingcode', 'distributionrule', 'ocrcode', 'dept'] }),
    H('LinesCostingCode2', 'Dist. Rule 2 — all lines', 'text', { aliases: ['costingcode2', 'ocrcode2'] }),
    H('LinesProjectCode', 'Project — all lines', 'text', { aliases: ['lineproject'] }),
    L('AccountCode', 'G/L Account (number or name)', 'text', { lookup: 'account', aliases: ['glaccount', 'account', 'accountcode', 'ledger', 'glcode', 'acctcode'] }),
    L('ShortName', 'BP Code (control account line)', 'text', { lookup: 'bpAny', aliases: ['bpcode', 'shortname', 'cardcode'] }),
    L('Debit', 'Debit', 'number', { aliases: ['debit', 'dr', 'debitamount'] }),
    L('Credit', 'Credit', 'number', { aliases: ['credit', 'cr', 'creditamount'] }),
    L('LineMemo', 'Line Remarks', 'text', { max: 50, aliases: ['linememo', 'lineremarks', 'linenarration'] }),
    L('CostingCode', 'Distribution Rule 1', 'text', { aliases: ['linecostcenter'] }),
    L('CostingCode2', 'Distribution Rule 2', 'text', { aliases: ['linecostingcode2'] }),
    L('ProjectCode', 'Project (line)', 'text', { aliases: ['lineprojectcode'] }),
    L('Reference1', 'Line Reference 1', 'text', { aliases: ['linereference1', 'lineref1'] }),
    L('Reference2', 'Line Reference 2', 'text', { aliases: ['linereference2', 'lineref2'] }),
  ],
  options: {
    memo: { label: 'Remarks (narration) pattern', default: 'Salary {Month} - {Employee Name}', hint: 'Max 50 characters in SAP. {Column heading} inserts that column, e.g. {Employee Name}, {Month}.' },
    lineMemo: { label: 'Line remarks pattern', default: '{Head} - {Employee Name}', hint: '{Head} is the salary head (column heading).' },
  },
  listLabels: { code: 'Reference / remarks', date: 'Posting date', due: null, ref: 'Reference 2' },
  valueLabel: 'Total debit',
  summary: rec => ({ code: rec.header.sap.Reference || '', name: rec.header.memo || '', date: rec.header.sap.ReferenceDate, ref: rec.header.sap.Reference2 || '' }),
  value: rec => r2((rec.header.jeLines || []).reduce((s, l) => s + (Number(l.Debit) || 0), 0)),
  standard: null,          // built below (needs the head list twice)
};

const SALARY_HEADS = () => [
  HEAD('basic', 'Basic', 'D', 'Salaries and Wages Expense', { example: '50000', aliases: ['Basic Salary', 'Basic Pay'] }),
  HEAD('hra', 'HRA', 'D', 'Salaries and Wages Expense', { example: '20000', aliases: ['House Rent Allowance'] }),
  HEAD('special', 'Special Allowance', 'D', 'Salaries and Wages Expense', { example: '15000', aliases: ['Other Allowance', 'Allowances'] }),
  HEAD('overtime', 'Overtime', 'D', 'Salaries and Wages Expense', { aliases: ['OT'] }),
  HEAD('bonus', 'Bonus', 'D', 'Salaries and Wages Expense', { aliases: ['Incentive'] }),
  HEAD('pf', 'PF Deduction', 'C', 'Accrued ER 401k Contributions', { example: '6000', aliases: ['PF', 'Provident Fund', '401k EE'] }),
  HEAD('tds', 'Income Tax', 'C', 'Other Tax Liabilities', { example: '4500', aliases: ['TDS', 'Tax Deducted', 'Federal Tax'] }),
  HEAD('ptax', 'Professional Tax', 'C', 'Other Tax Liabilities', { example: '200', aliases: ['PT', 'Prof Tax'] }),
  HEAD('advance', 'Advance Recovery', 'C', 'Accrued Payroll', { aliases: ['Loan Recovery'] }),
  HEAD('net', 'Net Pay', 'C', 'Accrued Payroll', { example: '74300', aliases: ['Net Salary', 'Net Payable', 'Take Home'] }),
];
je.standard = [
  {
    name: 'Salary Register — one row per employee',
    description: 'One row per employee per month (every sheet with these headings is read). Each salary head becomes a JE line.',
    dateFormat: 'DMY', layout: 'table', options: { memo: je.options.memo.default, lineMemo: je.options.lineMemo.default },
    columns: [
      C('empCode', 'Employee Code', 'header.Reference', { required: true, groupKey: true, example: 'E1001', aliases: ['Emp Code', 'Emp ID', 'Employee ID', 'Emp No'] }),
      C('empName', 'Employee Name', 'info.header', { required: true, example: 'Ramesh Patel', aliases: ['Emp Name', 'Name'] }),
      C('month', 'Month', 'header.Reference2', { required: true, groupKey: true, example: 'Oct-2026', aliases: ['Salary Month', 'Pay Period', 'Period'] }),
      C('postDate', 'Posting Date', 'header.ReferenceDate', { default: 'TODAY', example: '31/10/2026', aliases: ['JV Date', 'Date'] }),
      C('dept', 'Department', 'info.header', { aliases: ['Dept'] }),   // map to "Cost Center — all lines" when departments are distribution rules
      ...SALARY_HEADS(),
    ],
  },
  {
    name: 'Salary Slips — one sheet per employee',
    description: 'Each sheet is one employee\'s salary slip with "label | value" cells (Employee Name: …, Basic: …). Every sheet becomes one journal entry.',
    dateFormat: 'DMY', layout: 'form', options: { memo: je.options.memo.default, lineMemo: je.options.lineMemo.default },
    columns: [
      C('empCode', 'Employee Code', 'header.Reference', { required: true, groupKey: true, aliases: ['Emp Code', 'Emp ID', 'Employee ID', 'Emp No'] }),
      C('empName', 'Employee Name', 'info.header', { required: true, aliases: ['Emp Name', 'Name'] }),
      C('month', 'Month', 'header.Reference2', { required: true, groupKey: true, aliases: ['Salary Month', 'Pay Period', 'Period', 'Salary for the month of'] }),
      C('postDate', 'Posting Date', 'header.ReferenceDate', { default: 'TODAY', aliases: ['JV Date'] }),
      C('dept', 'Department', 'info.header', { aliases: ['Dept'] }),   // map to "Cost Center — all lines" when departments are distribution rules
      ...SALARY_HEADS(),
    ],
  },
];

// Build the JE lines of one record: heads (amount × side × account) + explicit line rows.
je.buildLines = (rec, tpl) => {
  const cols = tpl.columns || [];
  const out = [], issues = [];
  const h = rec.header.sap;
  const common = {
    ...(h.LinesCostingCode ? { CostingCode: h.LinesCostingCode } : {}),
    ...(h.LinesCostingCode2 ? { CostingCode2: h.LinesCostingCode2 } : {}),
    ...(h.LinesProjectCode ? { ProjectCode: h.LinesProjectCode } : {}),
  };
  for (const c of cols.filter(c => c.target === 'head')) {
    const amt = Number(rec.header.cells?.[c.id]);
    if (!amt) continue;
    const debit = (c.side === 'C') === (amt < 0);
    const memo = fillPattern(tpl.options?.lineMemo || je.options.lineMemo.default, rec, cols, { head: c.heading }).slice(0, 50);
    out.push({ head: c.heading, headId: c.id, account: c.account || '', AccountCode: c.account || '',
      ...(debit ? { Debit: Math.abs(amt) } : { Credit: Math.abs(amt) }), LineMemo: memo, ...common });
    if (!c.account) issues.push(`Salary head "${c.heading}" has no G/L account in the template`);
  }
  for (const l of rec.lines) {
    const s = l.sap;
    if (blank(s.AccountCode) && blank(s.ShortName)) continue;
    out.push({ ...common, ...s, LineMemo: (s.LineMemo || fillPattern(tpl.options?.lineMemo || '', rec, cols, { head: 'Journal' })).slice(0, 50) });
  }
  return { lines: out, issues };
};
je.memo = (rec, tpl) => (rec.header.sap.Memo || fillPattern(tpl.options?.memo || je.options.memo.default, rec, tpl.columns || [])).slice(0, 50);
je.rules = rec => {
  const out = [];
  const lines = rec.header.jeLines || [];
  if (!lines.length) out.push('No amounts — every salary head is empty or 0');
  const d = r2(lines.reduce((s, l) => s + (Number(l.Debit) || 0), 0)), c = r2(lines.reduce((s, l) => s + (Number(l.Credit) || 0), 0));
  if (lines.length && Math.abs(d - c) > 0.005) out.push(`Not balanced — debit ${d.toFixed(2)} vs credit ${c.toFixed(2)} (difference ${(d - c).toFixed(2)}). Check the heads or map Net Pay as a credit.`);
  return out;
};
je.lineRules = s => {
  const out = [];
  if ((s.Debit || 0) && (s.Credit || 0)) out.push('A line cannot have both Debit and Credit');
  if (!(s.Debit || 0) && !(s.Credit || 0) && (!blank(s.AccountCode) || !blank(s.ShortName))) out.push('Debit or Credit is missing');
  return out;
};
je.templateCheck = tpl => {
  const out = [];
  const heads = tpl.columns.filter(c => c.target === 'head');
  const lineAcct = tpl.columns.some(c => c.target === 'line.AccountCode' || c.target === 'line.ShortName');
  if (!heads.length && !lineAcct) out.push('Map at least one salary head (Basic, HRA, Net Pay …) or a G/L Account line column');
  for (const h of heads) if (!['D', 'C'].includes(h.side)) out.push(`Salary head "${h.heading}": choose Debit or Credit`);
  return out;
};
je.payload = (rec, ctx) => {
  const h = { ...rec.header.sap };
  for (const k of ['LinesCostingCode', 'LinesCostingCode2', 'LinesProjectCode']) delete h[k];
  return { ...h, Memo: rec.header.memo || je.memo(rec, ctx.template), JournalEntryLines: (rec.header.jeLines || []).map(({ head, headId, account, accountLabel, ...l }) => l) };   // display-only keys stay out
};
je.result = r => ({ docEntry: r?.JdtNum, docNum: r?.JdtNum ?? r?.Number });

export const DOC_TYPES = { order, item, bp, bom, apservice, je };
