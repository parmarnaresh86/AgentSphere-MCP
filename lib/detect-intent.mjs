// Rule-based NLP router — runs before any AI call on every /api/chat message.
// Matches the user's wording against known SAP B1 request patterns and
// returns a structured { action, ... } the caller routes on, or null if
// nothing matched (falls through to nlpQuery / the AI agent).
//
// Pulled out of chat-server.mjs as its own module so it can be read, tested,
// and extended without touching the 8,000+ line request-handling file around
// it. It's a pure function: given the same msg and ctx, always the same
// result — no SAP/DB calls, no side effects.
//
// ctx:
//   lastSAContext  — { dimField, dimName, brands: Set, values: Set, ... } | null
//                     the last sales-analysis breakdown shown, so a bare
//                     value typed next ("STRIPE TIKTOK") is recognized as a
//                     drill-down into it rather than an unrelated question.
//   dimAliasPattern — RegExp source string matching any configured cost-centre
//                     dimension alias (Brand/SubBrand/Budget/...), built from
//                     SA_DIMENSIONS in chat-server.mjs.

const STOP = new Set(["ATP", "FOR", "QTY", "PRICE", "AND", "THE", "CHECK", "ITEM", "ITEMS", "STOCK", "ORDER", "FROM", "DELIVERY", "INVOICE"]);

