/**
 * nlp-engine.mjs
 * SAP Business One Chat Assistant — NLP Query Engine
 * Converts natural language to SAP B1 Service Layer OData calls.
 * No Anthropic API required.
 */

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Format number with commas and 2 decimal places */
function fmt(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Build a markdown table */
function tbl(headers, rows) {
  if (!rows || rows.length === 0) return '_No records found._';
  const sep = headers.map(() => '---');
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.map(c => String(c ?? '—').replace(/\|/g, '\\|')).join(' | ')} |`)
  ];
  return lines.join('\n');
}

/** Return an emoji icon for an endpoint */
function getIcon(endpoint) {
  const icons = {
    '/Quotations': '📋',
    '/Orders': '📦',
    '/DeliveryNotes': '🚚',
    '/Invoices': '🧾',
    '/CreditNotes': '💳',
    '/Returns': '↩️',
    '/IncomingPayments': '💰',
    '/PurchaseOrders': '🛒',
    '/PurchaseDeliveryNotes': '📥',
    '/PurchaseInvoices': '🧾',
    '/PurchaseReturns': '↩️',
    '/VendorPayments': '💸',
    '/PurchaseQuotations': '📋',
    '/InventoryGenEntries': '📬',
    '/InventoryGenExits': '📤',
    '/StockTransfers': '🔄',
    '/BatchNumberDetails': '🏷️',
    '/ItemWarehouseInfoCollection': '🏭',
    '/ProductionOrders': '⚙️',
    '/JournalEntries': '📒',
    '/ChartOfAccounts': '📊',
    '/ServiceCalls': '🛠️',
    '/Activities': '📅',
    '/SalesOpportunities': '🎯',
    '/ContactEmployees': '👤',
    '/EmployeesInfo': '👥',
    '/PriceLists': '🏷️',
    '/ItemGroups': '📂',
    '/Warehouses': '🏢',
    '/Territories': '🗺️',
    '/PaymentTermsTypes': '📃',
    '/BlanketAgreements': '🤝',
    '/ProfitCenters': '💹',
    '/SalesTaxAuthorities': '🏛️',
    '/Currencies': '💱',
    '/BusinessPartnerGroups': '🏷️',
    '/SalesPersons': '🙋',
  };
  return icons[endpoint] || '📄';
}

/** Escape single quotes in OData string values */
function esc(s) {
  return String(s ?? '').replace(/'/g, "''");
}

/** Format date as YYYY-MM-DD for OData */
function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/** Get start of week (Monday) */
function startOfWeek(d) {
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const s = new Date(d);
  s.setDate(d.getDate() + diff);
  s.setHours(0, 0, 0, 0);
  return s;
}

/** Get start of month */
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Get end of month */
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

// Month name → index map
const MONTH_MAP = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

// ─────────────────────────────────────────────────────────────────────────────
// ENTITY MAP
// ─────────────────────────────────────────────────────────────────────────────

const SL_ENTITIES = [
  // ── SALES ──────────────────────────────────────────────────────────────────
  {
    label: 'Sales Quotations',
    endpoint: '/Quotations',
    patterns: [/\bquotation/i, /\bquote[s]?\b/i, /\bsales quote/i, /\bsq\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Sales Orders',
    endpoint: '/Orders',
    patterns: [/\bsales order/i, /\bso\b/, /\border[s]?\b/i],
    guard: msg => !/purchase|po\b/i.test(msg),
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Delivery Notes',
    endpoint: '/DeliveryNotes',
    patterns: [/\bdelivery note/i, /\bdeliveries\b/i, /\bdelivery\b/i, /\bdn\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'AR Invoices',
    endpoint: '/Invoices',
    patterns: [/\bar invoice/i, /\bsales invoice/i, /\binvoice[s]?\b/i, /\bari\b/],
    guard: msg => !/purchase|ap invoice|vendor invoice/i.test(msg),
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'AR Credit Notes',
    endpoint: '/CreditNotes',
    patterns: [/\bar credit/i, /\bcredit note/i, /\bcredit memo/i, /\bcn\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'AR Returns',
    endpoint: '/Returns',
    patterns: [/\bsales return/i, /\bar return/i, /\breturn[s]?\b/i],
    guard: msg => !/purchase|vendor/i.test(msg),
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Customer', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Incoming Payments',
    endpoint: '/IncomingPayments',
    patterns: [/\bincoming payment/i, /\bcustomer payment/i, /\bpayment received/i, /\breceipt[s]?\b(?! po| note| from production)/i],
    guard: msg => !/goods|stock|inventory|purchase/i.test(msg),
    statusField: null,
    openValue: null,
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocCurrency,TransferSum,CashSum',
    headers: ['#', 'Date', 'Customer', 'Name', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  // ── PURCHASE ───────────────────────────────────────────────────────────────
  {
    label: 'Purchase Quotations',
    endpoint: '/PurchaseQuotations',
    patterns: [/\bpurchase quot/i, /\bpq\b/, /\bpo quot/i, /\brequest for quot/i, /\brfq\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Purchase Orders',
    endpoint: '/PurchaseOrders',
    patterns: [/\bpurchase order/i, /\bpo\b/, /\bprocurement order/i],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Purchase Delivery Notes',
    endpoint: '/PurchaseDeliveryNotes',
    patterns: [/\bpurchase delivery/i, /\bgoods receipts?\b/i, /\bgrn\b/, /\bpdn\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'AP Invoices',
    endpoint: '/PurchaseInvoices',
    patterns: [/\bap invoice/i, /\bpurchase invoice/i, /\bvendor invoice/i, /\bsupplier invoice/i, /\bapi\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Purchase Returns',
    endpoint: '/PurchaseReturns',
    patterns: [/\bpurchase return/i, /\bap return/i, /\bvendor return/i],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,DocumentStatus,DocTotal,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Status', 'Total', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.DocCurrency ?? '—',
    ],
  },
  {
    label: 'Vendor Payments',
    endpoint: '/VendorPayments',
    patterns: [/\bvendor payment/i, /\bsupplier payment/i, /\bap payment/i, /\boutgoing payment/i, /\bpayment to/i],
    statusField: null,
    openValue: null,
    dateField: 'DocDate',
    cardField: 'CardCode',
    select: 'DocEntry,DocNum,DocDate,CardCode,CardName,TransferSum,CashSum,DocCurrency',
    headers: ['#', 'Date', 'Vendor', 'Name', 'Transfer', 'Cash', 'Currency'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CardName ?? '—',
      fmt(Number(r.TransferSum||0) + Number(r.CashSum||0)),
      fmt(r.CashSum),
      r.DocCurrency ?? '—',
    ],
  },
  // ── INVENTORY ──────────────────────────────────────────────────────────────
  {
    label: 'Inventory Receipts (Gen. Entry)',
    endpoint: '/InventoryGenEntries',
    patterns: [/\binventory.*entr/i, /\bgoods entr/i, /\bstock.*receipt/i, /\bige\b/, /\binventory receipt/i],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: null,
    select: 'DocEntry,DocNum,DocDate,DocumentStatus,DocTotal,Comments',
    headers: ['#', 'Date', 'Status', 'Total', 'Comments'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.Comments ?? '—',
    ],
  },
  {
    label: 'Inventory Issues (Gen. Exit)',
    endpoint: '/InventoryGenExits',
    patterns: [/\binventory.*exit/i, /\binventory.*issue/i, /\bgoods issue/i, /\bstock.*issue/i, /\bigi\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: null,
    select: 'DocEntry,DocNum,DocDate,DocumentStatus,DocTotal,Comments',
    headers: ['#', 'Date', 'Status', 'Total', 'Comments'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
      r.Comments ?? '—',
    ],
  },
  {
    label: 'Stock Transfers',
    endpoint: '/StockTransfers',
    patterns: [/\bstock transfer/i, /\binventory transfer/i, /\bwhse transfer/i, /\bwarehouse transfer/i, /\bst\b/],
    statusField: 'DocumentStatus',
    openValue: 'bost_Open',
    dateField: 'DocDate',
    cardField: null,
    select: 'DocEntry,DocNum,DocDate,FromWarehouse,ToWarehouse,DocumentStatus,DocTotal,Comments',
    headers: ['#', 'Date', 'From Whse', 'To Whse', 'Status', 'Total'],
    row: r => [
      r.DocNum ?? '—',
      r.DocDate ? r.DocDate.substring(0, 10) : '—',
      r.FromWarehouse ?? '—',
      r.ToWarehouse ?? '—',
      r.DocumentStatus === 'bost_Open' ? 'Open' : r.DocumentStatus === 'bost_Close' ? 'Closed' : (r.DocumentStatus ?? '—'),
      fmt(r.DocTotal),
    ],
  },
  {
    label: 'Batch Number Details',
    endpoint: '/BatchNumberDetails',
    patterns: [/\bbatch number/i, /\bbatch detail/i, /\blot number/i, /\bbatch[es]?\b/i],
    statusField: null,
    openValue: null,
    dateField: 'ExpiryDate',
    cardField: null,
    select: 'Batch,ItemCode,ItemDescription,ExpiryDate,ManufacturingDate,Quantity,WhsCode',
    headers: ['Batch', 'Item Code', 'Description', 'Expiry', 'Mfg Date', 'Qty', 'Warehouse'],
    row: r => [
      r.Batch ?? '—',
      r.ItemCode ?? '—',
      r.ItemDescription ?? '—',
      r.ExpiryDate ? r.ExpiryDate.substring(0, 10) : '—',
      r.ManufacturingDate ? r.ManufacturingDate.substring(0, 10) : '—',
      fmt(r.Quantity),
      r.WhsCode ?? '—',
    ],
  },
  {
    label: 'Item Warehouse Info',
    endpoint: '/ItemWarehouseInfoCollection',
    patterns: [/\bitem warehouse/i, /\bwarehouse stock/i, /\bstock level/i, /\binventory level/i, /\bstock on hand/i, /\bstock balance/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'ItemCode,WarehouseCode,InStock,Committed,Ordered,Available,MinStock,MaxStock',
    headers: ['Item Code', 'Warehouse', 'In Stock', 'Committed', 'Ordered', 'Available', 'Min', 'Max'],
    row: r => [
      r.ItemCode ?? '—',
      r.WarehouseCode ?? '—',
      fmt(r.InStock),
      fmt(r.Committed),
      fmt(r.Ordered),
      fmt(r.Available),
      fmt(r.MinStock),
      fmt(r.MaxStock),
    ],
  },
  // ── PRODUCTION ─────────────────────────────────────────────────────────────
  {
    label: 'Production Orders',
    endpoint: '/ProductionOrders',
    patterns: [/\bproduction order/i, /\bmanufacturing order/i, /\bwork order/i, /\bprod order/i, /\bwo\b/],
    statusField: 'ProductionOrderStatus',
    openValue: 'boposReleased',
    dateField: 'PostingDate',
    cardField: null,
    select: 'AbsoluteEntry,DocumentNumber,PostingDate,ItemNo,ProductDescription,PlannedQuantity,CompletedQuantity,ProductionOrderStatus',
    headers: ['#', 'Date', 'Item', 'Description', 'Planned Qty', 'Completed Qty', 'Status'],
    row: r => [
      r.DocumentNumber ?? '—',
      r.PostingDate ? r.PostingDate.substring(0, 10) : '—',
      r.ItemNo ?? '—',
      r.ProductDescription ?? '—',
      fmt(r.PlannedQuantity),
      fmt(r.CompletedQuantity),
      r.ProductionOrderStatus ?? '—',
    ],
  },
  // ── FINANCE ────────────────────────────────────────────────────────────────
  {
    label: 'Journal Entries',
    endpoint: '/JournalEntries',
    patterns: [/\bjournal entr/i, /\bje\b/, /\bgl entr/i, /\bgeneral ledger entr/i, /\bjv\b/],
    statusField: null,
    openValue: null,
    dateField: 'ReferenceDate',
    cardField: null,
    select: 'JdtNum,ReferenceDate,DueDate,TransactionCode,Memo,Reference',
    headers: ['JE#', 'Ref Date', 'Due Date', 'Trans Code', 'Memo', 'Reference'],
    row: r => [
      r.JdtNum ?? '—',
      r.ReferenceDate ? r.ReferenceDate.substring(0, 10) : '—',
      r.DueDate ? r.DueDate.substring(0, 10) : '—',
      r.TransactionCode ?? '—',
      r.Memo ?? '—',
      r.Reference ?? '—',
    ],
  },
  {
    label: 'Chart of Accounts',
    endpoint: '/ChartOfAccounts',
    patterns: [/\bchart of account/i, /\bcoa\b/, /\bgl account/i, /\bgeneral ledger account/i, /\baccount code/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'Code,Name,AccountType,Balance,ActiveAccount,Level,FatherAccountKey',
    headers: ['Code', 'Name', 'Type', 'Balance', 'Active', 'Level', 'Parent'],
    row: r => [
      r.Code ?? '—',
      r.Name ?? '—',
      r.AccountType ?? '—',
      fmt(r.Balance),
      r.ActiveAccount === 'tYES' ? 'Yes' : 'No',
      r.Level ?? '—',
      r.FatherAccountKey ?? '—',
    ],
  },
  // ── SERVICE ────────────────────────────────────────────────────────────────
  {
    label: 'Service Calls',
    endpoint: '/ServiceCalls',
    patterns: [/\bservice call/i, /\bsupport ticket/i, /\bservice ticket/i, /\bservice request/i, /\bsc\b/],
    statusField: null,       // Status is numeric (-3=Open,-2=Pending,-1=Closed) — skip OData status filter
    openValue: null,
    openNumericFilter: 'Status ne -1',  // filter open/pending when user says "open"
    dateField: 'CreationDate',
    cardField: 'CustomerCode',
    select: 'ServiceCallID,CreationDate,Subject,CustomerCode,CustomerName,Status,Priority,TechnicianCode',
    headers: ['ID', 'Date', 'Subject', 'Customer', 'Name', 'Status', 'Priority', 'Technician'],
    row: r => [
      r.ServiceCallID ?? '—',
      r.CreationDate ? r.CreationDate.substring(0, 10) : '—',
      r.Subject ?? '—',
      r.CustomerCode ?? '—',
      r.CustomerName ?? '—',
      r.Status === -3 ? 'Open' : r.Status === -2 ? 'Pending' : r.Status === -1 ? 'Closed' : (r.Status ?? '—'),
      r.Priority === 'scp_Low' ? 'Low' : r.Priority === 'scp_Medium' ? 'Medium' : r.Priority === 'scp_High' ? 'High' : (r.Priority ?? '—'),
      r.TechnicianCode ?? '—',
    ],
  },
  // ── CRM ────────────────────────────────────────────────────────────────────
  {
    label: 'Activities',
    endpoint: '/Activities',
    patterns: [/\bactivit/i, /\btask[s]?\b/i, /\bmeeting[s]?\b/i, /\bcall log/i],
    guard: msg => !/credit note|ar note|debit note/i.test(msg),
    statusField: 'Closed',
    openValue: 'tNO',
    dateField: 'ActivityDate',
    cardField: 'CardCode',
    select: 'ActivityCode,ActivityDate,CardCode,ActivityType,Subject,Closed,Notes',
    headers: ['Code', 'Date', 'Card', 'Type', 'Subject', 'Closed'],
    row: r => [
      r.ActivityCode ?? '—',
      r.ActivityDate ? r.ActivityDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.ActivityType ?? '—',
      r.Subject ?? '—',
      r.Closed === 'tYES' ? 'Yes' : 'No',
    ],
  },
  {
    label: 'Sales Opportunities',
    endpoint: '/SalesOpportunities',
    patterns: [/\bsales opportunit/i, /\bopportunit/i, /\bdeal[s]?\b/i, /\blead[s]?\b/i, /\bprospect/i],
    statusField: 'Status',
    openValue: 'sos_Open',
    closedValue: 'sos_Won',   // Won or Lost both mean "closed" in SAP B1
    dateField: 'StartDate',
    cardField: 'CardCode',
    select: 'SequentialNo,StartDate,CardCode,CustomerName,SalesPerson,Status,MaxLocalTotal,ClosingPercentage',
    headers: ['Seq', 'Date', 'Card', 'Name', 'Sales Person', 'Status', 'Max Total', 'Close %'],
    row: r => [
      r.SequentialNo ?? '—',
      r.StartDate ? r.StartDate.substring(0, 10) : '—',
      r.CardCode ?? '—',
      r.CustomerName ?? '—',
      r.SalesPerson ?? '—',
      r.Status === 'sos_Open' ? 'Open' : r.Status === 'sos_Won' ? 'Won' : r.Status === 'sos_Lost' ? 'Lost' : (r.Status ?? '—'),
      fmt(r.MaxLocalTotal),
      r.ClosingPercentage != null ? `${r.ClosingPercentage}%` : '—',
    ],
  },
  {
    label: 'Contact Employees',
    endpoint: '/ContactEmployees',
    patterns: [/\bcontact employee/i, /\bbp contact/i, /\bcontact person/i, /\bcontact[s]?\b/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: 'CardCode',
    select: 'CardCode,Name,FirstName,LastName,Title,Position,E_Mail,Phone1,MobilePhone',
    headers: ['Card', 'Name', 'Title', 'Position', 'Email', 'Phone', 'Mobile'],
    row: r => [
      r.CardCode ?? '—',
      (r.Name || (`${r.FirstName ?? ''} ${r.LastName ?? ''}`).trim()) || '—',
      r.Title ?? '—',
      r.Position ?? '—',
      r.E_Mail ?? '—',
      r.Phone1 ?? '—',
      r.MobilePhone ?? '—',
    ],
  },
  // ── MASTER DATA ────────────────────────────────────────────────────────────
  {
    label: 'Employees',
    endpoint: '/EmployeesInfo',
    patterns: [/\bemployee[s]?\b/i, /\bstaff\b/i, /\bhrm\b/, /\bhr employee/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'EmployeeID,FirstName,LastName,JobTitle,Department,Branch,WorkCountryCode,Active',
    headers: ['ID', 'First Name', 'Last Name', 'Job Title', 'Dept', 'Branch', 'Active'],
    row: r => [
      r.EmployeeID ?? '—',
      r.FirstName ?? '—',
      r.LastName ?? '—',
      r.JobTitle ?? '—',
      r.Department ?? '—',
      r.Branch ?? '—',
      r.Active === 'tYES' ? 'Yes' : 'No',
    ],
  },
  {
    label: 'Price Lists',
    endpoint: '/PriceLists',
    patterns: [/\bprice list/i, /\bpricing list/i, /\bpricelist/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'PriceListNo,PriceListName,BasePriceList,Factor,RoundingMethod,Active',
    headers: ['#', 'Name', 'Base List', 'Factor', 'Rounding', 'Active'],
    row: r => [
      r.PriceListNo ?? '—',
      r.PriceListName ?? '—',
      r.BasePriceList ?? '—',
      r.Factor ?? '—',
      r.RoundingMethod ?? '—',
      r.Active === 'tYES' ? 'Yes' : 'No',
    ],
  },
  {
    label: 'Item Groups',
    endpoint: '/ItemGroups',
    patterns: [/\bitem group/i, /\bproduct group/i, /\barticle group/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'Number,GroupName,PriceListNum,DefWarehouse',
    headers: ['#', 'Group Name', 'Price List', 'Default Whse'],
    row: r => [
      r.Number ?? '—',
      r.GroupName ?? '—',
      r.PriceListNum ?? '—',
      r.DefWarehouse ?? '—',
    ],
  },
  {
    label: 'Warehouses',
    endpoint: '/Warehouses',
    patterns: [/\bwarehouse[s]?\b/i, /\bwhse[s]?\b/i, /\bstorage location/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'WarehouseCode,WarehouseName,City,Country,Inactive',
    headers: ['Code', 'Name', 'City', 'Country', 'Active'],
    row: r => [
      r.WarehouseCode ?? '—',
      r.WarehouseName ?? '—',
      r.City ?? '—',
      r.Country ?? '—',
      r.Inactive === 'tYES' ? 'No' : 'Yes',
    ],
  },
  {
    label: 'Territories',
    endpoint: '/Territories',
    patterns: [/\bterri?tor/i, /\bsales territory/i, /\bregion[s]?\b/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'TerritoryID,Description,LocationInMap,Parent',
    headers: ['ID', 'Description', 'Location', 'Parent'],
    row: r => [
      r.TerritoryID ?? '—',
      r.Description ?? '—',
      r.LocationInMap ?? '—',
      r.Parent ?? '—',
    ],
  },
  {
    label: 'Payment Terms',
    endpoint: '/PaymentTermsTypes',
    patterns: [/\bpayment term/i, /\bpayment condition/i, /\bcredit term/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'GroupNumber,PaymentTermsGroupName,CashDiscountPercent,NumberOfAdditionalMonths,NumberOfAdditionalDays',
    headers: ['#', 'Name', 'Cash Disc %', 'Add. Months', 'Add. Days'],
    row: r => [
      r.GroupNumber ?? '—',
      r.PaymentTermsGroupName ?? '—',
      r.CashDiscountPercent != null ? `${r.CashDiscountPercent}%` : '—',
      r.NumberOfAdditionalMonths ?? '—',
      r.NumberOfAdditionalDays ?? '—',
    ],
  },
  {
    label: 'Blanket Agreements',
    endpoint: '/BlanketAgreements',
    patterns: [/\bblanket agreement/i, /\bframework agreement/i, /\bmaster agreement/i, /\bba\b/],
    statusField: 'Status',
    openValue: 'asoApproved',
    dateField: 'StartDate',
    cardField: 'BPCode',
    select: 'AgreementNo,BPCode,BPName,StartDate,EndDate,Status,AgreementType,Description',
    headers: ['#', 'BP Code', 'BP Name', 'Start', 'End', 'Status', 'Type', 'Description'],
    row: r => [
      r.AgreementNo ?? '—',
      r.BPCode ?? '—',
      r.BPName ?? '—',
      r.StartDate ? r.StartDate.substring(0, 10) : '—',
      r.EndDate ? r.EndDate.substring(0, 10) : '—',
      r.Status ?? '—',
      r.AgreementType ?? '—',
      r.Description ?? '—',
    ],
  },
  {
    label: 'Profit Centers',
    endpoint: '/ProfitCenters',
    patterns: [/\bprofit center/i, /\bcost center/i, /\bpnl center/i, /\bpc\b/],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'CenterCode,CenterName,InWhichDimension,CostCenterType,EffectiveFrom,EffectiveTo,Active',
    headers: ['Code', 'Name', 'Dimension', 'Type', 'From', 'To', 'Active'],
    row: r => [
      r.CenterCode ?? '—',
      r.CenterName ?? '—',
      r.InWhichDimension ?? '—',
      r.CostCenterType ?? '—',
      r.EffectiveFrom ? r.EffectiveFrom.substring(0, 10) : '—',
      r.EffectiveTo ? r.EffectiveTo.substring(0, 10) : '—',
      r.Active === 'tYES' ? 'Yes' : 'No',
    ],
  },
  {
    label: 'Sales Tax Authorities',
    endpoint: '/SalesTaxAuthorities',
    patterns: [/\bsales tax authorit/i, /\btax authorit/i, /\bvat authorit/i, /\btax code/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'Code,Name,Rate,Type,Country',
    headers: ['Code', 'Name', 'Rate %', 'Type', 'Country'],
    row: r => [
      r.Code ?? '—',
      r.Name ?? '—',
      r.Rate != null ? `${r.Rate}%` : '—',
      r.Type ?? '—',
      r.Country ?? '—',
    ],
  },
  {
    label: 'Currencies',
    endpoint: '/Currencies',
    patterns: [/\bcurrenc/i, /\bforex\b/i, /\bexchange rate/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'Code,Name,Symbol,Decimals,Rounding,RoundingTo',
    headers: ['Code', 'Name', 'Symbol', 'Decimals', 'Rounding'],
    row: r => [
      r.Code ?? '—',
      r.Name ?? '—',
      r.Symbol ?? '—',
      r.Decimals ?? '—',
      r.Rounding ?? '—',
    ],
  },
  {
    label: 'Business Partner Groups',
    endpoint: '/BusinessPartnerGroups',
    patterns: [/\bbp group/i, /\bbusiness partner group/i, /\bcustomer group/i, /\bvendor group/i],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'Code,Name,Type',
    headers: ['Code', 'Name', 'Type'],
    row: r => [
      r.Code ?? '—',
      r.Name ?? '—',
      r.Type ?? '—',
    ],
  },
  {
    label: 'Sales Persons',
    endpoint: '/SalesPersons',
    patterns: [/\bsales person/i, /\bsalesperson/i, /\bsales rep/i, /\bslp\b/],
    statusField: null,
    openValue: null,
    dateField: null,
    cardField: null,
    select: 'SalesEmployeeCode,SalesEmployeeName,Active,CommissionPercent',
    headers: ['Code', 'Name', 'Active', 'Commission %'],
    row: r => [
      r.SalesEmployeeCode ?? '—',
      r.SalesEmployeeName ?? '—',
      r.Active === 'tYES' ? 'Yes' : 'No',
      r.CommissionPercent != null ? `${r.CommissionPercent}%` : '—',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// QUERY PARSER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse natural language query into structured components.
 * @param {string} msg
 * @returns {{ entity, dateFilter, cardCode, statusFilter, amountFilter, searchTerm, topN, orderBy }}
 */
function parseNLQuery(msg) {
  const m = msg.trim();
  const lower = m.toLowerCase();

  // ── 1. Entity matching ────────────────────────────────────────────────────
  // Prefer more specific matches: score by matched pattern source length
  let entity = null;
  let bestScore = -1;
  for (const e of SL_ENTITIES) {
    // Check guard first — skips ambiguous entities when context says otherwise
    if (e.guard && !e.guard(m)) continue;
    for (const p of e.patterns) {
      if (p.test(m)) {
        const score = p.source.length;
        if (score > bestScore) { bestScore = score; entity = e; }
        break;
      }
    }
  }

  // ── 2. Date filter ────────────────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let dateFilter = null;

  // "last N days"
  const lastNDays = lower.match(/last\s+(\d+)\s+days?/);
  if (lastNDays) {
    const n = parseInt(lastNDays[1], 10);
    const from = new Date(today);
    from.setDate(today.getDate() - n + 1);
    dateFilter = { from: fmtDate(from), to: fmtDate(today) };
  }
  // today
  else if (/\btoday\b/.test(lower)) {
    dateFilter = { from: fmtDate(today), to: fmtDate(today) };
  }
  // yesterday
  else if (/\byesterday\b/.test(lower)) {
    const yd = new Date(today);
    yd.setDate(today.getDate() - 1);
    dateFilter = { from: fmtDate(yd), to: fmtDate(yd) };
  }
  // this week
  else if (/\bthis\s+week\b/.test(lower)) {
    const sw = startOfWeek(today);
    dateFilter = { from: fmtDate(sw), to: fmtDate(today) };
  }
  // last week
  else if (/\blast\s+week\b/.test(lower)) {
    const sw = startOfWeek(today);
    const lws = new Date(sw);
    lws.setDate(sw.getDate() - 7);
    const lwe = new Date(sw);
    lwe.setDate(sw.getDate() - 1);
    dateFilter = { from: fmtDate(lws), to: fmtDate(lwe) };
  }
  // this month
  else if (/\bthis\s+month\b/.test(lower)) {
    const som = startOfMonth(today);
    dateFilter = { from: fmtDate(som), to: fmtDate(today) };
  }
  // last month
  else if (/\blast\s+month\b/.test(lower)) {
    const lmEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lmStart = startOfMonth(lmEnd);
    dateFilter = { from: fmtDate(lmStart), to: fmtDate(lmEnd) };
  }
  // this year
  else if (/\bthis\s+year\b/.test(lower)) {
    dateFilter = { from: `${today.getFullYear()}-01-01`, to: fmtDate(today) };
  }
  // last year
  else if (/\blast\s+year\b/.test(lower)) {
    const ly = today.getFullYear() - 1;
    dateFilter = { from: `${ly}-01-01`, to: `${ly}-12-31` };
  }
  // specific 4-digit year e.g. "2024"
  else {
    const yearMatch = lower.match(/\b(20\d{2})\b/);
    if (yearMatch) {
      const yr = yearMatch[1];
      // Check it's not part of a month+year pattern handled below
      const myTest = new RegExp(
        `(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\\s+${yr}`,
        'i'
      );
      if (!myTest.test(lower)) {
        dateFilter = { from: `${yr}-01-01`, to: `${yr}-12-31` };
      }
    }

    // specific month + year e.g. "January 2025" or "Jan 2024"
    const monthYearMatch = lower.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(20\d{2})\b/i
    );
    if (monthYearMatch) {
      const mIdx = MONTH_MAP[monthYearMatch[1].toLowerCase()];
      const yr = parseInt(monthYearMatch[2], 10);
      const mStart = new Date(yr, mIdx, 1);
      const mEnd = endOfMonth(mStart);
      dateFilter = { from: fmtDate(mStart), to: fmtDate(mEnd) };
    }

    // date range "from January to March" / "from Jan to Mar" (current year assumed)
    const rangeMatch = lower.match(
      /from\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+to\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)/i
    );
    if (rangeMatch) {
      const mFromIdx = MONTH_MAP[rangeMatch[1].toLowerCase()];
      const mToIdx = MONTH_MAP[rangeMatch[2].toLowerCase()];
      const yr = today.getFullYear();
      const rFrom = new Date(yr, mFromIdx, 1);
      const rTo = endOfMonth(new Date(yr, mToIdx, 1));
      dateFilter = { from: fmtDate(rFrom), to: fmtDate(rTo) };
    }
  }

  // ── 3. Card code ──────────────────────────────────────────────────────────
  let cardCode = null;
  // explicit patterns: "for customer C00001", "for vendor V00001"
  const explicitCard = m.match(
    /\bfor\s+(?:customer|vendor|client|supplier)\s+([A-Z0-9_\-]{2,20})\b/i
  );
  if (explicitCard) {
    cardCode = explicitCard[1].toUpperCase();
  } else {
    // "for" followed by what looks like a card code
    const forCard = m.match(/\bfor\s+([A-Z][A-Z0-9]{2,19})\b/);
    if (forCard) cardCode = forCard[1].toUpperCase();
  }

  // ── 4. Status filter ──────────────────────────────────────────────────────
  let statusFilter = null;
  if (/\bopen\b/i.test(lower)) statusFilter = 'open';
  else if (/\bclosed?\b/i.test(lower)) statusFilter = 'closed';
  else if (/\bcancell?ed\b/i.test(lower)) statusFilter = 'cancelled';
  else if (/\bdraft\b/i.test(lower)) statusFilter = 'draft';

  // ── 5. Amount filter ──────────────────────────────────────────────────────
  let amountFilter = null;
  const overMatch = lower.match(/\bover\s+([\d,]+(?:\.\d+)?)\b/);
  const underMatch = lower.match(/\bunder\s+([\d,]+(?:\.\d+)?)\b/);
  const aboveMatch = lower.match(/\babove\s+([\d,]+(?:\.\d+)?)\b/);
  const belowMatch = lower.match(/\bbelow\s+([\d,]+(?:\.\d+)?)\b/);
  const greaterMatch = lower.match(/\bgreater\s+than\s+([\d,]+(?:\.\d+)?)\b/);
  const lessMatch = lower.match(/\bless\s+than\s+([\d,]+(?:\.\d+)?)\b/);

  if (overMatch || aboveMatch || greaterMatch) {
    const v = parseFloat((overMatch || aboveMatch || greaterMatch)[1].replace(/,/g, ''));
    amountFilter = { op: 'gt', value: v };
  } else if (underMatch || belowMatch || lessMatch) {
    const v = parseFloat((underMatch || belowMatch || lessMatch)[1].replace(/,/g, ''));
    amountFilter = { op: 'lt', value: v };
  }

  // ── 6. Search term ────────────────────────────────────────────────────────
  let searchTerm = null;
  const searchMatch = lower.match(
    /(?:containing|with description|named|called|description)\s+["']?([a-z0-9 _\-]+)["']?/i
  );
  if (searchMatch) searchTerm = searchMatch[1].trim();

  // ── 7. Top N ──────────────────────────────────────────────────────────────
  let topN = 50;
  const topMatch = lower.match(/\b(?:top|show|first|last|get)\s+(\d+)\b/);
  if (topMatch) topN = parseInt(topMatch[1], 10);

  // ── 8. Order by ───────────────────────────────────────────────────────────
  let orderBy = null;
  if (/\bhighest\b/i.test(lower) || /\blargest\b/i.test(lower)) {
    orderBy = 'DocTotal desc';
  } else if (/\blowest\b/i.test(lower) || /\bsmallest\b/i.test(lower)) {
    orderBy = 'DocTotal asc';
  } else if (/\blatest\b/i.test(lower) || /\brecent\b/i.test(lower) || /\bnewest\b/i.test(lower)) {
    orderBy = null; // will be set as date desc in builder
  } else if (/\boldest\b/i.test(lower) || /\bearliest\b/i.test(lower)) {
    orderBy = 'date_asc';
  }

  return { entity, dateFilter, cardCode, statusFilter, amountFilter, searchTerm, topN, orderBy };
}

// ─────────────────────────────────────────────────────────────────────────────
// ODATA BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build OData query params from parsed NL query and entity config.
 * @param {object} entity  - SL_ENTITIES entry
 * @param {object} parsed  - result of parseNLQuery
 * @returns {object} OData params
 */
function buildODataParams(entity, parsed) {
  const filters = [];

  // Date filter
  if (parsed.dateFilter && entity.dateField) {
    const df = parsed.dateField || entity.dateField;
    const { from, to } = parsed.dateFilter;
    if (from && to) {
      filters.push(`${df} ge '${from}' and ${df} le '${to}'`);
    } else if (from) {
      filters.push(`${df} ge '${from}'`);
    } else if (to) {
      filters.push(`${df} le '${to}'`);
    }
  }

  // Card code filter
  if (parsed.cardCode && entity.cardField) {
    filters.push(`${entity.cardField} eq '${esc(parsed.cardCode)}'`);
  }

  // Status filter
  if (parsed.statusFilter) {
    if (entity.openNumericFilter && parsed.statusFilter === 'open') {
      // Numeric status (e.g. Service Calls)
      filters.push(entity.openNumericFilter);
    } else if (entity.statusField) {
      const sf = entity.statusField;
      switch (parsed.statusFilter) {
        case 'open':
          if (entity.openValue) filters.push(`${sf} eq '${entity.openValue}'`);
          break;
        case 'closed':
          filters.push(entity.closedValue ? `${sf} eq '${entity.closedValue}'` : `${sf} eq 'bost_Close'`);
          break;
        case 'cancelled':
          filters.push(`${sf} eq 'bost_Canceled'`);
          break;
        case 'draft':
          filters.push(`${sf} eq 'bost_Draft'`);
          break;
      }
    }
  }

  // Amount filter
  if (parsed.amountFilter) {
    filters.push(`DocTotal ${parsed.amountFilter.op} ${parsed.amountFilter.value}`);
  }

  // Determine orderby
  let orderby;
  if (parsed.orderBy === 'DocTotal desc' || parsed.orderBy === 'DocTotal asc') {
    orderby = parsed.orderBy;
  } else if (parsed.orderBy === 'date_asc' && entity.dateField) {
    orderby = `${entity.dateField} asc`;
  } else if (entity.dateField) {
    orderby = `${entity.dateField} desc`;
  } else {
    orderby = undefined;
  }

  const params = {
    $select: entity.select,
    $top: parsed.topN,
  };

  if (filters.length > 0) {
    params.$filter = filters.join(' and ');
  }

  if (orderby) {
    params.$orderby = orderby;
  }

  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// TABLE FORMATTER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format rows into a markdown table.
 * @param {string[]} headers
 * @param {Array<Array>} rows
 * @returns {string} markdown table
 */
function autoFormatTable(headers, rows) {
  if (!rows || rows.length === 0) return '_No records found._';
  return tbl(headers, rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW-UP SUGGESTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return 3 contextual follow-up query suggestions.
 * @param {object} entity
 * @param {object} parsed
 * @returns {string[]}
 */
function suggestFollowUps(entity, parsed) {
  const label = entity.label;
  const ep = entity.endpoint;
  const suggestions = [];

  // Date-based follow-ups
  if (!parsed.dateFilter) {
    suggestions.push(`Show ${label} for this month`);
    suggestions.push(`Show ${label} for this year`);
  } else {
    suggestions.push(`Show ${label} for last month`);
    suggestions.push(`Show ${label} for this year`);
  }

  // Status follow-ups
  if (entity.statusField) {
    if (parsed.statusFilter !== 'open') {
      suggestions.push(`Show open ${label}`);
    } else {
      suggestions.push(`Show closed ${label}`);
    }
  }

  // Amount follow-ups
  if (!parsed.amountFilter) {
    suggestions.push(`Show ${label} over 10000`);
  }

  // Top N follow-up
  if (!parsed.topN || parsed.topN <= 10) {
    suggestions.push(`Show top 50 ${label}`);
  } else {
    suggestions.push(`Show top 10 ${label} highest value`);
  }

  // Entity-specific follow-ups
  if (ep === '/Invoices') {
    suggestions.push(`Show open AR Invoices`);
    suggestions.push(`Show incoming payments this month`);
  } else if (ep === '/Orders') {
    suggestions.push(`Show open sales orders`);
    suggestions.push(`Show delivery notes this month`);
  } else if (ep === '/PurchaseOrders') {
    suggestions.push(`Show open purchase orders`);
    suggestions.push(`Show purchase invoices this month`);
  } else if (ep === '/Quotations') {
    suggestions.push(`Show open sales quotations`);
    suggestions.push(`Show sales orders this month`);
  } else if (ep === '/DeliveryNotes') {
    suggestions.push(`Show open delivery notes`);
    suggestions.push(`Show AR invoices this month`);
  } else if (ep === '/IncomingPayments') {
    suggestions.push(`Show incoming payments this year`);
    suggestions.push(`Show open AR invoices`);
  } else if (ep === '/VendorPayments') {
    suggestions.push(`Show vendor payments this year`);
    suggestions.push(`Show open AP invoices`);
  } else if (ep === '/ProductionOrders') {
    suggestions.push(`Show open production orders`);
    suggestions.push(`Show production orders this month`);
  } else if (ep === '/ServiceCalls') {
    suggestions.push(`Show open service calls`);
    suggestions.push(`Show service calls this month`);
  } else if (ep === '/SalesOpportunities') {
    suggestions.push(`Show open sales opportunities`);
    suggestions.push(`Show sales opportunities this year`);
  } else if (ep === '/JournalEntries') {
    suggestions.push(`Show journal entries this month`);
    suggestions.push(`Show journal entries this year`);
  } else if (ep === '/Activities') {
    suggestions.push(`Show open activities`);
    suggestions.push(`Show activities this week`);
  }

  // Deduplicate and return first 3
  const seen = new Set();
  const result = [];
  for (const s of suggestions) {
    if (!seen.has(s) && result.length < 3) {
      seen.add(s);
      result.push(s);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a natural language query to a SAP B1 Service Layer call and
 * return formatted markdown output.
 *
 * @param {string} msg         - The user's natural language query
 * @param {object} sapClient   - Client with `.get(path, params)` method
 * @returns {Promise<string|null>} Markdown string, or null if entity not recognised
 */
export async function nlpQuery(msg, sapClient) {
  const parsed = parseNLQuery(msg);

  // Unknown entity — let caller handle
  if (!parsed.entity) return null;

  const entity = parsed.entity;
  const params = buildODataParams(entity, parsed);

  let data;
  try {
    data = await sapClient.get(entity.endpoint, params);
  } catch (err) {
    return `Error fetching ${entity.label}: ${err.message ?? String(err)}`;
  }

  const rows = Array.isArray(data?.value)
    ? data.value
    : data && typeof data === 'object'
      ? [data]
      : [];

  if (!rows.length) {
    return `No ${entity.label} found matching your query.`;
  }

  // Totals line
  const total = rows.reduce((s, r) => s + Number(r.DocTotal ?? 0), 0);
  const totalLine =
    total > 0
      ? `\n\n**Total: ${rows.length} records** | **Value: ${total.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}**`
      : `\n\n**${rows.length} record${rows.length === 1 ? '' : 's'} found**`;

  // Build table
  const tableRows = rows.map(r => entity.row(r));
  const table = autoFormatTable(entity.headers, tableRows);

  // Follow-up suggestions
  const suggestions = suggestFollowUps(entity, parsed);
  const followUp =
    suggestions.length > 0
      ? `\n\n💡 You can also ask:\n${suggestions.map(s => `• \`${s}\``).join('\n')}`
      : '';

  const icon = getIcon(entity.endpoint);
  return `### ${icon} ${entity.label}${totalLine}\n\n${table}${followUp}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Named exports for unit testing / reuse
// ─────────────────────────────────────────────────────────────────────────────
export {
  parseNLQuery,
  buildODataParams,
  autoFormatTable,
  suggestFollowUps,
  SL_ENTITIES,
  fmt,
  tbl,
  getIcon,
  esc,
};