export function detectIntent(msg, ctx = {}) {
  const { lastSAContext = null, dimAliasPattern = "(?!)" } = ctx;
  const m = msg.toLowerCase().trim();
  if (/^help$|what can|what.*tool|commands/.test(m))  return { action:"help" };
  if (/print/.test(m))                                 return { action:"print", msg };

  // ── Follow-up drill-down for any value from the last result ──
  // User can type any value shown in the last table (brand, customer code, item, month…)
  // to get a detailed breakdown for that specific value.
  if (lastSAContext?.values?.size) {
    for (const val of lastSAContext.values) {
      if (!val || val.length < 2) continue;
      const vl = val.toLowerCase();
      const escaped = vl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match exact message OR as a whole word anywhere in the message
      if (m === vl || new RegExp(`(?:^|[\\s,])${escaped}(?:[\\s,]|$)`, 'i').test(m)) {
        return { action: 'dim_detail', value: val, context: lastSAContext };
      }
    }
  }

  // ── KPI / Dashboard ──
  if (/\bkpi\b|dashboard|summary|overview|snapshot/.test(m)) return { action:"kpi" };

  // ── Sales Analysis (HANA sml.svc) — all fields from SA_DIMENSIONS registry ──
  // NOTE: use unescaped dots (".") as word-separator wildcards (matches space, dash, etc.)
  const _saBasePattern = /sales.?analysis|revenue.by|sales.by|sales.per|profit.by|gp.by|margin.by|top.customer|top.item|top.product|monthly.sale|quarterly.sale|annual.sale|yearly.sale|sales.trend|sales.rep.performance|salesperson.perform|salesperson.analysis|item.group.sale|show.*sales|sales.*report|revenue.*report|wise.*sale|wise.*revenue|wise.*profit|delivery.?wise|invoice.?wise|order.?wise|sales.by.year|sales.by.month|sales.by.quarter|by.customer.*sale|by.item.*sale|sales.by.customer|sales.by.item|sales.by.brand|revenue.by.customer|revenue.by.item/;
  if (_saBasePattern.test(m) || new RegExp(dimAliasPattern,'i').test(m))
    return { action:"sales_analysis" };

  // ── Purchase Analysis — includes cost-centre dimensions ──
  if (/purchase.?analysis|top.vendor|top.supplier|what.*bought|spend.by|procurement|buying.trend|brand.?wise.*purchase|purchase.*brand.?wise|brand.?wise.*po|po.*brand/.test(m))
    return { action:"purchase_analysis" };

  // ── AR Aging ──
  if (/\bar.aging|\breceivable.*aging|aging.*report.*ar|who.*owe.*us|aging.*invoice/.test(m))
    return { action:"ar_aging" };

  // ── AP Aging ──
  if (/\bap.aging|\bpayable.*aging|aging.*report.*ap|what.*we.*owe|aging.*purchase/.test(m))
    return { action:"ap_aging" };

  // ── Pre-defined Report shortcuts ──
  if (/\bdpo\b|days.payable|payable.outstanding/.test(m))
    return { action:"run_report", reportId:"dpo" };
  if (/vendor.*outstanding|outstanding.*vendor|supplier.*outstanding/.test(m))
    return { action:"run_report", reportId:"vendor_outstanding" };
  if (/customer.*outstanding|outstanding.*customer|outstanding.*balance/.test(m))
    return { action:"run_report", reportId:"customer_outstanding" };
  if (/monthly.*sale.*trend|sale.*trend|sales.*by.*month|monthly.*revenue/.test(m))
    return { action:"run_report", reportId:"monthly_sales" };
  if (/sale.*by.*employee|sale.*by.*rep|sale.*by.*sales.?person|employee.*sale/.test(m))
    return { action:"run_report", reportId:"sales_by_employee" };
  if (/sale.*growth|yoy.*sale|year.*over.*year.*sale|growth.*analysis/.test(m))
    return { action:"run_report", reportId:"sales_growth" };
  if (/stock.*valuation|valuation.*stock|inventory.*value|stock.*value/.test(m))
    return { action:"run_report", reportId:"stock_valuation" };
  if (/dead.*stock|zero.*movement|no.*movement/.test(m))
    return { action:"run_report", reportId:"dead_stock" };
  if (/slow.*moving|slow.*stock|slow.*item/.test(m))
    return { action:"run_report", reportId:"slow_moving" };
  if (/inventory.*turnover|turnover.*inventory|days.*of.*stock/.test(m))
    return { action:"run_report", reportId:"inventory_turnover" };
  if (/open.*po|open.*purchase.?order|pending.*po/.test(m))
    return { action:"run_report", reportId:"open_po" };
  if (/p.?&.?l|profit.*loss|pl.*summary|income.*statement/.test(m))
    return { action:"run_report", reportId:"pl_summary" };
  if (/purchase.*vs.*sale|sale.*vs.*purchase|purchase.*comparison/.test(m))
    return { action:"run_report", reportId:"purchase_vs_sales" };
  if (/sales.*projection|20.*pct.*drop|20.*percent.*drop|scenario.*anal/.test(m))
    return { action:"run_report", reportId:"sales_projection" };

  // ── Open Orders ──
  if (/open.*order|pending.*order|order.*status|order.*pipeline/.test(m) && !/purchase|po\b/.test(m))
    return { action:"open_orders", msg };

  // ── Open Quotations ──
  if (/open.*quot|pending.*quot|quot.*pipeline|open.*proposal/.test(m))
    return { action:"open_quotations", msg };

  // ── Vendors ──
  if (/vendor|supplier|\bsupplier\b/.test(m) && !/invoice|payment|aging/.test(m))
    return { action:"vendors", msg };

  // ── Customers / Business Partners ──
  if (/customer|client|business.?partner|\bbp\b|list.*partner|partner.*list/.test(m) && !/order|invoice|payment|delivery|quotat|transaction|sale|purchas/.test(m))
    return { action:"tool", tool:"get_customer_list", args:{ topN:50, ...(/search|find|named?/.test(m)?{ search: msg.match(/(?:search|find|named?|called?)\s+([A-Za-z0-9 ]+)/i)?.[1]?.trim() }:{}) }};

  // ── Stock / Item list ──
  if (/\bstock\b|inventor|all.*item|product.*list|list.*item|item.*list|show.*item|item.*master|all.*product|product.*catalog|item.*catalog|show\s+me.*item|\bitem[s]?\s*directo/.test(m) && !/order|invoice|deliver|atp|group/.test(m))
    return { action:"tool", tool:"get_total_stock", args:{ topN:100, inStockOnly:/in.?stock only|with stock/.test(m) }};

  // ── ATP ──
  if (/\batp\b|available.to.promise|check.*avail/.test(m)) {
    const codes = [...msg.matchAll(/\b([A-Z][A-Z0-9\-]{2,})\b/g)].map(x=>x[1]).filter(c=>!STOP.has(c));
    const qty = parseInt(msg.match(/(\d+)/)?.[1]||"1");
    return { action:"tool", tool:"check_atp", args:{ items: codes.map(c=>({ itemCode:c, requiredQty:qty })) }};
  }

  // ── Collections ──
  if (/collect|overdue|dunning|\breceivable|outstanding/.test(m))
    return { action:"tool", tool:"get_collections_worklist", args:{ overdueMoreThanDays: parseInt(msg.match(/(\d+)\s*days?/i)?.[1]||"30"), topN:10 }};

  // ── Pick List ──
  if (/pick.?list|picklist/.test(m))
    return { action:"tool", tool:"get_pick_list", args:{ salesOrderDocEntry: parseInt(msg.match(/\b(\d+)\b/)?.[1]) }};

  // ── New SMLSVC analytical tools ──
  if (/top.{0,10}customer|best.customer|customer.rank/.test(m) && !/vendor|supplier/.test(m)) {
    const topN = parseInt(msg.match(/top\s*(\d+)/i)?.[1]||"10");
    return { action:"smlsvc", queryType:"top_customers", topN, msg };
  }
  if (/top.{0,10}item|best.sell|top.product|item.rank/.test(m)) {
    const topN  = parseInt(msg.match(/top\s*(\d+)/i)?.[1]||"10");
    const sortBy = /qty|quantity|volume|unit/.test(m) ? "QuantityInInventoryUoM" : /profit|gp/.test(m) ? "GrossProfitLC" : "NetSalesAmountLC";
    return { action:"smlsvc", queryType:"top_items", topN, sortBy, msg };
  }
  if (/monthly|by.month|per.month|sales.trend|month.trend/.test(m))
    return { action:"smlsvc", queryType:"by_period", periodType:"month", msg };
  if (/quarterly|by.quarter|per.quarter/.test(m))
    return { action:"smlsvc", queryType:"by_period", periodType:"quarter", msg };
  if (/by.year|year.?on.?year|yoy|annual.trend/.test(m)) {
    const y1 = parseInt(msg.match(/\b(20\d\d)\b/)?.[1] || String(new Date().getFullYear()));
    return { action:"smlsvc", queryType:"year_over_year", year1: y1, year2: y1-1, msg };
  }
  if (/salesperson|sales.?rep|sales.?employee|by.employee/.test(m))
    return { action:"smlsvc", queryType:"salesperson", msg };
  if (/item.?group|product.?group|category.?sale|by.category/.test(m))
    return { action:"smlsvc", queryType:"item_group", msg };
  if (/by.warehouse|warehouse.sale|branch.sale|by.branch/.test(m))
    return { action:"smlsvc", queryType:"warehouse", msg };

  // ── Rush Order Prioritisation Agent ──
  if (/rush.order|urgent.order|expedit|critical.order|order.priorit|rush.agent|prioriti[sz]e.*order|order.*urgent/.test(m)) {
    const daysMatch = m.match(/(\d+)\s*day/i);
    return { action: 'rush_orders', urgentWithinDays: parseInt(daysMatch?.[1] || '14') };
  }

  // ── Forecasting Agent — sales (demand) vs purchase (procurement) ──
  // Any message containing "forecast" (or predict-demand phrasing) routes here.
  // Default is the sales/demand forecast (existing behaviour); it only switches
  // to the purchase-side model when purchase/vendor words are present without
  // any sales/demand words alongside them.
  if (/forecast|predict.*demand|demand.*predict/.test(m)) {
    const isPurchase = /purchase|buying|procure|vendor|supplier|\bpo\b|reorder|re-order|restock|replenish/.test(m);
    const isSales     = /\bsale|sell|demand|customer|revenue/.test(m);
    const yrsMatch = m.match(/(\d)\s*[-]?\s*year/i) || m.match(/last\s*(\d)/i);
    const mthMatch = m.match(/(\d+)\s*month/i);
    return {
      action:   (isPurchase && !isSales) ? 'purchase_forecast' : 'product_forecast',
      years:    parseInt(yrsMatch?.[1] || '2'),
      horizon:  parseInt(mthMatch?.[1] || '12'),
    };
  }

  // ── Company info / switch ──
  if (/which.company|current.company|active.company|connected.to|company.info/.test(m))
    return { action:"tool", tool:"get_company_info", args:{} };
  if (/switch.to|change.to|connect.to|change.company/.test(m)) {
    const db = msg.match(/(?:switch|change|connect)\s+to\s+([A-Za-z0-9_]+)/i)?.[1];
    return db ? { action:"tool", tool:"switch_company", args:{ dbName: db } } : { action:"text", text:"Please specify the company DB name, e.g. `switch to SBO_DEMO_GB`" };
  }

  // ── Customer details ──
  if (/customer.info|customer.detail|tell.*customer|about.customer/.test(m)) {
    const code = msg.match(/\b([A-Z][A-Z0-9\-]{2,})\b/)?.[1];
    return code ? { action:"tool", tool:"get_customer_details", args:{ cardCode: code } } : { action:"text", text:"Please provide a customer code, e.g. `customer info C00001`" };
  }

  // ── Transactions (guides → open form) ──
  if (/(creat|new|make|add|generat).*(\bquo[tpa]|\bquat|\bproposal)/.test(m))
    return { action:"guide", tool:"create_sales_quotation", openForm:"quotation" };
  if (/(creat|convert|confirm|make).*(sales.?order|\bso\b)|order.from.quot/.test(m)) {
    const n = parseInt(msg.match(/\b(\d+)\b/)?.[1]);
    return n ? { action:"tool", tool:"create_sales_order", args:{ quotationDocEntry:n } } : { action:"guide", tool:"create_sales_order", openForm:"order" };
  }
  if (/(creat|ship|dispatch|make).*(deliver)|deliver.*from.*order/.test(m))
    return { action:"guide", tool:"create_delivery", openForm:"delivery" };
  if (/(creat|generate|issue|make).*(invoice|\binv\b)|invoice.*from.*deliver/.test(m)) {
    const n = parseInt(msg.match(/\b(\d+)\b/)?.[1]);
    return n ? { action:"tool", tool:"create_ar_invoice", args:{ deliveryDocEntry:n } } : { action:"guide", tool:"create_ar_invoice", openForm:"invoice" };
  }
  if (/incoming.payment|apply.*payment|receive.*payment|\bpayment\b/.test(m))
    return { action:"guide", tool:"apply_incoming_payment", openForm:"payment" };
  if (/\bpod\b|confirm.*pod|sign.*delivery/.test(m))
    return { action:"guide", tool:"confirm_delivery_pod", openForm:"pod" };
  if (/\batp\b|available.to.promise/.test(m) && !msg.match(/\b([A-Z][A-Z0-9\-]{2,})\b/))
    return { action:"guide", tool:"check_atp", openForm:"atp" };

  // ── P2P Transactions (guides → open form) ──
  if (/(creat|new|make|add|raise|place).*(purchase.order|\bpo\b)|(purchase.order|new.po|raise.po|create.po)/.test(m) && !/ap.invoice|ap invoice/.test(m))
    return { action:"guide", tool:"create_purchase_order", openForm:"purchaseOrder" };
  if (/(creat|receive|receipt|book).*(grpo|goods.receipt.po|goods.receipt)/.test(m)) {
    const n = parseInt(msg.match(/\b(\d+)\b/)?.[1]);
    return n ? { action:"tool", tool:"create_goods_receipt_po", args:{ purchaseOrderDocEntry:n } } : { action:"guide", tool:"create_goods_receipt_po", openForm:"grpo" };
  }
  if (/(creat|generate|issue|make|raise).*(a\/p.invoice|ap.invoice|purchase.invoice|vendor.invoice)|ap.invoice.*from|invoice.*from.*grpo/.test(m)) {
    const n = parseInt(msg.match(/\b(\d+)\b/)?.[1]);
    return n ? { action:"tool", tool:"create_ap_invoice", args:{ grpoDocEntry:n } } : { action:"guide", tool:"create_ap_invoice", openForm:"apInvoice" };
  }
  if (/outgoing.payment|pay.*vendor|vendor.payment|apply.*outgoing|pay.*supplier/.test(m))
    return { action:"guide", tool:"apply_outgoing_payment", openForm:"outgoingPayment" };

  return null;
}
