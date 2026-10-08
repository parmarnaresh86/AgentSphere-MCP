// ══════════════════════════════════════════════════════════════════════════════
// INSIGHT AGENTS — one generic full-height panel for the 8 analytical agents
// (Collections, Cash Flow, Credit Risk, Sales Follow-up, Quotation Intelligence,
// Inventory Optimization, Dead Stock, Vendor Performance).
//
// Every agent's backend (controllers/*-agent.mjs via lib/insight-kit.mjs)
// returns the same payload — kpis / chart / tabs(columns, rows, actions) /
// insight / notes — so this file renders all of them. Open one with
// showInsightAgent('<key>').
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const AGENTS = {
    collections: {
      title: 'Collections & Receivables', badge: 'A/R', api: '/api/collections-agent', c1: '#7C2D12', c2: '#EA580C', lookups: true, manualRun: true, fiori: true,
      icon: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
      params: [
        { key: 'search', label: 'Customer', type: 'combo', lookup: 'customers', showName: true, placeholder: 'All customers' },
        { key: 'fromDate', label: 'Invoice date from', type: 'date' },
        { key: 'toDate', label: 'Invoice date to', type: 'date' },
        { key: 'asOf', label: 'Aging as of' },
        { key: 'minOverdueDays', label: 'Min. days overdue', type: 'number', value: 0 },
        { key: 'lookbackMonths', label: 'Payment history (months)', type: 'number', value: 12, adv: true },
      ],
      chips: ['Who should we chase first today?', 'Which customers are getting worse at paying?', 'Summarise the >90 day overdue', 'Draft a call plan for this week'],
    },
    cashflow: {
      title: 'Cash Flow Forecast', badge: 'TREASURY', api: '/api/cash-flow-agent', c1: '#064E3B', c2: '#059669',
      icon: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
      params: [
        { key: 'weeks', label: 'Horizon (weeks)', type: 'number', value: 13 },
        { key: 'openingBalance', label: 'Opening balance', type: 'number', placeholder: 'auto: G/L cash accounts' },
      ],
      chips: ['Which weeks are at risk of a cash shortfall?', 'What are the biggest drivers of outflow?', 'Which collections would fix the lowest week?', 'Which POs could be deferred?'],
    },
    creditrisk: {
      title: 'Credit Risk', badge: 'RISK', api: '/api/credit-risk-agent', c1: '#7F1D1D', c2: '#DC2626',
      icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      params: [],
      chips: ['Which customers should go on credit hold?', 'Where are open orders most exposed?', 'Which customers deserve a higher limit?', 'Who worsened since the last run?'],
    },
    appayment: {
      title: 'AP Payment Optimization', badge: 'PAYMENT RUN', api: '/api/ap-payment-agent', c1: '#164E63', c2: '#0891B2', asOfLabel: 'Payment date',
      icon: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>',
      params: [
        { key: 'cashAvailable', label: 'Cash available', type: 'number', placeholder: 'auto: G/L cash & bank' },
        { key: 'reserve', label: 'Keep in reserve', type: 'number', value: 0 },
        { key: 'horizonDays', label: 'Window (days)', type: 'number', value: 14 },
        { key: 'strategy', label: 'Strategy', type: 'select', value: 'balanced', options: ['balanced', 'discounts', 'overdue', 'preserve'] },
        { key: 'hurdleRatePct', label: 'Discount hurdle % p.a.', type: 'number', value: 12 },
        { key: 'allowPartial', label: 'Partial payments', type: 'select', value: 'no', options: ['no', 'yes'] },
        { key: 'priorityVendors', label: 'Priority vendors', type: 'text', placeholder: 'codes, comma-separated' },
      ],
      chips: ['Which invoices must we pay this week and why?', 'What happens if we only have half the cash?', 'Which vendors are we leaving unpaid, and what is the risk?', 'Which early-payment discounts are worth taking?'],
    },
    profitability: {
      title: 'Profitability', badge: 'GROSS PROFIT', api: '/api/profitability-agent', c1: '#14532D', c2: '#16A34A', asOfLabel: 'Period to',
      icon: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
      params: [
        { key: 'days', label: 'Last N days', type: 'number', value: 90 },
        { key: 'fromDate', label: 'Or from date', type: 'date' },
        { key: 'includeCreditMemos', label: 'Net of credit memos', type: 'select', value: 'yes', options: ['yes', 'no'] },
      ],
      chips: ['Where do we make and lose money?', 'Which customers dilute our margin?', 'Compare sales employees by profit', 'Which items should we reprice?'],
    },
    marginleak: {
      title: 'Margin Leakage', badge: 'LEAKAGE', api: '/api/margin-leakage-agent', c1: '#7F1D1D', c2: '#E11D48', asOfLabel: 'Period to',
      icon: '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
      params: [
        { key: 'days', label: 'Last N days', type: 'number', value: 90 },
        { key: 'fromDate', label: 'Or from date', type: 'date' },
        { key: 'targetMarginPct', label: 'Target margin %', type: 'number', value: 15 },
        { key: 'maxDiscountPct', label: 'Max discount %', type: 'number', value: 10 },
        { key: 'anomalyPct', label: 'Anomaly: % below median', type: 'number', value: 25 },
      ],
      chips: ['What are the biggest sources of leakage?', 'Who is giving the most discount?', 'Are we recovering freight?', 'Which controls would stop this?'],
    },
    commission: {
      title: 'Sales Commission', badge: 'PAYOUT', api: '/api/sales-commission-agent', c1: '#713F12', c2: '#CA8A04', asOfLabel: 'Period to',
      icon: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
      params: [
        { key: 'fromDate', label: 'Period from', type: 'date' },
        { key: 'basis', label: 'Commission basis', type: 'select', options: ['', 'sales', 'collections', 'margin'] },
        { key: 'defaultRatePct', label: 'Default rate %', type: 'number', placeholder: '2' },
        { key: 'minMarginPct', label: 'Min margin % (0 = off)', type: 'number', placeholder: '0' },
        { key: 'useSapRates', label: 'Use SAP employee %', type: 'select', options: ['', 'yes', 'no'] },
        { key: 'salespersonRates', label: 'Sales employee rates', type: 'text', placeholder: 'Devraj=2.5; Zankhana=3' },
        { key: 'customerRules', label: 'Customer rules', type: 'text', placeholder: 'CUS00001=3; CUS00002=0' },
      ],
      chips: ['Summarise commission by sales employee', 'Is anyone earning commission on low-margin sales?', 'Compare sales vs collections basis', 'Which sales have no sales employee?'],
    },
    monthend: {
      title: 'Month-End Closing', badge: 'CLOSE', api: '/api/month-end-agent', c1: '#1E293B', c2: '#475569', asOfLabel: 'Period end', asOfDefault: 'monthEnd',
      icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/>',
      params: [],
      chips: ['What must be done before we can close?', 'How much should we accrue?', 'Give me a close plan by team', 'Which items are critical and why?'],
    },
    salesfollowup: {
      title: 'Sales Follow-up', badge: 'PIPELINE', api: '/api/sales-followup-agent', c1: '#1E3A8A', c2: '#2563EB',
      icon: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
      params: [
        { key: 'quoteStaleDays', label: 'Quote stale after (days)', type: 'number', value: 7 },
        { key: 'activityGapDays', label: 'No-contact gap (days)', type: 'number', value: 7 },
      ],
      chips: ['Who should each salesperson call today?', 'Which quotes are most likely to be lost?', 'Which delayed orders need a customer update?', 'Summarise by salesperson'],
    },
    quoteintel: {
      title: 'Quotation Intelligence', badge: 'PRICING', api: '/api/quotation-intel-agent', c1: '#4C1D95', c2: '#8B5CF6',
      icon: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
      params: [
        { key: 'minMarginPct', label: 'Min. margin %', type: 'number', value: 15 },
        { key: 'targetMarginPct', label: 'Target margin %', type: 'number', value: 25 },
        { key: 'itemCode', label: 'Price check: item code', type: 'text', placeholder: 'blank = all open quotes' },
        { key: 'cardCode', label: 'Customer code', type: 'text', placeholder: 'optional' },
        { key: 'qty', label: 'Qty', type: 'number', placeholder: '1' },
        { key: 'proposedPrice', label: 'Proposed price', type: 'number', placeholder: 'optional' },
        { key: 'competitorPrice', label: 'Competitor price', type: 'number', placeholder: 'optional' },
      ],
      chips: ['Which quote lines leak margin?', 'Which quotes risk losing the deal on price?', 'What price should we quote and why?', 'Summarise pricing vs history'],
    },
    scforecast: {
      title: 'Supply Chain Demand Forecast', badge: 'S&OP', api: '/api/demand-forecast-agent', c1: '#1E3A8A', c2: '#2563EB', manualRun: true, lookups: true,
      icon: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/><line x1="3" y1="21" x2="21" y2="21"/>',
      params: [
        { key: 'item', label: 'Item (chart)', type: 'combo', lookup: 'items', placeholder: 'All items' },
        { key: 'group', label: 'Item group', type: 'select', lookup: 'groups', options: [''], allLabel: 'All groups' },
        { key: 'warehouse', label: 'Warehouse', type: 'combo', lookup: 'warehouses', placeholder: 'All warehouses' },
        { key: 'historyMonths', label: 'History (months)', type: 'number', value: 36 },
        { key: 'horizonMonths', label: 'Horizon (months)', type: 'number', value: 12 },
        { key: 'demandSource', label: 'Actual demand from', type: 'select', value: 'invoices', options: ['invoices', 'orders'] },
        { key: 'safetyMarginPct', label: 'Safety margin %', type: 'number', value: 25, adv: true },
        { key: 'defaultLeadTime', label: 'Default lead time (d)', type: 'number', value: 30, adv: true },
        { key: 'confidence', label: 'Confidence %', type: 'select', value: '95', options: ['80', '90', '95', '99'], adv: true },
        { key: 'excessMonths', label: 'Excess after (months)', type: 'number', value: 6, adv: true },
        { key: 'stalePoDays', label: 'Ignore POs late > (days)', type: 'number', value: 180, adv: true },
        { key: 'arrivalField', label: 'PO target-delivery UDF', type: 'text', placeholder: 'e.g. U_TargetDelDate', adv: true },
        { key: 'depositField', label: 'PO deposit UDF', type: 'text', placeholder: 'e.g. U_DepositDate', adv: true },
      ],
      chips: ['Prepare the S&OP summary for this month', 'Which items will stock out and when?', 'What must we order this week, from whom?', 'Which items are selling faster or slower than plan?', 'Where is the forecast least reliable?'],
    },
    invopt: {
      title: 'Inventory Optimization', badge: 'MIN / MAX', api: '/api/inventory-optimization-agent', c1: '#134E4A', c2: '#0D9488',
      icon: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/>',
      params: [
        { key: 'lookbackDays', label: 'Demand lookback (days)', type: 'number', value: 180 },
        { key: 'serviceLevel', label: 'Service level %', type: 'select', value: '95', options: ['90', '95', '97.5', '99'] },
        { key: 'reviewDays', label: 'Review period (days)', type: 'number', value: 14 },
        { key: 'defaultLeadTime', label: 'Default lead time (days)', type: 'number', value: 14 },
        { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'all' },
      ],
      chips: ['What must we order this week?', 'Where is capital tied up in excess stock?', 'Which Min/Max settings should change first?', 'Explain the safety stock for the top A items'],
    },
    deadstock: {
      title: 'Dead Stock', badge: 'SLOW-MOVING', api: '/api/dead-stock-agent', c1: '#78350F', c2: '#D97706',
      icon: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><line x1="4" y1="11" x2="20" y2="19"/>',
      params: [
        { key: 'slowDays', label: 'Slow after (days)', type: 'number', value: 90 },
        { key: 'deadDays', label: 'Dead after (days)', type: 'number', value: 180 },
        { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'all' },
        { key: 'minValue', label: 'Min. line value', type: 'number', value: 0 },
      ],
      chips: ['What is the disposal plan by value?', 'Which purchases should be frozen now?', 'Which items can be transferred?', 'Which item groups hold the most dead stock?'],
    },
    vendorperf: {
      title: 'Vendor Performance', badge: 'SCORECARD', api: '/api/vendor-performance-agent', c1: '#312E81', c2: '#4F46E5',
      icon: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
      params: [{ key: 'lookbackMonths', label: 'Lookback (months)', type: 'number', value: 12 }],
      chips: ['Who are our best and worst vendors?', 'Where can we save by switching vendors?', 'Which overdue POs should we escalate?', 'Which vendors need an improvement plan?'],
    },
  };

  // ── "About this agent" popups ─────────────────────────────────────────────
  // Shown by the About button / header icon. Written for business users so the
  // functional team can demo each agent: purpose, value, data, dashboard, demo.
  // **bold** is the only markup supported.
  const ABOUT = {
    collections: {
      summary: 'Turns all open customer invoices into a prioritised daily collection worklist. It tells collectors who to chase first, how (email, phone, manager call, credit hold) and why — based on how overdue each customer is, how they have paid in the past and whether they kept their promises to pay.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Get paid faster** — effort goes to the customers and invoices that matter most, not whoever is easiest to call.',
          '**Consistent follow-up** — every customer gets a clear next step, so nothing slips through the cracks.',
          '**Track promises-to-pay** — log a promise and the agent checks later whether it was kept or broken.',
          '**Ready-made reminders** — draft a collection email for a customer in one click.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance** — lower DSO and less money stuck in receivables, which improves cash flow.',
          '**Management** — a clear view of total overdue, over-90-day debt and problem customers.',
          '**Sales** — knows which accounts should not get new orders until they pay.',
          '**Audit / Credit control** — a documented, rule-based collection process.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          'Open **A/R invoices** with due dates and balances.',
          '**Incoming payments** over the last 12 months (payment history) to measure how late each customer usually pays.',
          'Customer master: **credit limit** and current balance.',
          '**Promises-to-pay** logged by your team in this agent.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Total receivables, Overdue amount and %, Over 90 days, DSO (days), Customers overdue, Promises due in 7 days, Broken promises.',
          '**Charts** — receivables aging (current, 1–30, 31–60, 61–90, 90+ days) and top 10 customers by outstanding amount.',
          '**Collection worklist** — one row per overdue customer with priority (HIGH / MEDIUM / LOW), risk score, average days late, on-time %, promise status and the recommended action.',
          '**Overdue invoices** — every overdue invoice with days overdue and aging bucket.',
          '**Row actions** — draft a collection email, log a promise-to-pay, see the score breakdown and payment history.',
          '**AI insight & Ask AI** — summary of who to chase and a call plan on request.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show the **Overdue** and **Over 90 days** tiles — "this is the money we are waiting for".',
          'Show the **aging chart** — how much of it is old and hard to collect.',
          'Open the **Collection worklist** — the HIGH-priority customers at the top and their recommended action.',
          'Click a row to show the **score breakdown** and **draft a collection email**.',
          'Ask AI: "Who should we chase first today?" or "Draft a call plan for this week".',
        ] },
      ],
    },
    cashflow: {
      summary: 'Projects your company\'s cash position week by week for the next 13 weeks (adjustable 4–52), using live SAP Business One documents. It shows how much money will come in, how much will go out, and which weeks the bank balance could run short — early enough to act.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Avoid cash surprises** — spot a shortfall weeks in advance instead of on the day a payment bounces.',
          '**Plan funding early** — decide on overdraft, loan drawdown or fund transfers with time to spare.',
          '**Focus collections** — see exactly which customer invoices would fix a weak week.',
          '**Time payments smartly** — see which vendor bills and purchase orders could be deferred without harm.',
          '**Save hours of Excel work** — the 13-week cash forecast treasury teams usually build by hand is produced in seconds.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance / Treasury** — one realistic view of liquidity for the CFO and banks.',
          '**Management** — confidence before committing to large purchases, capex or dividends.',
          '**Sales & Collections** — clear priority on which receivables matter most this month.',
          '**Purchasing** — visibility of how open POs will hit cash, so orders can be phased.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**Money in:** open A/R invoices + open sales orders.',
          '**Money out:** open A/P invoices + open purchase orders.',
          '**Opening balance:** G/L cash & bank accounts (or a figure you type in).',
          '**Realistic timing:** each customer\'s actual average days-late over the last 12 months shifts their expected payment date; orders use delivery/receipt date + payment terms.',
          '**Realistic amounts:** overdue invoices are discounted by how likely they are to be collected (95% when current, down to 10% over a year late); sales orders are counted at 85%.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Opening balance, total Inflows and Outflows, Net change, Closing balance, Lowest week, number of Shortfall weeks, and A/R at risk (receivables unlikely to be collected).',
          '**Weekly cash flow chart** — green bars = money in, red bars = money out, blue line = projected bank balance. A line dipping below zero is a warning.',
          '**Weekly forecast tab** — each week\'s opening, A/R in, sales orders in, A/P out, POs out, net and closing, with a status: OK, DRAWDOWN (balance falling) or SHORTFALL (balance negative).',
          '**Inflows / Outflows tabs** — every document behind the numbers: partner, document no., expected date, open amount, probability and the reason for its timing.',
          '**AI insight & notes** — a plain-language summary of the outlook, biggest drivers and any data warnings.',
          '**Ask AI** — ask questions like "Which collections would fix the lowest week?" and get answers with document numbers.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Open the agent and point to the **Lowest week** and **Shortfall weeks** tiles — "this is our risk at a glance".',
          'Show the **chart** — where the blue balance line dips and why (big red outflow bars).',
          'Open the **Weekly forecast** tab and find the first DRAWDOWN / SHORTFALL week.',
          'Open **Inflows**, sorted by amount — "these customers, if collected on time, fix that week".',
          'Click **Ask AI** and use a suggested question to get an action plan.',
          'Change **Horizon** (e.g. 26 weeks) or enter an **Opening balance** and click **Analyze** to run a what-if.',
        ] },
      ],
    },
    creditrisk: {
      summary: 'Scores every active customer from 0 to 100 for credit risk (higher = riskier), grades them A to E, and recommends payment terms and a credit limit for each. Scores are saved every day, so you can see which customers are getting better or worse since the last run.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Prevent bad debt** — spot risky customers before more goods are shipped to them.',
          '**Fair, consistent decisions** — every customer is judged on the same rules, not gut feeling.',
          '**Right-size credit limits** — get a suggested limit, higher for good payers and lower for risky ones.',
          '**Early warning** — the Watchlist shows customers whose risk has worsened.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance / Credit control** — a ready risk register for credit-hold and limit reviews.',
          '**Sales** — knows which customers can safely get more credit and which need advance payment.',
          '**Management** — sees how much of total exposure sits with high-risk customers.',
        ] },
        { title: 'How the score is built (SAP Business One data)', items: [
          '**Overdue share** — how much of the balance is past due.',
          '**Oldest overdue invoice** — how old the oldest unpaid invoice is.',
          '**Payment history** — average days late over the last 12 months.',
          '**Credit-limit use** — balance vs credit limit (or months of exposure when no limit is set).',
          '**New orders while overdue** — open sales orders on top of overdue debt.',
          '**Grades:** A = Low risk (eligible for higher limit), B = Moderate, C = Elevated (promise-to-pay before new orders), D = High (credit hold), E = Severe (cash in advance only).',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Active customers, Total exposure, High/severe (D/E) customers and their exposure, Customers that worsened, Open sales orders at D/E customers, Customers with no credit limit, Average risk score.',
          '**Exposure by risk grade chart** — how much money sits in each grade A–E.',
          '**Risk register** — every customer with score, grade, trend (BETTER / WORSE / STABLE / NEW), main risk driver, current vs suggested limit, recommended terms.',
          '**Watchlist** — customers that need attention now (high grade or worsening).',
          '**Score breakdown** — click a row to see exactly why the customer got that score.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Point to **High/severe (D/E)** and **D/E exposure** — "this is the money at risk".',
          'Show the **grade chart** — how exposure is spread across A–E.',
          'Open the **Watchlist** and show customers that **worsened** since the last run.',
          'Click a customer to open the **score breakdown** and the suggested limit.',
          'Ask AI: "Which customers should go on credit hold?"',
        ] },
      ],
    },
    appayment: {
      summary: 'Builds a recommended supplier payment run: which open vendor invoices to pay, when, and how much, within the cash you have available. It pays overdue and critical vendors first, takes early-payment discounts only when they are worth it, and holds back the rest to protect cash. Read-only — nothing is posted to SAP.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Pay the right bills first** — overdue, critical-vendor and soon-due invoices are funded before others.',
          '**Capture valuable discounts** — early-payment discounts are taken only when their annual return beats your cost of money (hurdle rate).',
          '**Protect cash** — each payment is scheduled on the last day that still keeps its benefit.',
          '**What-if planning** — change cash available, reserve or strategy and instantly see a new run.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance / Treasury** — a defensible payment proposal in seconds instead of a manual spreadsheet.',
          '**Purchasing** — key suppliers are kept happy and supply is not put on hold.',
          '**Management** — clear view of what stays unpaid and the risk that creates.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          'Open **A/P invoices** with due dates, balances and discount terms.',
          '**Open purchase orders** — vendors we depend on more are treated as more critical.',
          '**G/L cash & bank balance** as cash available (or a figure you type in).',
          '**Your settings:** reserve to keep, payment window, strategy (balanced / discounts / overdue / preserve cash), hurdle rate, priority vendors, partial payments.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Cash available, Payment budget, Recommended run total, Invoices to pay, Discounts captured, Overdue left unpaid, Unfunded due/overdue, Cash after the run.',
          '**Payment schedule chart** — how much is paid each week and the remaining cash.',
          '**Payment run** — invoices selected, pay-on date, amount and the reason (why).',
          '**Not funded / Overdue / Discounts / By vendor** — what was left out and why, discount value vs hurdle, totals by vendor.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Cash available** vs **Recommended run** — "this is what we can afford this week".',
          'Open **Payment run** and read the **Why** column for a few invoices.',
          'Open **Not funded** — the risk of what stays unpaid.',
          'Change **Strategy** to "preserve" or lower the cash, click **Analyze** — the run adjusts.',
          'Ask AI: "Which early-payment discounts are worth taking?"',
        ] },
      ],
    },
    profitability: {
      summary: 'Shows where the company actually makes and loses money. It calculates revenue, cost and gross profit from sales invoices (net of credit memos) and breaks it down by customer, item, item group, sales employee, warehouse, branch and invoice.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Know your profitable customers and products** — not just the biggest ones.',
          '**Find loss-making sales** — every invoice line sold below cost is listed.',
          '**Fix pricing** — see which items need repricing.',
          '**Compare teams** — gross profit by sales employee, warehouse and branch.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Management** — focus effort on profitable segments and fix or drop the rest.',
          '**Sales** — understand margin, not only turnover, per customer and salesperson.',
          '**Finance** — quick gross-profit analysis without exporting to Excel.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**A/R invoice lines** for the chosen period (revenue after discount, in local currency).',
          '**A/R credit memos** — deducted, so returns and credits are taken into account.',
          '**Cost** — the gross-profit base price or item cost at the time of posting.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Revenue, Cost of sales, Gross profit, Gross margin %, Customers, Invoices, Loss-making invoices, Lines without cost (data-quality check).',
          '**Monthly chart** — revenue and gross profit by month.',
          '**Tabs** — By customer, item, item group, sales employee, warehouse, branch and document, each with revenue, cost, profit, margin % and share of total profit.',
          '**Loss-making lines** — every line sold below cost.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Gross profit** and **Gross margin** — overall health.',
          'Show the **monthly chart** — is margin rising or falling?',
          'Open **By customer**, sort by margin — big customers with low margin stand out.',
          'Open **Loss-making lines** — concrete invoices to investigate.',
          'Ask AI: "Which items should we reprice?"',
        ] },
      ],
    },
    marginleak: {
      summary: 'Finds where margin is being given away on sales invoices and puts a money value on each leak: sales below target margin or below cost, discounts above policy, prices far below normal, and freight not charged to customers. Each line is counted once, so the total is not double-counted.',
      sections: [
        { title: 'Why use this agent', items: [
          '**See hidden profit loss** — leakage is usually spread across many small lines no one checks.',
          '**Enforce pricing policy** — excessive discounts and unusual prices are flagged automatically.',
          '**Recover freight** — find customers normally charged freight who were not charged this time.',
          '**Act on facts** — every leak has a value and a "why".',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Management** — knows how much profit is lost and where, as % of revenue.',
          '**Sales management** — sees which sales employees and customers give away the most.',
          '**Finance / Controls** — evidence to tighten discount approvals and price lists.',
        ] },
        { title: 'Leak types checked (SAP Business One invoices)', items: [
          '**Below target / below cost** — margin under your target margin %.',
          '**Excessive discount** — line + header discount above the allowed %.',
          '**Price anomaly / zero price** — unit price far below the item\'s usual (median) price.',
          '**Freight not charged** — invoice without freight for a customer who is usually charged.',
          '**Inconsistent price** — same customer and item sold at very different prices (for information).',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Revenue, Gross margin, Estimated leakage, Leakage % of revenue, Lines below target, Excessive discounts, Freight unrecovered, Credit memos.',
          '**Leakage by type chart** — which kind of leak costs the most.',
          '**Tabs** — All leaks, Below target, Discounts, Price anomalies, Freight, Inconsistent prices, plus totals by customer and by sales employee.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Estimated leakage** and **Leakage % revenue** — "this is profit we gave away".',
          'Show the **chart** — the biggest leak type.',
          'Open **All leaks**, sorted by value, and read the **Why** column.',
          'Show totals **by sales employee** — where coaching or approval rules are needed.',
          'Ask AI: "Which controls would stop this?"',
        ] },
      ],
    },
    commission: {
      summary: 'Calculates sales-employee commission for a period automatically, on net sales, cash collected, or gross margin. It applies customer-specific and employee-specific rates, claws back commission on credit notes and can exclude low-margin sales.',
      sections: [
        { title: 'Why use this agent', items: [
          '**No more manual commission sheets** — the full calculation runs in seconds.',
          '**Fewer disputes** — every amount traces back to the invoice and the rate that applied.',
          '**Reward the right behaviour** — pay on collections or margin, and exclude loss-making deals.',
          '**Compare bases** — see how payouts change between sales, collections and margin.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**HR / Payroll** — accurate, ready-to-pay commission per employee.',
          '**Sales management** — transparent incentives aligned with company goals.',
          '**Finance** — commission cost under control, with clawbacks applied.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**A/R invoices and credit memos** with their sales employee.',
          '**Incoming payments** (collections basis).',
          '**Gross profit** on invoice lines (margin basis).',
          '**Rates** — in order: customer rule → sales-employee override → SAP sales-employee commission % → default rate. Rules are saved per company.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Commission payable, Basis amount, Effective rate, Sales employees, Clawback (credit memos), Excluded (low margin), Custom rules.',
          '**Commission by sales employee chart.**',
          '**Tabs** — By sales employee, By customer, Detail (every document with rate and rate source), Rules in use.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Commission payable** and the chart by employee.',
          'Open **Detail** — each line shows the rate and where it came from.',
          'Switch **Commission basis** to collections, click **Analyze**, compare.',
          'Add a customer rule (e.g. 0% for a customer) and re-run.',
          'Ask AI: "Is anyone earning commission on low-margin sales?"',
        ] },
      ],
    },
    monthend: {
      summary: 'Runs a month-end close checklist for the selected period and lists every document that blocks a clean close — goods received but not invoiced, deliveries not billed, unapplied payments and credits, back-dated postings, open drafts, negative stock and posting-period status.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Close faster** — all open issues in one place instead of running many SAP reports.',
          '**Accurate books** — know exactly what to accrue (GRNI) and what revenue is unbilled.',
          '**Nothing forgotten** — the same checklist every month.',
          '**Catch control issues** — back-dated postings and negative stock are flagged.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance / Accounts** — a ready close plan by team with values and document numbers.',
          '**Management / Auditors** — confidence that month-end figures are complete.',
          '**Operations** — warehouse and purchasing see the items they must fix.',
        ] },
        { title: 'Checks performed (SAP Business One)', items: [
          '**Goods receipts not A/P invoiced** → accrue (GRNI).',
          '**Deliveries not A/R invoiced** → unbilled revenue.',
          '**Open returns and credit memos** → credits not yet applied.',
          '**Payments on account** → unapplied cash; customers/vendors needing internal reconciliation.',
          '**Back-dated postings**, open drafts in the period, **negative stock**, posting-period status.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Close readiness, Critical checks, GRNI to accrue, Unbilled deliveries, Unapplied receipts, Unapplied credit memos, Back-dated postings, Negative stock lines.',
          '**Pending value by check chart.**',
          '**Close checklist** — each check with status, severity, count, value and action.',
          '**All issues** and one tab per check — the exact documents to fix.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Close readiness** and **Critical checks**.',
          'Open the **Close checklist** — what is OK and what is blocking.',
          'Open **GRNI to accrue** — the accrual amount for the journal entry.',
          'Ask AI: "Give me a close plan by team".',
        ] },
      ],
    },
    salesfollowup: {
      summary: 'Finds open sales quotations, sales orders and opportunities that have gone quiet, expired or slipped past their dates, ranks them by value and urgency, and tells each salesperson who to call. It can create the follow-up activity in SAP or draft the email.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Win more quotes** — no quote is forgotten after it is sent.',
          '**Protect customer relationships** — customers with delayed orders get updated before they complain.',
          '**Daily call list** — each salesperson knows exactly who to contact today.',
          '**One-click actions** — create a follow-up activity in SAP or draft an email.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Sales management** — pipeline discipline and a view of value at stake by salesperson.',
          '**Sales team** — less admin, more selling.',
          '**Customer service** — proactive updates on late deliveries.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**Open sales quotations** — validity date and last update.',
          '**Open sales orders** — delivery date vs today.',
          '**Sales opportunities** — expected close date.',
          '**Activities** — last contact with the customer.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Open quotations, Quotes to chase, Quote value at stake, Expired quotes, Open sales orders, Delayed orders and their value, Opportunities to act.',
          '**Tabs** — Quotations, Sales orders, Opportunities (each with priority, days quiet, value and recommended follow-up) and a summary by salesperson.',
          '**Row actions** — create follow-up in SAP, draft email.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Quote value at stake** — revenue we could lose by not following up.',
          'Open **Quotations** — HIGH priority quotes at the top.',
          'Open **By salesperson** — each person\'s follow-up load.',
          'Use **Create follow-up in SAP** or **Draft email** on one row.',
          'Ask AI: "Who should each salesperson call today?"',
        ] },
      ],
    },
    quoteintel: {
      summary: 'Checks the price on every open quotation line against the item cost, this customer\'s previous prices and what all customers paid in the last 12 months, then recommends a price. It flags lines that lose margin and lines priced too high to win. You can also run a quick price check for any customer and item.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Quote with confidence** — a recommended price backed by cost and real sales history.',
          '**Stop margin leaks before they happen** — catch under-priced quotes before they become orders.',
          '**Win more deals** — spot quotes priced above the market.',
          '**Catch mistakes** — e.g. a price that looks like a unit-of-measure error.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Sales** — faster, consistent pricing decisions.',
          '**Management** — protects margin across all quotes.',
          '**Pricing / Product team** — sees how prices vary across customers.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**Open sales quotation lines** — quoted price, quantity, validity.',
          '**Item cost** — to calculate margin and a minimum-margin floor price.',
          '**A/R invoices (12 months)** — this customer\'s last price and market median / 75th percentile.',
          '**Optional competitor price** you enter.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Open quote lines, Quoted value, Average quoted margin, Flagged lines, Below min margin, Under-priced vs history, Above market, Potential uplift.',
          '**Verdict per line** — OK, BELOW MIN MARGIN, UNDER-PRICED, ABOVE MARKET, CHECK UOM, NEW ITEM or NO DATA, with the reason.',
          '**Tabs** — Quotations (quoted vs recommended price and margin) and Price history.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Flagged lines** and **Potential uplift**.',
          'Open **Quotations** and filter on BELOW MIN MARGIN / UNDER-PRICED.',
          'Run a **price check**: enter an item code and customer, click **Analyze**.',
          'Ask AI: "What price should we quote and why?"',
        ] },
      ],
    },
    scforecast: {
      summary: 'Automates demand and supply planning (S&OP) on live SAP data. It forecasts monthly demand per item using proven statistical models (with trend and seasonality), compares it with stock on hand and open purchase orders, and tells you which items will run out, when, and what to order from whom.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Avoid stock-outs** — see months ahead which items will fall below minimum stock.',
          '**Order the right quantity at the right time** — required orders with an order-by date.',
          '**Replace the planning spreadsheet** — the Excel forecast model runs automatically.',
          '**Track this month live** — month-to-date sales vs plan, FAST or SLOW movers.',
          '**Adjust when needed** — manual forecast overrides always win.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Supply chain / Purchasing** — a clear buying plan by vendor.',
          '**Sales & Operations** — one shared demand number for the monthly S&OP meeting.',
          '**Finance** — less cash tied up in stock and visibility of planned purchase value.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**Actual demand** — monthly invoiced quantity minus credit memos (or sales orders).',
          '**Supply** — open PO quantities by expected arrival month.',
          '**Stock** — on hand and committed per warehouse; lead time and preferred vendor.',
          '**Forecast** — exponential smoothing (like Excel FORECAST.ETS) with accuracy statistics.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Items planned, Demand plan, Next month\'s plan, Open PO supply, Stock-out risk, Below min inventory, Required order value, Forecast accuracy and bias, Month-to-date pace.',
          '**Charts** — actual vs forecast with confidence band, and inventory projection month by month.',
          '**Tabs** — Demand plan, Inventory projection, Required orders (qty, order-by date, vendor), Open PO supply, Live vs plan, Forecast accuracy.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Pick an item and click **Analyze** — show history vs forecast on the chart.',
          'Show **Stock-out risk** and open **Inventory projection**.',
          'Open **Required orders** — what to buy this month and from whom.',
          'Show **Live vs plan** — items selling faster or slower than planned.',
          'Ask AI: "Prepare the S&OP summary for this month".',
        ] },
      ],
    },
    invopt: {
      summary: 'Calculates the right minimum, maximum and safety stock for each item from real demand and lead time, then tells you what to reorder now, where stock-outs are likely, where there is too much stock, and which SAP Min/Max settings should be updated.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Fewer stock-outs** — reorder points are based on actual demand and its variability.',
          '**Less excess stock** — overstock is identified with its value.',
          '**Better SAP settings** — recommended Min/Max replaces guesswork.',
          '**Focus on what matters** — ABC/XYZ classes show high-value and unpredictable items.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Purchasing** — a ready reorder list with suggested quantity and vendor.',
          '**Warehouse / Operations** — balanced stock across items.',
          '**Finance** — working capital released from excess inventory.',
        ] },
        { title: 'How it calculates (SAP Business One data)', items: [
          '**Demand** — weekly net sales from inventory transactions over the lookback period.',
          '**Safety stock** = service-level factor × demand variability × √lead time.',
          '**Reorder point (Min)** = daily demand × lead time + safety stock; **Max** adds the review period.',
          '**Stock** — on hand, committed and on order compared with these levels.',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Items analysed, Stock value, Reorder now, Stock-out risk, Suggested order value, Excess stock value, Min/Max to update, Service level.',
          '**Stock value by status chart.**',
          '**Tabs** — Reorder now, Excess, Min/Max changes (SAP vs recommended), All items.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Reorder now** and **Suggested order value**.',
          'Show **Excess stock value** — cash tied up in stock.',
          'Open **Min/Max changes** — current SAP settings vs recommended.',
          'Change **Service level** to 99% and re-run to show the impact on safety stock.',
          'Ask AI: "What must we order this week?"',
        ] },
      ],
    },
    deadstock: {
      summary: 'Finds stock that is not selling — slow-moving and dead items per warehouse — with its value, and recommends what to do with each: freeze purchasing, transfer to a warehouse where it sells, promote, liquidate or consume in production.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Free up cash** — turn idle stock back into money.',
          '**Stop buying what does not sell** — open POs for dead items are flagged.',
          '**Use stock where it sells** — transfer opportunities between warehouses.',
          '**Clear action per item** — not just a list, but a recommendation.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Finance** — lower inventory value, write-down risk known early.',
          '**Purchasing** — avoids adding to dead stock.',
          '**Sales / Warehouse** — a disposal and promotion plan by value.',
        ] },
        { title: 'Where the data comes from (SAP Business One)', items: [
          '**Stock on hand and value** per item and warehouse.',
          '**Last sale / last use date** and 12-month usage from inventory transactions.',
          '**Sales in other warehouses** and **open purchase orders**.',
          '**Classification** — SLOW and DEAD after the number of days you set (default 90 / 180).',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Stock value, Dead stock, Slow-moving, Dead + slow %, Lines flagged, Transfer opportunities, Freeze purchasing, Liquidation value.',
          '**Chart** — flagged stock value by time since last use.',
          '**Tabs** — Dead & slow (with action), Purchase freeze, Transfers, By item group.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Dead + slow %** of total stock value.',
          'Show the **chart** — how long the stock has been idle.',
          'Open **Purchase freeze** — POs to stop now.',
          'Open **Transfers** — stock that sells in another warehouse.',
          'Ask AI: "What is the disposal plan by value?"',
        ] },
      ],
    },
    vendorperf: {
      summary: 'Scores every vendor from 0 to 100 on delivery (on time, in full), price, quality, shortages, lead-time consistency and payment terms, grades them A to D and recommends what to do: consolidate, maintain, improve or replace. It also shows savings if items were bought from the cheapest vendor.',
      sections: [
        { title: 'Why use this agent', items: [
          '**Objective vendor reviews** — scores based on data, not opinion.',
          '**Reduce supply risk** — find unreliable vendors before they disrupt production or sales.',
          '**Save money** — see where another vendor sells the same item cheaper.',
          '**Chase late deliveries** — every overdue PO line in one list.',
        ] },
        { title: 'How it helps the organisation', items: [
          '**Purchasing** — facts for negotiations and vendor selection.',
          '**Operations** — more reliable supply.',
          '**Management / Quality** — clear view of vendor risk and returns.',
        ] },
        { title: 'How the score is built (SAP Business One data)', items: [
          '**Delivery OTIF (35)** — PO lines received on time and in full.',
          '**Price (20)** — compared with other vendors for the same items.',
          '**Quality (20)** — goods returns and A/P credit notes as % of purchases.',
          '**Shortages (10)**, **Lead-time consistency (10)**, **Payment terms (5)**.',
          '**Grades:** A = Preferred, B = Approved, C = Improvement plan, D = At risk (dual-source or replace).',
        ] },
        { title: 'What you see on the dashboard', items: [
          '**KPI tiles** — Vendors scored, Spend, Average score, OTIF %, At-risk vendors (D), Overdue PO lines, Price-switch savings, Returns & credit notes.',
          '**Spend by vendor grade chart** — how much we buy from good vs weak vendors.',
          '**Tabs** — Scorecard (score, grade, weakest area, recommendation), Price comparison, Overdue PO lines.',
        ] },
        { title: 'Suggested demo flow', ordered: true, items: [
          'Show **Average score**, **OTIF** and **At-risk vendors**.',
          'Show the **chart** — spend sitting with grade C/D vendors.',
          'Open **Scorecard** and click a vendor to see the score breakdown.',
          'Open **Price comparison** — the savings opportunity.',
          'Ask AI: "Which vendors need an improvement plan?"',
        ] },
      ],
    },
  };
  for (const k in ABOUT) if (AGENTS[k]) AGENTS[k].about = ABOUT[k];

  const state = {};           // key → { data, params, tab, sessionId, chat:[], sort, search, page, pageSize, tf, rowChart, lookups }
  let current = null, charts = [], rowChartObj = null;
  const destroyCharts = () => { charts.forEach(c => { try { c.destroy(); } catch {} }); charts = []; };
  const PANEL_ID = 'insight-agent-panel';

  // ── helpers ────────────────────────────────────────────────────────────────
  const tok = () => localStorage.getItem('hanny_token') || '';
  async function call(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': tok() }, body: JSON.stringify(body || {}) });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error(`Server returned ${r.status} (non-JSON). Restart: npm run chat`);
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || r.statusText);
    return d;
  }
  const isFiori = () => document.documentElement.matches('[data-ui="fiori"],.ia-fi');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Markdown with all raw HTML escaped first (DB values can contain anything).
  const md = s => {
    // A leading ">" is markdown (blockquote), not HTML, so it is kept.
    const safe = String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/^(\s*)&gt;/gm, '$1>');
    return typeof marked !== 'undefined' ? marked.parse(safe) : esc(s).replace(/\n/g, '<br>');
  };
  // Formatted per call (not built at load) so they pick up the company locale
  // once refreshAppCurrency() has set window.APP_LOCALE.
  const nfOf = opts => ({ format: v => Number(v).toLocaleString(window.APP_LOCALE || 'en-US', opts) });
  const nf0 = nfOf({ maximumFractionDigits: 0 });
  const nf2 = nfOf({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfN = nfOf({ maximumFractionDigits: 2 });
  // Money always carries the USD sign: -$1,234 / $1,234
  const usd = (nf, v) => `${Number(v) < 0 ? '-' : ''}$${nf.format(Math.abs(Number(v)))}`;
  function fmt(v, f) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return '<span class="ia-muted">—</span>';
    switch (f) {
      case 'amt': return usd(nf0, v);
      case 'price': return usd(nf2, v);
      case 'num': return nfN.format(v);
      case 'int': return nf0.format(Math.round(v));
      case 'pct': return `${nfN.format(Math.round(v * 10) / 10)}%`;
      case 'date': return esc(String(v).slice(0, 10));
      default: return esc(v);
    }
  }
  const TONES = {
    red: ['#FEE2E2', '#991B1B'], amber: ['#FEF3C7', '#92400E'], green: ['#DCFCE7', '#166534'],
    blue: ['#DBEAFE', '#1E40AF'], purple: ['#EDE9FE', '#5B21B6'], grey: ['#F1F5F9', '#475569'],
  };
  const DEFAULT_BADGE = {
    red: ['HIGH', 'CRITICAL', 'E', 'D', 'BROKEN', 'SHORTFALL', 'STOCKOUT RISK', 'DEAD', 'EXPIRED', 'DELAYED', 'BELOW MIN MARGIN', 'CHECK UOM', 'LIQUIDATE', 'FREEZE PURCHASE', '180+', '91-180'],
    amber: ['MEDIUM', 'C', 'DRAWDOWN', 'REORDER', 'SLOW', 'EXPIRING', 'FOLLOW UP', 'UNDER-PRICED', 'ABOVE MARKET', 'PROMOTION', 'ADJUST', 'NOT SET', 'EXCESS', 'OPEN', '61-90', '31-60', 'NO DATA'],
    green: ['OK', 'A', 'KEPT', 'Current', 'BETTER', 'SCHEDULED', 'YES', 'NONE'],
    blue: ['B', 'LOW', 'NEW', 'TRANSFER', 'CONSUME', '1-30', 'RECOMMENDATION', 'NEW ITEM', 'A/R invoice', 'Sales order'],
    purple: ['A/P invoice', 'Purchase order'],
  };
  function badge(v, map) {
    if (v === null || v === undefined || v === '') return '<span class="ia-muted">—</span>';
    let tone = map && map[v];
    if (!tone) tone = Object.keys(DEFAULT_BADGE).find(t => DEFAULT_BADGE[t].includes(String(v))) || 'grey';
    const [bg, fg] = TONES[tone] || TONES.grey;
    return `<span class="ia-badge t-${tone in TONES ? tone : 'grey'}" style="background:${bg};color:${fg}">${esc(v)}</span>`;
  }
  function scoreBar(v, invert) {
    if (v == null) return '<span class="ia-muted">—</span>';
    const good = invert ? 100 - v : v;
    const c = isFiori() ? (good >= 70 ? '#256f3a' : good >= 45 ? '#e76500' : '#aa0808') : good >= 70 ? '#16A34A' : good >= 45 ? '#D97706' : '#DC2626';
    return `<span class="ia-score"><span class="ia-score-track"><span style="width:${Math.max(0, Math.min(100, v))}%;background:${c}"></span></span><b style="color:${c}">${Math.round(v)}</b></span>`;
  }
  function cell(row, col, dense) {
    const v = row[col.key];
    // Dense (wide) tables drop decimals on larger quantities so more columns fit on screen; CSV keeps full precision.
    let html = col.fmt === 'badge' ? badge(v, col.badge) : col.fmt === 'score' ? scoreBar(v, col.invert)
      : dense && col.fmt === 'num' && typeof v === 'number' && Math.abs(v) >= 100 ? nf0.format(Math.round(v)) : fmt(v, col.fmt);
    if (col.strong && v != null) html = `<b>${html}</b>`;
    if (col.sub && row[col.sub] != null && row[col.sub] !== '') {
      const sv = col.fmt === 'badge' && typeof row[col.sub] === 'number' ? (row[col.sub] > 0 ? `+${row[col.sub]}` : row[col.sub]) : row[col.sub];
      html += `<div class="ia-sub" title="${esc(sv)}">${esc(sv)}</div>`;
    }
    return html;
  }
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'ia-toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), bad ? 7000 : 4000);
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('ia-css')) return;
    const s = document.createElement('style');
    s.id = 'ia-css';
    s.textContent = `
#${PANEL_ID}{display:none;flex:1;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#F5F6F7);position:relative;min-width:0}
#${PANEL_ID} .ia-hdr{color:#fff;padding:10px 18px;display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap}
#${PANEL_ID} .ia-hbtn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:4px;padding:5px 11px;font-size:11px;cursor:pointer;white-space:nowrap;font-weight:600}
#${PANEL_ID} .ia-hbtn.primary{background:#fff;color:#111;border-color:#fff}
#${PANEL_ID} .ia-hbtn:disabled{opacity:.6;cursor:wait}
#${PANEL_ID} .ia-body{flex:1;overflow:auto;padding:12px 16px 40px;display:flex;flex-direction:column;gap:12px;min-width:0}
#${PANEL_ID} .ia-params{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:flex-end;background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;padding:10px 12px}
#${PANEL_ID} .ia-fgrid{display:contents}
#${PANEL_ID} .ia-params label{flex:0 1 165px;min-width:135px}
#${PANEL_ID} .ia-params label.wide{flex-basis:280px}
#${PANEL_ID} .ia-params{position:relative;z-index:5}
#${PANEL_ID} .ia-combo{position:relative}
#${PANEL_ID} .ia-params .ia-combo .ia-cb-in{padding-right:26px}
#${PANEL_ID} .ia-cb-tg{position:absolute;right:1px;top:1px;bottom:1px;width:24px;border:0;background:transparent;color:#64748B;font-size:11px;cursor:pointer;padding:0}
#${PANEL_ID} .ia-cb-list{position:absolute;z-index:30;left:0;top:calc(100% + 2px);min-width:100%;width:max-content;max-width:min(460px,90vw);max-height:300px;overflow:auto;background:#fff;border:1px solid #D0D7E3;border-radius:6px;box-shadow:0 6px 18px rgba(15,23,42,.14);padding:4px 0;text-transform:none;letter-spacing:0;font-weight:400}
#${PANEL_ID} .ia-cb-opt{display:flex;gap:10px;padding:5px 10px;font-size:12px;color:var(--text,#32363A);cursor:pointer;white-space:nowrap}
#${PANEL_ID} .ia-cb-opt:hover,#${PANEL_ID} .ia-cb-opt.hi{background:#EFF6FF}
#${PANEL_ID} .ia-cb-opt.cur{font-weight:600}
#${PANEL_ID} .ia-cb-opt.all{color:#64748B;font-style:italic;border-bottom:1px solid #F1F5F9}
#${PANEL_ID} .ia-cb-code{flex:0 0 auto;min-width:80px;font-family:ui-monospace,Consolas,monospace;color:#475569}
#${PANEL_ID} .ia-cb-name{overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .ia-cb-opt b{color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-cb-note{padding:6px 10px;font-size:11px;color:#64748B}
#${PANEL_ID} .ia-params label{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:10px;font-weight:600;color:var(--muted,#6A6D70);text-transform:uppercase;letter-spacing:.03em}
#${PANEL_ID} .ia-params label>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .ia-params label.adv{display:none}#${PANEL_ID} .ia-params.show-adv label.adv{display:flex}
#${PANEL_ID} .ia-params input,#${PANEL_ID} .ia-params select{box-sizing:border-box;width:100%;min-width:0;height:30px;font-size:12px;padding:0 8px;border:1px solid #D0D7E3;border-radius:4px;text-transform:none;font-weight:400;color:var(--text,#32363A);background-color:#fff;text-overflow:ellipsis}
#${PANEL_ID} .ia-params input,#${PANEL_ID} .ia-params select{font-family:inherit}
#${PANEL_ID} .ia-params input[type=date]{padding-right:4px;font-variant-numeric:tabular-nums}
#${PANEL_ID} .ia-params input[type=date]::-webkit-datetime-edit{font-family:inherit;padding:0}
#${PANEL_ID} .ia-params input[type=date]::-webkit-calendar-picker-indicator{cursor:pointer;opacity:.65;margin-left:2px}
#${PANEL_ID} .ia-params input[type=date]::-webkit-calendar-picker-indicator:hover{opacity:1}
#${PANEL_ID} .ia-fbar-act{display:flex;gap:6px;flex-shrink:0;align-items:center}
#${PANEL_ID} .ia-fbtn{height:30px;padding:0 12px;font-size:12px;font-weight:600;border:1px solid #CBD5E1;background:#fff;border-radius:4px;cursor:pointer;white-space:nowrap;color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-fbtn.go{background:var(--ia-c,#0070F2);border-color:var(--ia-c,#0070F2);color:#fff}
#${PANEL_ID} .ia-fbtn:disabled{opacity:.6;cursor:wait}
#${PANEL_ID} .ia-card-t.tog{cursor:pointer;user-select:none;padding-bottom:8px}
#${PANEL_ID} .ia-card-t .ia-chev{margin-left:auto;font-size:11px;color:var(--muted,#6A6D70);font-weight:600;text-transform:none;letter-spacing:0}
#${PANEL_ID} .ia-result{display:flex;flex-direction:column;gap:12px;min-width:0}
#${PANEL_ID} .ia-insight.clip>:not(:first-child),#${PANEL_ID} .ia-insight.clip>:first-child>li:not(:first-child){display:none}
#${PANEL_ID} .ia-insight.clip>:first-child,#${PANEL_ID} .ia-insight.clip>:first-child>li{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .ia-insight.clip *{margin:0}
#${PANEL_ID} .ia-tf{font-size:12px;height:28px;padding:0 6px;border:1px solid #D0D7E3;border-radius:4px;background:#fff;max-width:200px}
#${PANEL_ID} .ia-rowchart{margin:0 12px 10px;border:1px solid var(--border,#E5E5E5);border-radius:6px;background:#FCFDFF}
#${PANEL_ID} .ia-rowchart-h{display:flex;align-items:center;gap:8px;padding:8px 12px 0;font-size:12px;font-weight:700;color:#1F2937}
#${PANEL_ID} .ia-rowchart-h .ia-sub{font-weight:400}
#${PANEL_ID} .ia-rowchart-b{height:260px;padding:6px 12px 10px}
#${PANEL_ID} .ia-tbl tr.sel td{background:#EFF6FF !important}
.ia-modal table.ia-grid{border-collapse:collapse;width:100%;font-size:12px}
.ia-modal table.ia-grid th{text-align:right;font-weight:600;color:#475569;padding:6px 8px;border-bottom:1px solid #E5E7EB;white-space:nowrap}
.ia-modal table.ia-grid th:first-child,.ia-modal table.ia-grid td:first-child{text-align:left}
.ia-modal table.ia-grid td{text-align:right;padding:4px 8px;border-bottom:1px solid #F1F5F9;white-space:nowrap}
.ia-modal table.ia-grid td input{width:110px;text-align:right;padding:4px 6px}
.ia-modal table.ia-grid tr.man td{background:#FFFBEB}
.ia-modal .ia-m-hint{font-size:11px;color:#64748B}
#${PANEL_ID} .ia-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#${PANEL_ID} .ia-kpi{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;padding:9px 12px;border-left:3px solid #94A3B8}
#${PANEL_ID} .ia-kpi.good{border-left-color:#16A34A}#${PANEL_ID} .ia-kpi.bad{border-left-color:#DC2626}#${PANEL_ID} .ia-kpi.warn{border-left-color:#D97706}
#${PANEL_ID} .ia-kpi-l{font-size:9.5px;color:var(--muted,#6A6D70);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
#${PANEL_ID} .ia-kpi-s{display:none}
#${PANEL_ID} .ia-kpi.link{cursor:pointer}#${PANEL_ID} .ia-kpi.link .ia-kpi-l{text-decoration:underline dotted}#${PANEL_ID} .ia-kpi.link:hover{background:#F5FAFF}
#${PANEL_ID} .ia-kpi-v{font-size:19px;font-weight:700;color:var(--text,#32363A);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${PANEL_ID} .ia-card{background:#fff;border:1px solid var(--border,#E5E5E5);border-radius:6px;min-width:0}
#${PANEL_ID} .ia-tbl tr.ia-grp td{background:#F5F7FA;cursor:pointer;font-weight:600;white-space:nowrap}
#${PANEL_ID} .ia-tbl tr.ia-grp:hover td{background:#EBF1F8}
#${PANEL_ID} .ia-tbl tr.ia-gchild td:first-child{padding-left:30px}
#${PANEL_ID} .ia-gchev{display:inline-block;width:16px;color:var(--ia-c,#0064d9)}
#${PANEL_ID} .ia-tbl tr.ia-total td{position:sticky;bottom:0;background:#EEF2F7;font-weight:700;border-top:2px solid var(--border,#D9D9D9);white-space:nowrap}
#${PANEL_ID} .ia-gcount{font-size:11px;font-weight:400;color:var(--muted,#6A6D70);margin-left:6px}
#${PANEL_ID} .ia-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
#${PANEL_ID} .ia-insight{padding:10px 14px;font-size:12.5px;line-height:1.55;color:#1F2937}
#${PANEL_ID} .ia-insight p{margin:0 0 6px}#${PANEL_ID} .ia-insight ul,#${PANEL_ID} .ia-insight ol{margin:4px 0 6px 20px;padding:0}#${PANEL_ID} .ia-insight h1,#${PANEL_ID} .ia-insight h2,#${PANEL_ID} .ia-insight h3{font-size:13px;margin:6px 0 4px}
#${PANEL_ID} .ia-card-t{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#6A6D70);padding:8px 14px 0;display:flex;gap:8px;align-items:center}
#${PANEL_ID} .ia-notes{font-size:11px;color:var(--muted,#6A6D70);margin:0;padding:6px 14px 10px 30px;line-height:1.5}
#${PANEL_ID} .ia-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border,#E5E5E5);overflow-x:auto;padding:0 8px}
#${PANEL_ID} .ia-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 12px;font-size:12px;font-weight:600;color:var(--muted,#6A6D70);cursor:pointer;white-space:nowrap}
#${PANEL_ID} .ia-tab.on{color:var(--ia-c,#0070F2);border-bottom-color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-tools{display:flex;gap:8px;align-items:center;padding:8px 12px;flex-wrap:wrap}
#${PANEL_ID} .ia-tools input{font-size:12px;padding:5px 9px;border:1px solid #D0D7E3;border-radius:4px;width:220px;max-width:100%}
#${PANEL_ID} .ia-tbl-wrap{overflow:auto;max-height:calc(100vh - 210px);min-height:240px}
#${PANEL_ID} table.ia-tbl{border-collapse:collapse;width:100%;font-size:12px}
#${PANEL_ID} .ia-tbl th{position:sticky;top:0;background:#F8FAFC;z-index:1;text-align:left;padding:7px 10px;font-weight:600;color:#475569;border-bottom:1px solid var(--border,#E5E5E5);cursor:pointer;white-space:nowrap;user-select:none}
#${PANEL_ID} .ia-tbl th.num,#${PANEL_ID} .ia-tbl td.num{text-align:right}
#${PANEL_ID} .ia-tbl td{padding:7px 10px;border-bottom:1px solid #F1F5F9;white-space:nowrap;vertical-align:top}
#${PANEL_ID} .ia-tbl td.wrap{white-space:normal;min-width:220px;max-width:380px}
#${PANEL_ID} .ia-tbl tr:hover td{background:#FAFBFF}
#${PANEL_ID} .ia-sub{font-size:10px;color:var(--muted,#6A6D70);margin-top:1px}
/* dense: wide tables (many month columns) — tighter cells, wrapped headers, sticky first column, truncated names */
#${PANEL_ID} .ia-tbl.dense th{white-space:normal;vertical-align:bottom;line-height:1.2;min-width:48px}
#${PANEL_ID} .ia-tbl.dense th,#${PANEL_ID} .ia-tbl.dense td{padding:6px 6px}
#${PANEL_ID} .ia-tbl.dense th:first-child,#${PANEL_ID} .ia-tbl.dense td:first-child{position:sticky;left:0;background:#fff;z-index:1;box-shadow:1px 0 0 #E5E7EB}
#${PANEL_ID} .ia-tbl.dense th:first-child{z-index:2;background:#F8FAFC}
#${PANEL_ID} .ia-tbl.dense .ia-sub{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .ia-tbl.dense .ia-act{padding:2px 6px;margin-right:2px}
#${PANEL_ID} .ia-muted{color:#CBD5E1}
#${PANEL_ID} .ia-badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap}
#${PANEL_ID} .ia-score{display:inline-flex;align-items:center;gap:6px}
#${PANEL_ID} .ia-score-click{cursor:pointer;border-radius:4px;padding:2px 4px;margin:-2px -4px}
#${PANEL_ID} .ia-score-click:hover{background:#EEF2FF}
#${PANEL_ID} .ia-score-click{text-decoration:underline dotted #94A3B8;text-underline-offset:3px}
#${PANEL_ID} th.ia-th-help{text-decoration:underline dotted #94A3B8;text-underline-offset:3px}
#${PANEL_ID} .ia-tabdesc{padding:0 12px 8px;font-size:12px;color:var(--muted,#6A6D70)}
#${PANEL_ID} .ia-chartdesc{padding:0 12px;font-size:11.5px;color:var(--muted,#6A6D70)}
#${PANEL_ID} .ia-score-click:hover b{text-decoration:underline}
#${PANEL_ID} .ia-score-track{width:46px;height:5px;background:#E5E7EB;border-radius:3px;display:inline-block;overflow:hidden}
#${PANEL_ID} .ia-score-track span{display:block;height:100%}
#${PANEL_ID} .ia-act{font-size:10.5px;padding:3px 8px;border:1px solid #CBD5E1;background:#fff;border-radius:4px;cursor:pointer;margin-right:4px;white-space:nowrap}
#${PANEL_ID} .ia-act:hover{border-color:var(--ia-c,#0070F2);color:var(--ia-c,#0070F2)}
#${PANEL_ID} .ia-pager{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--border,#E5E5E5);font-size:11px;color:var(--muted,#6A6D70)}
#${PANEL_ID} .ia-pager label{display:flex;align-items:center;gap:6px}
#${PANEL_ID} .ia-pager select{font-size:11px;padding:2px 4px;border:1px solid #D0D7E3;border-radius:4px;background:#fff}
#${PANEL_ID} .ia-pg-nav{display:flex;align-items:center;gap:2px;margin-left:auto;flex-wrap:wrap}
#${PANEL_ID} .ia-pg{min-width:26px;margin-right:0;text-align:center}
#${PANEL_ID} .ia-pg.on{background:var(--ia-c,#0070F2);border-color:var(--ia-c,#0070F2);color:#fff}
#${PANEL_ID} .ia-pg:disabled{opacity:.4;cursor:default;pointer-events:none}
#${PANEL_ID} .ia-pg-gap{padding:0 4px}
#${PANEL_ID} .ia-empty{padding:40px 16px;text-align:center;color:var(--muted,#6A6D70);font-size:13px}
#${PANEL_ID} .ia-chat{position:absolute;top:0;right:0;bottom:0;width:380px;max-width:100%;background:#fff;box-shadow:-6px 0 24px rgba(0,0,0,.12);display:none;flex-direction:column;z-index:20}
#${PANEL_ID} .ia-chat.open{display:flex}
#${PANEL_ID} .ia-chat-msgs{flex:1;min-height:0;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:9px;background:#F8F9FB}
#${PANEL_ID} .ia-msg{border-radius:10px;padding:8px 12px;font-size:12px;line-height:1.5;max-width:92%;min-width:0;overflow-x:auto;overflow-wrap:anywhere;flex-shrink:0}
#${PANEL_ID} .ia-msg.a>:first-child{margin-top:0}#${PANEL_ID} .ia-msg.a>:last-child{margin-bottom:0}
#${PANEL_ID} .ia-msg p{margin:0 0 8px}
#${PANEL_ID} .ia-msg :is(h1,h2,h3,h4,h5){font-size:1.07em;font-weight:700;line-height:1.35;margin:12px 0 4px}
#${PANEL_ID} .ia-msg :is(ul,ol){margin:4px 0 8px;padding-left:20px}#${PANEL_ID} .ia-msg li{margin:2px 0}
#${PANEL_ID} .ia-msg pre{white-space:pre-wrap;background:#F5F6F7;border-radius:6px;padding:8px 10px;margin:6px 0;font-size:.9em}
#${PANEL_ID} .ia-msg code{font-size:.9em;background:#F1F5F9;border-radius:4px;padding:1px 4px}#${PANEL_ID} .ia-msg pre code{background:none;padding:0}
#${PANEL_ID} .ia-msg hr{border:0;border-top:1px solid #E5E7EB;margin:10px 0}
#${PANEL_ID} .ia-msg blockquote{margin:6px 0;padding-left:10px;border-left:3px solid #D9D9D9;color:#556B82}
#${PANEL_ID} .ia-msg table{display:block;max-width:100%;overflow-x:auto;margin:6px 0}#${PANEL_ID} .ia-msg th{background:#F8FAFC;text-align:left}
#${PANEL_ID} .ia-typing{display:flex;gap:5px;align-items:center;padding:12px 14px}
#${PANEL_ID} .ia-typing i{width:7px;height:7px;border-radius:50%;background:#94A3B8;animation:ia-dot 1.2s infinite ease-in-out}
#${PANEL_ID} .ia-typing i:nth-child(2){animation-delay:.15s}#${PANEL_ID} .ia-typing i:nth-child(3){animation-delay:.3s}
@keyframes ia-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
#${PANEL_ID} .ia-msg.u{align-self:flex-end;color:#fff;white-space:pre-wrap}
#${PANEL_ID} .ia-msg.a{align-self:flex-start;background:#fff;border:1px solid #E8EDF3}
#${PANEL_ID} .ia-msg table{border-collapse:collapse;font-size:11px}#${PANEL_ID} .ia-msg td,#${PANEL_ID} .ia-msg th{border:1px solid #E5E7EB;padding:3px 6px}
#${PANEL_ID} .ia-chips{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-top:1px solid #EEF1F5;flex-shrink:0}
#${PANEL_ID} .ia-chat:not(.started) .ia-chips::before{content:'Suggested questions';font-size:11px;font-weight:600;color:#6A6D70}
#${PANEL_ID} .ia-chip{display:block;width:100%;text-align:left;font:inherit;font-size:12px;line-height:1.35;padding:7px 12px;border:1px solid #CBD5E1;border-radius:8px;background:#fff;color:inherit;cursor:pointer;white-space:normal}
#${PANEL_ID} .ia-chip:disabled,#${PANEL_ID} .ia-chat-in button:disabled{opacity:.55;cursor:default}
#${PANEL_ID} .ia-chat-in input:disabled{background:#F5F6F7}
#${PANEL_ID} .ia-chat.started .ia-chips{flex-direction:row;flex-wrap:nowrap;overflow-x:auto;padding:8px 12px}
#${PANEL_ID} .ia-chat.started .ia-chip{width:auto;flex:0 0 auto;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:14px;padding:5px 12px}
#${PANEL_ID} .ia-chat-in{display:flex;gap:6px;padding:10px;border-top:1px solid #EEF1F5}
#${PANEL_ID} .ia-chat-in input{flex:1;font-size:12px;padding:8px 12px;border:1px solid #D0D7E3;border-radius:18px;outline:none}
.ia-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px}
.ia-modal{background:#fff;border-radius:8px;width:620px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.ia-modal h3{margin:0;padding:12px 16px;font-size:14px;border-bottom:1px solid #E5E7EB}
.ia-modal .ia-m-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.ia-modal textarea{width:100%;min-height:300px;font:12px/1.5 ui-monospace,Consolas,monospace;padding:10px;border:1px solid #D0D7E3;border-radius:4px;box-sizing:border-box}
.ia-modal label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:600;color:#475569}
.ia-modal input{font-size:13px;padding:6px 9px;border:1px solid #D0D7E3;border-radius:4px}
.ia-modal .ia-m-foot{display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid #E5E7EB}
.ia-modal button{font-size:12px;padding:6px 14px;border-radius:4px;border:1px solid #CBD5E1;background:#fff;cursor:pointer}
.ia-modal button.primary{background:#0070F2;border-color:#0070F2;color:#fff}
.ia-modal.ia-kd{width:980px}
.ia-kd .ia-kd-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.ia-kd .ia-kd-val{font-size:28px;font-weight:700;color:#1d2d3e}.ia-kd .ia-kd-val.bad{color:#aa0808}.ia-kd .ia-kd-val.warn{color:#e76500}.ia-kd .ia-kd-val.good{color:#256f3a}
.ia-kd .ia-kd-tabs{display:flex;gap:4px;border-bottom:1px solid #E5E7EB}
.ia-modal.ia-kd button.ia-kd-tab{height:auto;border:none;border-bottom:2px solid transparent;border-radius:0;background:none;padding:8px 12px;color:#475569;font-weight:600}
.ia-modal.ia-kd button.ia-kd-tab.on{border-bottom-color:#0070F2;color:#0070F2}
.ia-kd .ia-kd-body{display:flex;flex-direction:column;gap:12px;min-height:260px}
.ia-kd .ia-kd-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.ia-kd .ia-kd-stat{border:1px solid #E5E7EB;border-radius:8px;padding:8px 10px}
.ia-kd .ia-kd-stat .l{font-size:11px;color:#64748B}.ia-kd .ia-kd-stat .v{font-size:17px;font-weight:700;margin-top:2px;white-space:nowrap}
.ia-kd .ia-kd-box{border:1px solid #E5E7EB;border-radius:8px;padding:10px 12px}
.ia-kd .ia-kd-h{font-size:12px;font-weight:700;color:#334155;margin-bottom:6px}
.ia-kd .ia-kd-formula{font:13px/1.5 ui-monospace,Consolas,monospace;background:#F8FAFC;border-radius:6px;padding:8px 10px}
.ia-kd .ia-kd-list{margin:0;padding-left:20px;font-size:12.5px;line-height:1.6}
.ia-kd .ia-kd-ai{background:linear-gradient(135deg,#F5F3FF,#EFF6FF);font-size:13px}
@media (max-width:640px){.ia-kd .ia-kd-stats{grid-template-columns:repeat(2,1fr)}}
.ia-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1F2937;color:#fff;padding:10px 18px;border-radius:6px;font-size:12.5px;z-index:2100;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:90vw}
.ia-toast.bad{background:#991B1B}
@keyframes ia-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){#${PANEL_ID} .ia-body{padding:10px 12px 40px}#${PANEL_ID} .ia-params label,#${PANEL_ID} .ia-params label.wide{flex:1 1 calc(50% - 6px);min-width:0}#${PANEL_ID} .ia-fbar-act{flex:1 1 100%;justify-content:flex-end}#${PANEL_ID} .ia-hdr{padding:10px 12px}}

/* ── Fiori theme (S/4HANA Horizon controls) — html:is([data-ui="fiori"],.ia-fi) only ── */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID}{background:#f5f6f7}
/* Object Page title: white header, agent colour kept as the icon tile */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hdr{background:#fff !important;color:#1d2d3e;padding:12px 24px;min-height:64px;border-bottom:1px solid #e5e5e5;box-shadow:0 2px 4px rgba(34,53,72,.06);gap:12px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-ico{width:36px;height:36px;border-radius:10px;background:#ebf8ff;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-ico svg{width:18px;height:18px;stroke:#0070f2}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hdr .ia-title{font-size:20px !important;font-weight:700 !important;letter-spacing:-.01em;color:#1d2d3e}
/* sap.m.ObjectStatus (Information) */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tagb{background:#e5f0fa !important;color:#0064d9 !important;border-radius:6px !important;padding:2px 8px !important;font-size:11px !important;letter-spacing:.02em}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-status{color:#556b82 !important;font-size:12px !important}
/* sap.m.Button: Default / Transparent / Emphasized */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn{background:#fff;border:1px solid #bcc3ca;color:#0064d9;border-radius:8px;height:36px;padding:0 14px;font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn:hover{background:#eaecee;border-color:#bcc3ca}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn[data-a="back"]{border-color:transparent;background:transparent}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn[data-a="back"]:hover{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn.primary{background:#0070f2;border-color:#0070f2;color:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn.primary:hover{background:#0064d9;border-color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-body{padding:16px 24px 48px;gap:16px}
/* sap.f.Card */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-card{background:#fff;border:none;border-radius:12px;box-shadow:0 0 2px rgba(34,53,72,.15),0 2px 4px rgba(34,53,72,.15)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params{padding:12px 16px;gap:12px 14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params label{flex-basis:170px}html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params label.wide{flex-basis:250px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-fbtn{height:32px;border-radius:8px;font-size:13px;border-color:#bcc3ca;color:#0064d9;padding:0 14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-fbtn:hover{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-fbtn.go{background:#0070f2;border-color:#0070f2;color:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-fbtn.go:hover{background:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-card-t.tog:hover{background:#f5f6f7;border-radius:12px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-card-t .ia-chev{color:#0064d9;font-size:13px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tf{height:32px;font-size:13px;border:1px solid #bcc3ca;border-bottom-color:#556b82;border-radius:8px;padding:0 8px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-rowchart{border-radius:12px;border-color:#e5e5e5;background:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-rowchart-h{font-size:14px;color:#1d2d3e;padding:12px 16px 0}
/* sap.m.Label + sap.m.Input */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params label{font-size:12px;font-weight:400;color:#556b82;text-transform:none;letter-spacing:0;gap:4px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params select,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tools input{height:32px;font-size:13px;padding:0 8px;border:1px solid #bcc3ca;border-bottom-color:#556b82;border-radius:8px;color:#1d2d3e;background-color:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input:hover,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params select:hover,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tools input:hover{background-color:#f5f6f7}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input:focus,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params select:focus,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tools input:focus{outline:2px solid #0032a5;outline-offset:-1px}
/* sap.m.NumericContent tiles: semantic value colour instead of a stripe */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpis{gap:8px;grid-template-columns:repeat(auto-fill,minmax(184px,1fr))}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi{border-left:none;border-radius:12px;padding:12px 14px;min-width:0;box-shadow:0 0 2px 0 rgba(34,53,72,.15),0 2px 4px 0 rgba(34,53,72,.15);transition:box-shadow .2s}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi:hover{box-shadow:0 0 2px 0 rgba(34,53,72,.15),0 8px 16px 0 rgba(34,53,72,.15)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi-l{font-size:12px;font-weight:400;color:#556b82;text-transform:none;letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi-v{font-size:22px;font-weight:400;color:#1d2d3e;margin-top:4px;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi-s{display:block;margin-top:4px;font-size:11px;color:#758ca4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi.good .ia-kpi-v{color:#256f3a}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi.bad .ia-kpi-v{color:#aa0808}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-kpi.warn .ia-kpi-v{color:#e76500}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-card-t{font-size:16px;font-weight:700;text-transform:none;letter-spacing:0;color:#1d2d3e;padding:14px 16px 4px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-insight{padding:8px 16px 14px;font-size:14px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-result{gap:16px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-charts{gap:16px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-insight.clip{padding:4px 16px 14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-notes{color:#556b82;font-size:12px}
/* sap.m.IconTabBar */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tabs{border-bottom:1px solid #e5e5e5;padding:0 12px;gap:4px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tab{font-size:14px;font-weight:400;color:#1d2d3e;padding:12px 12px;border-bottom:3px solid transparent;border-radius:0}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tab:hover{color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tab.on{color:#0064d9;font-weight:700;border-bottom-color:#0070f2}
/* sap.ui.table / sap.m.Table */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} table.ia-tbl{font-size:14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl th{background:#fff;color:#556b82;font-weight:600;font-size:13px;padding:10px 12px;border-bottom:1px solid #e5e5e5}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl th:hover{background:#f5f6f7}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl td{padding:10px 12px;border-bottom:1px solid #e5e5e5;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr:hover td{background:#f5f6f7}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-sub{color:#556b82;font-size:12px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} table.ia-tbl.dense{font-size:12.5px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl.dense th{font-size:12px;padding:8px 6px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl.dense td{padding:7px 6px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl.dense th:first-child{background:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl.dense .ia-sub{font-size:11px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl.dense .ia-act{height:24px;padding:0 7px;font-size:11px}
/* sap.m.ObjectStatus inside tables */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge{border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-score-track{height:6px;border-radius:3px;background:#e5e5e5}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-act{height:28px;padding:0 10px;font-size:12px;font-weight:600;border:1px solid #bcc3ca;border-radius:8px;color:#0064d9;background:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-act:hover{background:#eaecee;border-color:#bcc3ca;color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-empty{color:#556b82;font-size:14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pager{font-size:13px;color:#556b82;border-top-color:#e5e5e5;padding:10px 16px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pager select{height:28px;font-size:13px;border:1px solid #bcc3ca;border-radius:8px;padding:0 6px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pg{min-width:30px;padding:0 8px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pg.on{background:#0070f2;border-color:#0070f2;color:#fff}
/* Side panel (AI chat) */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat{width:400px;box-shadow:0 0 2px rgba(34,53,72,.2),-12px 0 32px rgba(34,53,72,.18)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr{background:#fff !important;color:#1d2d3e;border-bottom:1px solid #e5e5e5;min-height:56px;box-shadow:none}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr .ia-title{font-size:16px !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr{flex-wrap:nowrap}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr .ia-title{white-space:nowrap}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr .ia-title + span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#556b82;opacity:1 !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr .ia-hbtn{height:32px;padding:0 10px;border-color:transparent;background:transparent;flex-shrink:0}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-hdr .ia-hbtn:hover{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-msgs{background:#f5f6f7;padding:16px;gap:10px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg{border-radius:12px;font-size:14px;padding:10px 14px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg.u{background:#0070f2 !important;border-bottom-right-radius:4px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg.a{border:none;box-shadow:0 0 2px rgba(34,53,72,.15),0 1px 2px rgba(34,53,72,.1);border-bottom-left-radius:4px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chips{border-top:1px solid #e5e5e5;padding:12px 16px;gap:8px;background:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat:not(.started) .ia-chips::before{font-size:12px;font-weight:400;color:#556b82}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chip{min-height:36px;padding:8px 12px;border:1px solid #d9d9d9;border-radius:8px;font-size:13px;line-height:1.4;color:#1d2d3e;background:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chip:hover:not(:disabled){background:#ebf8ff;border-color:#0070f2;color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat.started .ia-chips{padding:8px 16px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat.started .ia-chip{min-height:0;height:28px;line-height:26px;padding:0 12px;border-radius:14px;font-size:12px;border-color:#bcc3ca}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg :is(h1,h2,h3,h4,h5){font-size:15px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg pre{background:#f5f6f7}html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg code{background:#eff1f2}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg th{background:#f5f6f7;color:#556b82;font-weight:600}html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg :is(td,th){border-color:#e5e5e5;padding:4px 8px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-typing i{background:#0070f2}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-in{border-top:1px solid #e5e5e5;padding:12px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-in input{height:36px;font-size:14px;border:1px solid #bcc3ca;border-bottom-color:#556b82;border-radius:18px;padding:0 16px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-in input:focus{outline:2px solid #0032a5;outline-offset:-1px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-chat-in input:disabled{background:#f5f6f7}
/* sap.m.Dialog + sap.m.MessageToast */
html:is([data-ui="fiori"],.ia-fi) .ia-modal{border-radius:16px;box-shadow:0 0 2px rgba(34,53,72,.2),0 12px 40px rgba(34,53,72,.3)}
html:is([data-ui="fiori"],.ia-fi) .ia-modal h3{font-size:16px;padding:16px 20px;border-bottom:1px solid #e5e5e5;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) .ia-modal .ia-m-foot{padding:12px 20px;border-top:1px solid #e5e5e5}
html:is([data-ui="fiori"],.ia-fi) .ia-modal button{height:36px;padding:0 16px;font-size:14px;font-weight:600;border:1px solid #bcc3ca;border-radius:8px;color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) .ia-modal button.primary{background:#0070f2;border-color:#0070f2;color:#fff}
html:is([data-ui="fiori"],.ia-fi) .ia-modal input,html:is([data-ui="fiori"],.ia-fi) .ia-modal textarea{border:1px solid #bcc3ca;border-radius:8px}
html:is([data-ui="fiori"],.ia-fi) .ia-toast{background:#1d2d3e;border-radius:8px;font-size:14px}
html:is([data-ui="fiori"],.ia-fi) .ia-toast.bad{background:#aa0808}
/* ── Fiori: font, remaining controls (ComboBox, Select, DatePicker, ObjectStatus, Table rows, scrollbars) ── */
@font-face{font-family:'72fiori';font-weight:400;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content/content/Base/baseLib/baseTheme/fonts/72-Regular.woff2') format('woff2')}
@font-face{font-family:'72fiori';font-weight:600;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content/content/Base/baseLib/baseTheme/fonts/72-Semibold.woff2') format('woff2')}
@font-face{font-family:'72fiori';font-weight:700;font-display:swap;src:url('https://cdn.jsdelivr.net/npm/@sap-theming/theming-base-content/content/Base/baseLib/baseTheme/fonts/72-Bold.woff2') format('woff2')}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID},html:is([data-ui="fiori"],.ia-fi) .ia-modal,html:is([data-ui="fiori"],.ia-fi) .ia-toast{font-family:'72fiori','72','Segoe UI',system-ui,-apple-system,sans-serif;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) .ia-toast{color:#fff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} :is(button,input,select,textarea),html:is([data-ui="fiori"],.ia-fi) .ia-modal :is(button,input,select,textarea){font-family:inherit}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} :is(button,[data-sb],.ia-tab):focus-visible,html:is([data-ui="fiori"],.ia-fi) .ia-modal button:focus-visible{outline:2px solid #0032a5;outline-offset:1px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} input::placeholder{color:#556b82;opacity:1}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hbtn svg{width:16px;height:16px;flex-shrink:0}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-muted{color:#a9b4be}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-insight a,html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-msg a{color:#0064d9}
/* sap.m.Select: flat field with chevron */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} :is(.ia-params select,.ia-tf,.ia-pager select){-webkit-appearance:none;appearance:none;padding-right:30px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23556b82' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;background-size:12px}
/* sap.m.DatePicker */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input[type=date]{padding-right:6px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input[type=date]::-webkit-calendar-picker-indicator{opacity:1;padding:4px;border-radius:6px;cursor:pointer;filter:invert(27%) sepia(85%) saturate(2400%) hue-rotate(205deg) brightness(92%)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params input[type=date]::-webkit-calendar-picker-indicator:hover{background-color:#eaecee}
/* sap.m.ComboBox (two columns: text + additional text) */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-params .ia-combo .ia-cb-in{padding-right:36px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-tg{right:4px;top:4px;bottom:4px;width:28px;border-radius:6px;font-size:0;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%23556b82' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/12px no-repeat}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-tg:hover{background-color:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-list{top:calc(100% + 4px);border:none;border-radius:8px;box-shadow:0 0 2px rgba(34,53,72,.2),0 8px 16px rgba(34,53,72,.2);padding:4px 0;max-height:360px;max-width:min(520px,92vw);min-width:max(100%,320px)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt{min-height:36px;align-items:center;padding:0 16px;gap:24px;font-size:14px;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt:hover{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt.hi{background:#eaecee;outline:2px solid #0032a5;outline-offset:-3px;border-radius:6px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt.cur{background:#ebf8ff;font-weight:400;box-shadow:inset 3px 0 0 #0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt.all{font-style:normal;color:#556b82;border-bottom:1px solid #e5e5e5}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-name{order:1;flex:1 1 auto}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-code{order:2;min-width:0;margin-left:auto;font-family:inherit;font-size:13px;color:#556b82;text-align:right}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-opt b{color:inherit;font-weight:700}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-cb-note{padding:8px 16px;font-size:12px;color:#556b82}
/* sap.m.ObjectStatus (inverted) */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-red{background:#ffeaf4 !important;color:#aa0808 !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-amber{background:#fff8d6 !important;color:#b44f00 !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-green{background:#f5fae5 !important;color:#256f3a !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-blue{background:#e1f4ff !important;color:#0064d9 !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-purple{background:#f2e3ff !important;color:#7800a4 !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-badge.t-grey{background:#eff1f2 !important;color:#5b738b !important}
/* sap.m.Table: group headers, totals, selection, search field, paginator */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr.ia-grp td{background:#f5f6f7;color:#1d2d3e}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr.ia-grp:hover td{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-gchev{color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-gcount{color:#556b82}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr.ia-total td{background:#fff;color:#1d2d3e;border-top:2px solid #d9d9d9;box-shadow:0 -2px 4px rgba(34,53,72,.06)}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr.sel td{background:#ebf8ff !important}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tbl tr.sel td:first-child{box-shadow:inset 3px 0 0 #0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-score-click:hover{background:#ebf8ff}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-tools input{width:260px;padding-left:32px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23556b82' stroke-width='2.2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E") no-repeat 10px center}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pg{height:28px;border-radius:8px;border-color:transparent;background:transparent;color:#0064d9}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-pg:hover{background:#eaecee}
/* sap.m.Dialog */
html:is([data-ui="fiori"],.ia-fi) .ia-modal-bg{background:rgba(0,0,0,.4)}
html:is([data-ui="fiori"],.ia-fi) .ia-modal label{font-size:12px;font-weight:400;color:#556b82}
html:is([data-ui="fiori"],.ia-fi) .ia-modal input{height:32px;font-size:13px;border-bottom-color:#556b82}
html:is([data-ui="fiori"],.ia-fi) .ia-modal :is(input,textarea):focus{outline:2px solid #0032a5;outline-offset:-1px}
html:is([data-ui="fiori"],.ia-fi) .ia-modal button:hover{background:#eaecee}
html:is([data-ui="fiori"],.ia-fi) .ia-modal button.primary:hover{background:#0064d9}
/* Horizon scrollbars */
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} *{scrollbar-width:thin;scrollbar-color:#7b91a8 transparent}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} ::-webkit-scrollbar{width:8px;height:8px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} ::-webkit-scrollbar-thumb{background:#7b91a8;border-radius:4px}
html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} ::-webkit-scrollbar-track{background:transparent}
@media (max-width:640px){html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hdr{padding:10px 12px}html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-body{padding:12px 12px 40px}html:is([data-ui="fiori"],.ia-fi) #${PANEL_ID} .ia-hdr .ia-title{font-size:16px !important}}
`;
    document.head.appendChild(s);
  }

  // ── panel shell ────────────────────────────────────────────────────────────
  function ensurePanel() {
    injectCss();
    let p = document.getElementById(PANEL_ID);
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      p.innerHTML = `<div class="ia-hdr"></div><div class="ia-body"></div>
        <div class="ia-chat"><div class="ia-chat-hdr ia-hdr" style="padding:10px 14px"></div><div class="ia-chat-msgs"></div><div class="ia-chips"></div>
        <div class="ia-chat-in"><input type="text" placeholder="Ask about this analysis…"><button class="ia-hbtn primary" style="border-radius:18px">Send</button></div></div>`;
      const inp = p.querySelector('.ia-chat-in input');
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
      p.querySelector('.ia-chat-in button').addEventListener('click', () => sendChat());
    }
    const main = document.querySelector('.main');
    if (main && p.parentElement !== main) main.appendChild(p);
    return p;
  }

  function hideOthers() {
    const main = document.querySelector('.main');
    if (main) {
      for (const el of main.children) {
        if (el.id === PANEL_ID) continue;
        if (el.id === 'messages' || /-panel$/.test(el.id || '')) el.style.display = 'none';
      }
    }
    const bb = document.querySelector('.bottom-bar'), ia = document.querySelector('.input-area');
    if (bb) bb.style.display = 'none';
    if (ia) ia.style.display = 'none';
  }

  function paramValues(key) {
    const st = state[key];
    const out = {};
    const ps = AGENTS[key].params;
    for (const f of ps.some(f => f.key === 'asOf') ? ps : ps.concat([{ key: 'asOf' }])) {
      const v = st.params[f.key];
      if (v === '' || v === undefined || v === null) continue;
      // A name picked from a showName list is sent as its code; typed free text goes as-is.
      const picked = f.showName ? nameChoices(f, st).find(o => o.text === v) : null;
      out[f.key] = f.type === 'number' ? Number(v) : picked ? picked.code : v;
    }
    return out;
  }

  function renderShell(key) {
    const a = AGENTS[key], st = state[key], p = ensurePanel();
    // fiori: true agents always use the S/4HANA Horizon look, whatever the app theme.
    document.documentElement.classList.toggle('ia-fi', !!a.fiori);
    p.style.setProperty('--ia-c', isFiori() ? '#0070f2' : a.c2);
    const hdr = p.querySelector('.ia-hdr');
    hdr.style.background = `linear-gradient(135deg,${a.c1} 0%,${a.c2} 100%)`;
    hdr.innerHTML = `
      <button class="ia-hbtn" data-a="back">${isFiori() ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Back' : '&larr; Back'}</button>
      <span class="ia-ico"${a.about ? ' data-a="about" title="About this agent" style="cursor:pointer"' : ''}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2">${a.icon}</svg></span>
      <span class="ia-title" style="font-size:14px;font-weight:700">${esc(a.title)} Agent</span>
      <span class="ia-tagb" style="font-size:10px;background:rgba(0,0,0,.25);padding:2px 7px;border-radius:8px;font-weight:700">${esc(a.badge)}</span>
      <div style="display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap">
        <span class="ia-status" style="font-size:10.5px;color:rgba(255,255,255,.8)"></span>
        ${a.about ? `<button class="ia-hbtn" data-a="about" title="What this agent does and how to read it">${isFiori() ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' : 'ⓘ '}About</button>` : ''}
        <button class="ia-hbtn" data-a="chat">${isFiori() ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' : '💬 '}Ask AI</button>
        <button class="ia-hbtn primary" data-a="run">Analyze</button>
      </div>`;
    hdr.querySelector('[data-a=back]').onclick = () => window.showChatPanel && window.showChatPanel();
    hdr.querySelector('[data-a=run]').onclick = () => runAnalysis(key);
    hdr.querySelector('[data-a=chat]').onclick = () => toggleChat();
    hdr.querySelectorAll('[data-a=about]').forEach(el => el.onclick = () => showAbout(key));

    const body = p.querySelector('.ia-body');
    body.innerHTML = `<div class="ia-params"></div><div class="ia-result"></div>`;
    renderFilters(key);

    // chat drawer
    const ch = p.querySelector('.ia-chat');
    ch.classList.toggle('open', !!st.chatOpen);
    const chHdr = p.querySelector('.ia-chat-hdr');
    chHdr.style.background = `linear-gradient(135deg,${a.c1},${a.c2})`;
    chHdr.innerHTML = `<span class="ia-title" style="font-weight:700;font-size:13px">${esc(a.title)} AI</span><span style="font-size:10px;opacity:.75">grounded in your last analysis</span>
      <button class="ia-hbtn" style="margin-left:auto" data-a="clear">Clear</button><button class="ia-hbtn" data-a="close">&times;</button>`;
    chHdr.querySelector('[data-a=clear]').onclick = () => { st.chat = []; st.sessionId = null; renderChat(); };
    chHdr.querySelector('[data-a=close]').onclick = () => toggleChat(false);
    p.querySelector('.ia-chips').innerHTML = a.chips.map(c => `<button class="ia-chip" title="${esc(c)}">${esc(c)}</button>`).join('');
    p.querySelectorAll('.ia-chip').forEach(b => b.onclick = () => sendChat(b.textContent));
    renderChat();
    renderResult(key);
  }

  // Fiori-style filter bar: basic filters in a grid, advanced ones behind "More filters", Go on the right.
  const selectOptions = (f, st) => {
    const look = f.lookup && st.lookups ? st.lookups[f.lookup] || [] : [];
    const v = st.params[f.key] ?? '';
    const opts = [...new Set([...(f.options || []), ...look.map(o => typeof o === 'string' ? o : o.code), ...(v !== '' ? [v] : [])])];
    return opts.map(o => `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(o === '' ? (f.allLabel || '(saved / default)') : o)}</option>`).join('');
  };
  // Searchable combo: a hidden [data-k] input holds the code (or free text), the visible box shows
  // "Name (code)" for showName fields, else "code — name". The list filters on code and name.
  const COMBO_MAX = 200;
  // showName lists (customers) are listed by name A→Z; others keep the server's code order.
  const comboSorted = new WeakMap();
  const comboList = (f, st) => {
    const raw = st.lookups?.[f.lookup] || [];
    const key = f.showName ? raw : null;
    if (key && comboSorted.has(key)) return comboSorted.get(key);
    const list = raw.map(o => typeof o === 'string' ? { code: o, name: '' } : o);
    if (!key) return list;
    list.sort((a, z) => (a.name || a.code).localeCompare(z.name || z.code, undefined, { sensitivity: 'base', numeric: true })
      || String(a.code).localeCompare(String(z.code)));
    comboSorted.set(key, list);
    return list;
  };
  const comboText = (f, st, v) => {
    const o = v && comboList(f, st).find(x => String(x.code) === String(v));
    if (!o || !o.name) return v || '';
    return f.showName ? `${o.name} (${o.code})` : `${o.code} — ${o.name}`;
  };
  const markHit = (s, terms) => {
    let out = esc(s);
    for (const t of terms) out = out.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<b>${m}</b>`);
    return out;
  };

  function wireCombo(key, f, box) {
    const st = state[key];
    const vis = box.querySelector('.ia-cb-in'), hid = box.querySelector('[data-k]'), list = box.querySelector('.ia-cb-list');
    let shown = [], hi = -1;
    const setVal = (code, text) => { hid.value = code; vis.value = text; st.params[f.key] = code; };
    const close = () => { list.hidden = true; hi = -1; };
    const paint = () => {
      const q = vis.value.trim().toLowerCase();
      const all = comboList(f, st);
      if (!st.lookups && !st.lookupsLoading) loadLookups(key);
      // Box still shows a picked list entry's label: list everything instead of filtering on it.
      const showsPick = all.some(o => String(o.code) === hid.value) && vis.value === comboText(f, st, hid.value);
      const terms = q && !showsPick ? q.split(/\s+/) : [];
      const hits = terms.length ? all.filter(o => { const s = `${o.code} ${o.name}`.toLowerCase(); return terms.every(t => s.includes(t)); }) : all;
      shown = hits.slice(0, COMBO_MAX);
      if (hi >= shown.length) hi = shown.length - 1;
      list.innerHTML = `<div class="ia-cb-opt all${hi === -1 && !hid.value ? ' cur' : ''}" data-i="-1">${esc(f.placeholder || 'All')}</div>`
        + (!all.length ? `<div class="ia-cb-note">${st.lookupsLoading ? 'Loading list…' : 'List not available — type a code'}</div>` : '')
        + shown.map((o, i) => `<div class="ia-cb-opt${i === hi ? ' hi' : ''}${String(o.code) === hid.value ? ' cur' : ''}" data-i="${i}">`
          + `<span class="ia-cb-code">${markHit(o.code, terms)}</span><span class="ia-cb-name">${markHit(o.name, terms)}</span></div>`).join('')
        + (all.length && !hits.length ? '<div class="ia-cb-note">No match — Go will search this text</div>' : '')
        + (hits.length > shown.length ? `<div class="ia-cb-note">${hits.length - shown.length} more — keep typing to narrow</div>` : '');
      list.hidden = false;
      list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
    };
    const pick = i => {
      if (i < 0) setVal('', '');
      else { const o = shown[i]; if (o) setVal(String(o.code), comboText(f, st, o.code)); }
      close();
    };
    vis.addEventListener('focus', () => { vis.select(); paint(); });
    vis.addEventListener('click', paint);
    vis.addEventListener('input', () => { hid.value = vis.value.trim(); st.params[f.key] = hid.value; hi = vis.value.trim() ? 0 : -1; paint(); });
    vis.addEventListener('blur', () => setTimeout(close, 150));
    vis.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) return paint();
        hi = Math.max(-1, Math.min(shown.length - 1, hi + (e.key === 'ArrowDown' ? 1 : -1)));
        paint();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (!list.hidden && hi >= 0) pick(hi);
        else { close(); runAnalysis(key); }
      } else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', e => {
      e.preventDefault();   // keep focus in the box so blur doesn't close the list first
      const opt = e.target.closest('.ia-cb-opt');
      if (opt) pick(Number(opt.dataset.i));
    });
    box.querySelector('.ia-cb-tg').addEventListener('mousedown', e => {
      e.preventDefault();
      if (list.hidden) { vis.focus(); paint(); } else close();
    });
  }

  function renderFilters(key) {
    const a = AGENTS[key], st = state[key];
    const pf = document.querySelector(`#${PANEL_ID} .ia-params`);
    if (!pf) return;
    // "As of" goes last unless the agent lists { key: 'asOf' } in params to place it.
    const asOfField = { key: 'asOf', label: a.asOfLabel || 'As of', type: 'date' };
    const fields = a.params.some(f => f.key === 'asOf')
      ? a.params.map(f => f.key === 'asOf' ? { ...asOfField, ...f } : f)
      : a.params.concat([asOfField]);
    const advCount = fields.filter(f => f.adv).length;
    pf.classList.toggle('show-adv', !!st.showAdv);
    pf.innerHTML = `<div class="ia-fgrid">${fields.map(f => {
      const v = st.params[f.key] ?? '';
      let input;
      if (f.type === 'select') input = `<select data-k="${f.key}">${selectOptions(f, st)}</select>`;
      else if (f.type === 'combo') input = `<div class="ia-combo" data-combo="${f.key}"><input class="ia-cb-in" type="text" value="${esc(comboText(f, st, v))}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false"><button type="button" class="ia-cb-tg" tabindex="-1" aria-label="Show list">▾</button><input type="hidden" data-k="${f.key}" value="${esc(v)}"><div class="ia-cb-list" hidden></div></div>`;
      else input = `<input data-k="${f.key}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(v)}" placeholder="${esc(f.placeholder || '')}">`;
      return `<label class="${f.adv ? 'adv' : ''}${f.type === 'combo' ? ' wide' : ''}" title="${esc(f.label)}"><span>${esc(f.label)}</span>${input}</label>`;
    }).join('')}</div>
      <div class="ia-fbar-act">${advCount ? `<button class="ia-fbtn" data-f="adv">${st.showAdv ? 'Fewer filters' : `More filters (${advCount})`}</button>` : ''}
        <button class="ia-fbtn" data-f="clear" title="Reset all filters to their defaults">Clear</button>
        <button class="ia-fbtn go" data-f="go">Go</button></div>`;
    pf.querySelectorAll('[data-combo]').forEach(box => wireCombo(key, fields.find(f => f.key === box.dataset.combo), box));
    pf.querySelectorAll('[data-k]:not([type=hidden])').forEach(el => {
      el.addEventListener('change', () => { st.params[el.dataset.k] = el.value; });
      el.addEventListener('input', () => { st.params[el.dataset.k] = el.value; });
      el.addEventListener('keydown', e => { if (e.key === 'Enter') { st.params[el.dataset.k] = el.value; runAnalysis(key); } });
    });
    pf.querySelector('[data-f=go]').onclick = () => runAnalysis(key);
    pf.querySelector('[data-f=clear]').onclick = () => { st.params = defaultParams(key); renderFilters(key); };
    const adv = pf.querySelector('[data-f=adv]');
    if (adv) adv.onclick = () => { st.showAdv = !st.showAdv; renderFilters(key); };
  }

  function defaultParams(key) {
    const params = {};
    for (const f of AGENTS[key].params) if (f.value !== undefined) params[f.key] = String(f.value);
    params.asOf = new Date().toISOString().slice(0, 10);
    if (AGENTS[key].asOfDefault === 'monthEnd') {
      // Close the current month from the 20th onward, otherwise last month.
      const d = new Date(), m = d.getUTCMonth() + (d.getUTCDate() >= 20 ? 1 : 0);
      params.asOf = new Date(Date.UTC(d.getUTCFullYear(), m, 0)).toISOString().slice(0, 10);
    }
    return params;
  }

  async function loadLookups(key) {
    const a = AGENTS[key], st = state[key];
    if (!a.lookups || st.lookups || st.lookupsLoading) return;
    st.lookupsLoading = true;
    try {
      st.lookups = await call(`${a.api}/lookups`, {});
    } catch { /* no DB connection yet: the fields still accept typed codes; retried when a combo opens */ }
    st.lookupsLoading = false;
    if (current !== key || !st.lookups) return;
    // Re-render the bar with the list, keeping the user in the combo they are typing in.
    const active = document.activeElement?.closest?.(`#${PANEL_ID} .ia-combo`)?.dataset.combo;
    renderFilters(key);
    const vis = active && document.querySelector(`#${PANEL_ID} [data-combo="${active}"] .ia-cb-in`);
    if (vis) {
      vis.focus();
      vis.setSelectionRange(vis.value.length, vis.value.length);
      vis.dispatchEvent(new Event('input'));
    }
  }

  function setStatus(text) {
    const el = document.querySelector(`#${PANEL_ID} .ia-status`);
    if (el) el.textContent = text;
  }

  // ── analysis ───────────────────────────────────────────────────────────────
  async function runAnalysis(key) {
    const a = AGENTS[key], st = state[key];
    document.querySelectorAll(`#${PANEL_ID} .ia-params [data-k]`).forEach(el => { st.params[el.dataset.k] = el.value; });
    const btn = document.querySelector(`#${PANEL_ID} [data-a=run]`);
    const go = document.querySelector(`#${PANEL_ID} [data-f=go]`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="display:inline-block;animation:ia-spin 1s linear infinite">⟳</span> Analyzing…'; }
    if (go) go.disabled = true;
    setStatus('Reading live SAP data…');
    st.loading = true;
    if (!st.data) renderResult(key);
    try {
      const d = await call(`${a.api}/analyze`, paramValues(key));
      st.data = d; st.error = null; st.page = 1; st.kpiAI = {};
      // Server can hand back effective / saved settings (e.g. commission rules).
      if (d.paramsOut) {
        Object.assign(st.params, d.paramsOut);
        document.querySelectorAll(`#${PANEL_ID} .ia-params [data-k]`).forEach(el => {
          if (d.paramsOut[el.dataset.k] === undefined) return;
          el.value = d.paramsOut[el.dataset.k];
          const vis = el.closest('.ia-combo')?.querySelector('.ia-cb-in');
          if (vis) vis.value = comboText(a.params.find(f => f.key === el.dataset.k), st, el.value);
        });
      }
      if (!d.tabs.some(t => t.key === st.tab)) st.tab = d.tabs[0]?.key;
      if (current === key) setStatus(`Updated ${new Date().toLocaleTimeString()} · ${(d.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e) {
      st.error = e.message;
      if (current === key) setStatus('Error');
    } finally {
      st.loading = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Analyze'; }
      const go2 = document.querySelector(`#${PANEL_ID} [data-f=go]`);
      if (go2) go2.disabled = false;
      if (current === key) renderResult(key);
      // An open row chart refers to the previous run: reload it from the new one.
      if (st.rowChart && !st.error) openRowChart(key, st.rowChart.act, st.rowChart.code, true);
    }
  }

  function renderResult(key) {
    const st = state[key], a = AGENTS[key];
    const box = document.querySelector(`#${PANEL_ID} .ia-result`);
    if (!box) return;
    if (st.error) {
      box.innerHTML = `<div class="ia-card"><div class="ia-empty" style="color:#991B1B">⚠ ${esc(st.error)}</div></div>`;
      return;
    }
    const d = st.data;
    if (!d) {
      box.innerHTML = `<div class="ia-card"><div class="ia-empty">${st.loading ? 'Analyzing live SAP data…' : `Set the options above and click <b>Analyze</b>.`}</div></div>`;
      return;
    }
    const kpiTab = k => k.tab && (d.tabs || []).some(t => t.key === k.tab) ? k.tab : '';
    const kpis = (d.kpis || []).map((k, i) => `<div class="ia-kpi ${k.tone || ''}${kpiTab(k) || k.detail ? ' link' : ''}"${k.detail ? ` data-kd="${i}" role="button" tabindex="0"` : kpiTab(k) ? ` data-kt="${esc(k.tab)}" role="button" tabindex="0"` : ''} title="${esc(k.detail ? `${k.hint ? k.hint + ' — ' : ''}click for details, data summary and AI insight` : kpiTab(k) ? `${k.hint ? k.hint + ' — ' : ''}click for breakdown` : k.hint || '')}"><div class="ia-kpi-l">${esc(k.label)}</div><div class="ia-kpi-v">${fmt(k.value, k.fmt)}</div><div class="ia-kpi-s">${esc(k.hint || '')}</div></div>`).join('');
    const open = id => !collapsed(id);
    const chev = id => `<span class="ia-chev">${open(id) ? 'Collapse ▲' : 'Expand ▼'}</span>`;
    const specs = d.charts || (d.chart ? [d.chart] : []);
    box.innerHTML = `
      <div class="ia-kpis">${kpis}</div>
      <div class="ia-card"><div class="ia-card-t tog" data-c="insight">Insight ${d.aiSource === 'ai-or-rules' ? '· AI' : '· rule-based'}${chev('insight')}</div>
        <div class="ia-insight ${open('insight') ? '' : 'clip'}">${md(d.insight)}</div>
        ${open('insight') && (d.notes || []).length ? `<ul class="ia-notes">${d.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>
      ${specs.length ? `<div class="ia-charts">${specs.map(c => `<div class="ia-card"><div class="ia-card-t tog" data-c="chart">${esc(c.title || '')}${chev('chart')}</div>${open('chart') ? `${c.desc ? `<div class="ia-chartdesc">${esc(c.desc)}</div>` : ''}<div style="height:230px;padding:6px 12px 10px"><canvas></canvas></div>` : ''}</div>`).join('')}</div>` : ''}
      <div class="ia-card"><div class="ia-tabs">${d.tabs.map(t => `<button class="ia-tab ${t.key === st.tab ? 'on' : ''}" data-t="${esc(t.key)}">${esc(t.label)}</button>`).join('')}</div><div class="ia-tabbody"></div></div>`;
    box.querySelectorAll('.ia-tab').forEach(b => b.onclick = () => { st.tab = b.dataset.t; st.page = 1; st.search = ''; st.sort = null; renderResult(key); });
    // Drill-down KPIs: open their breakdown tab and scroll it into view.
    box.querySelectorAll('.ia-kpi[data-kt]').forEach(el => {
      const go = () => {
        st.tab = el.dataset.kt; st.page = 1; st.search = ''; st.sort = null; renderResult(key);
        document.querySelector(`#${PANEL_ID} .ia-tabs`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      el.onclick = go;
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    // KPI drill-through popup: calculation, data summary and AI insight.
    box.querySelectorAll('.ia-kpi[data-kd]').forEach(el => {
      const go = () => showKpiDetail(key, Number(el.dataset.kd));
      el.onclick = go;
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    box.querySelectorAll('.ia-card-t.tog').forEach(t => t.onclick = () => { setCollapsed(t.dataset.c, open(t.dataset.c)); renderResult(key); });
    destroyCharts();
    if (open('chart')) {
      const canvases = box.querySelectorAll('.ia-charts canvas');
      charts = specs.map((s, i) => drawChart(canvases[i], s, a.c2)).filter(Boolean);
    }
    renderTab(key);
  }

  // Card collapse state is remembered per browser (insight starts collapsed to its headline).
  const COLLAPSE_DEFAULT = { insight: true, chart: false };
  function collapsed(id) {
    try { const v = localStorage.getItem(`ia-collapse-${id}`); if (v != null) return v === '1'; } catch {}
    return !!COLLAPSE_DEFAULT[id];
  }
  function setCollapsed(id, on) { try { localStorage.setItem(`ia-collapse-${id}`, on ? '1' : '0'); } catch {} }

  function drawChart(canvas, spec, color) {
    if (typeof Chart === 'undefined' || !canvas) return null;
    const fi = isFiori();
    // Fiori: SAP Horizon qualitative chart palette; series colours mapped to Horizon semantic colours.
    const palette = fi ? ['#168eff', '#c87b00', '#75980b', '#df1278', '#8b47d7', '#049f9a'] : [color, '#94A3B8', '#0EA5E9', '#F59E0B'];
    const SEM = { '#DC2626': '#d20a0a', '#16A34A': '#30914c', '#D97706': '#e76500', '#F59E0B': '#e76500', '#94A3B8': '#a9b4be' };
    const colorOf = (s, i) => (fi && s.color ? SEM[s.color.toUpperCase()] : null) || s.color || palette[i % palette.length];
    // Charts are money unless titled as quantities (demand forecast "(qty)")
    // spec.fmt (int / num / pct / amt) wins; otherwise money unless titled as quantities.
    const val = spec.fmt === 'pct' ? v => `${nfN.format(v)}%` : spec.fmt === 'num' ? v => nfN.format(v)
      : spec.fmt === 'int' || /\(qty\)|quantit/i.test(spec.title || '') ? v => nf0.format(v) : v => usd(nf0, v);
    const tick = fi ? { color: '#556b82', font: { size: 12, family: "'72fiori','72','Segoe UI',sans-serif" } } : { font: { size: 10 } };
    const grid = fi ? { color: '#e5e5e5' } : undefined;
    return new Chart(canvas, {
      data: {
        labels: spec.labels,
        datasets: spec.series.map((s, i) => ({
          type: s.type === 'line' ? 'line' : 'bar', label: s.name, data: s.values,
          backgroundColor: colorOf(s, i), borderColor: colorOf(s, i),
          ...(fi && s.type !== 'line' ? { borderRadius: 4, maxBarThickness: 40 } : {}),
          borderWidth: s.type === 'line' ? 2 : 0, pointRadius: s.type === 'line' ? 2 : 0, tension: .25, order: s.type === 'line' ? 0 : 1,
        })),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        indexAxis: spec.horizontal ? 'y' : 'x',
        plugins: { legend: { display: spec.series.length > 1, position: fi ? 'bottom' : 'top',
            labels: fi ? { boxWidth: 10, boxHeight: 10, usePointStyle: true, pointStyle: 'rectRounded', color: '#1d2d3e', font: tick.font } : { boxWidth: 10, font: { size: 11 } } },
          tooltip: { mode: 'index', intersect: false, callbacks: { label: c => c.raw == null ? null : `${c.dataset.label}: ${val(c.raw)}` },
            ...(fi ? { backgroundColor: '#fff', titleColor: '#1d2d3e', bodyColor: '#1d2d3e', borderColor: '#d9d9d9', borderWidth: 1, cornerRadius: 8, padding: 10, titleFont: { ...tick.font, weight: '700' }, bodyFont: tick.font } : {}) } },
        scales: spec.horizontal
          ? { y: { stacked: !!spec.stacked, ticks: { ...tick, callback(v) { const l = String(this.getLabelForValue(v)); return l.length > 22 ? l.slice(0, 21) + '…' : l; } }, grid: { display: false } },
              x: { stacked: !!spec.stacked, ticks: { ...tick, callback: val }, grid } }
          : { x: { stacked: !!spec.stacked, ticks: tick, grid: { display: false } }, y: { stacked: !!spec.stacked, ticks: { ...tick, callback: val }, grid } },
      },
    });
  }

  function renderTab(key) {
    const st = state[key];
    const tab = st.data.tabs.find(t => t.key === st.tab) || st.data.tabs[0];
    const tb = document.querySelector(`#${PANEL_ID} .ia-tabbody`);
    if (!tab || !tb) return;
    const q = (st.search || '').toLowerCase();
    // Column filters: a dropdown per status-style (badge) column, plus an item code/name box.
    const tf = (st.tf ||= {})[tab.key] ||= {};
    const facets = tab.columns.filter(c => c.fmt === 'badge').map(c => {
      const vals = [...new Set(tab.rows.map(r => r[c.key]).filter(v => v != null && v !== ''))];
      return { c, vals: c.badge ? Object.keys(c.badge).filter(v => vals.includes(v)).concat(vals.filter(v => !(v in c.badge))) : vals.sort() };
    }).filter(f => f.vals.length > 1 && f.vals.length <= 15);
    const hasItem = tab.columns.some(c => c.key === 'itemCode');
    const iq = (tf._item || '').toLowerCase();
    let rows = tab.rows.filter(r => facets.every(f => !tf[f.c.key] || String(r[f.c.key]) === tf[f.c.key])
      && (!iq || String(r.itemCode ?? '').toLowerCase().includes(iq) || String(r.itemName ?? '').toLowerCase().includes(iq)));
    if (q) rows = rows.filter(r => tab.columns.some(c => String(r[c.key] ?? '').toLowerCase().includes(q) || (c.sub && String(r[c.sub] ?? '').toLowerCase().includes(q))));
    if (st.sort) {
      const { k, dir } = st.sort;
      rows.sort((x, y) => {
        const a = x[k], b = y[k];
        if (a == null) return 1; if (b == null) return -1;
        return (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * dir;
      });
    }
    const numeric = c => ['amt', 'price', 'num', 'int', 'pct', 'score'].includes(c.fmt);
    const actions = tab.actions || [];
    const size = st.pageSize || 50;
    const dense = tab.columns.length + (actions.length ? 1 : 0) > 9;
    const rc = st.rowChart && st.rowChart.tab === tab.key ? st.rowChart : null;
    // Grouped tabs (tab.groupBy) page over groups; each group row expands to its detail rows.
    const gb = tab.groupBy;
    let groups = null;
    if (gb) {
      const m = new Map();
      for (const r of rows) {
        const g = m.get(r[gb.key]) || { id: String(r[gb.key]), label: r[gb.label || gb.key], sub: gb.label ? r[gb.key] : '', rows: [], agg: {} };
        g.rows.push(r);
        m.set(r[gb.key], g);
      }
      groups = [...m.values()];
      for (const g of groups) {
        for (const k of gb.sum || []) {
          const vals = g.rows.map(r => r[k]).filter(v => typeof v === 'number');
          g.agg[k] = vals.length ? vals.reduce((s, v) => s + v, 0) : null;
        }
        for (const k of gb.max || []) g.agg[k] = Math.max(...g.rows.map(r => Number(r[k]) || 0));
      }
      // Without a column sort, the largest group (by gb.sortBy, else the last summed column) comes first.
      const by = gb.sortBy || (gb.sum || []).slice(-1)[0];
      if (!st.sort && by) groups.sort((a, z) => (z.agg[by] ?? 0) - (a.agg[by] ?? 0));
      // Sorting on a totalled column orders the groups by that total.
      else if (st.sort && groups[0] && st.sort.k in groups[0].agg) groups.sort((a, z) => ((a.agg[st.sort.k] ?? 0) - (z.agg[st.sort.k] ?? 0)) * st.sort.dir);
    }
    const gOpen = (st.gOpen ||= {})[tab.key] ||= {};
    const units = groups || rows;
    const pages = Math.max(1, Math.ceil(units.length / size));
    st.page = Math.min(Math.max(1, st.page || 1), pages);
    const start = (st.page - 1) * size;
    const shownGroups = groups ? groups.slice(start, start + size) : null;
    const shown = groups ? shownGroups.flatMap(g => gOpen[g.id] ? g.rows : []) : rows.slice(start, start + size);
    const lead = gb ? Math.max(1, tab.columns.findIndex(c => c.key in (shownGroups[0]?.agg || {}))) : 0;
    // A cell with an explanation (row.explain[col] or, for score columns, row.scoreBreakdown)
    // is clickable and opens a popup showing how the value was calculated.
    const cellHtml = (r, c, i) => explainOf(r, c)
      ? `<span class="ia-score-click" data-sb="${i}" data-sbk="${esc(c.key)}" title="Click to see how this is calculated">${cell(r, c, dense)}</span>` : cell(r, c, dense);
    const rowHtml = (r, i) => `<tr class="${rc && r.itemCode === rc.code ? 'sel' : ''}${gb ? ' ia-gchild' : ''}">${tab.columns.map(c => `<td class="${numeric(c) ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${cellHtml(r, c, i)}</td>`).join('')}
          ${actions.length ? `<td>${actions.map(a => `<button class="ia-act" data-i="${i}" data-act="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</td>` : ''}</tr>`;
    let bodyHtml;
    if (groups) {
      let i = 0;
      bodyHtml = shownGroups.map(g => {
        const head = `<tr class="ia-grp" data-g="${esc(g.id)}"><td colspan="${lead}"><span class="ia-gchev">${gOpen[g.id] ? '▾' : '▸'}</span><b>${esc(g.label)}</b>${g.sub ? ` <span class="ia-sub">${esc(g.sub)}</span>` : ''} <span class="ia-gcount">${g.rows.length} ${esc(gb.unit || 'rows')}</span></td>
          ${tab.columns.slice(lead).map(c => `<td class="${numeric(c) ? 'num' : ''}">${c.key in g.agg ? cell(g.agg, c, dense) : ''}</td>`).join('')}${actions.length ? '<td></td>' : ''}</tr>`;
        return head + (gOpen[g.id] ? g.rows.map(r => rowHtml(r, i++)).join('') : '');
      }).join('');
    } else bodyHtml = shown.map(rowHtml).join('');
    // Footer totals (tab.totals: true = every amount column, or a list of keys) over all filtered rows, not just this page.
    const totKeys = tab.totals === true ? tab.columns.filter(c => c.fmt === 'amt').map(c => c.key) : (tab.totals || []);
    let footHtml = '';
    if (totKeys.length && rows.length) {
      const sums = Object.fromEntries(totKeys.map(k => [k, rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)]));
      const first = Math.max(1, tab.columns.findIndex(c => totKeys.includes(c.key)));
      footHtml = `<tfoot><tr class="ia-total"><td colspan="${first}">Total <span class="ia-gcount">${groups ? `${groups.length} ${esc(gb.groupUnit || 'groups')} · ` : ''}${rows.length} ${esc(gb?.unit || (rows.length === 1 ? 'row' : 'rows'))}</span></td>
        ${tab.columns.slice(first).map(c => `<td class="${numeric(c) ? 'num' : ''}">${totKeys.includes(c.key) ? cell(sums, c, dense) : ''}</td>`).join('')}${actions.length ? '<td></td>' : ''}</tr></tfoot>`;
    }
    const anyTf = facets.some(f => tf[f.c.key]) || iq;
    tb.innerHTML = `
      <div class="ia-tools">
        ${hasItem ? `<input type="search" class="ia-tf-item" placeholder="Item code or name…" value="${esc(tf._item || '')}" style="width:200px">` : ''}
        ${facets.map(f => `<select class="ia-tf" data-tf="${esc(f.c.key)}" title="${esc(f.c.label)}"><option value="">${esc(f.c.label)}: All</option>${f.vals.map(v => `<option value="${esc(v)}" ${tf[f.c.key] === String(v) ? 'selected' : ''}>${esc(f.c.label)}: ${esc(v)} (${tab.rows.filter(r => r[f.c.key] === v).length})</option>`).join('')}</select>`).join('')}
        <input type="search" class="ia-search" placeholder="Search all columns…" value="${esc(st.search || '')}">
        ${anyTf ? '<button class="ia-act" data-tf-clear>Clear filters</button>' : ''}
        <span style="font-size:11px;color:var(--muted,#6A6D70)">${groups ? `${groups.length} ${esc(gb.groupUnit || 'groups')} · ` : ''}${rows.length} ${esc(gb?.unit || (rows.length === 1 ? 'row' : 'rows'))}</span>
        ${groups ? `<button class="ia-act" data-gall="1">Expand all</button><button class="ia-act" data-gall="0">Collapse all</button>` : ''}
        ${tab.desc || tab.columns.some(c => c.hint) ? `<button class="ia-act" data-colguide style="margin-left:auto" title="What each column means and how it is calculated">ⓘ Column guide</button>` : ''}
        <button class="ia-act" data-csv${tab.desc || tab.columns.some(c => c.hint) ? '' : ' style="margin-left:auto"'}>⬇ CSV</button></div>
      ${tab.desc ? `<div class="ia-tabdesc">${esc(tab.desc)}</div>` : ''}
      ${rc ? `<div class="ia-rowchart"><div class="ia-rowchart-h">${rc.data ? `${esc(rc.data.chart.title)} <span class="ia-sub">${esc(rc.data.method || '')} · ${esc(rc.data.status || '')}</span>` : `Loading ${esc(rc.code)}…`}
          <button class="ia-act" data-rc-close style="margin-left:auto">✕ Close chart</button></div>
          <div class="ia-rowchart-b">${rc.error ? `<div class="ia-empty" style="color:#991B1B;padding:20px">⚠ ${esc(rc.error)}</div>` : '<canvas></canvas>'}</div></div>` : ''}
      ${rows.length ? `<div class="ia-tbl-wrap"><table class="ia-tbl${dense ? ' dense' : ''}"><thead><tr>
        ${tab.columns.map(c => `<th class="${numeric(c) ? 'num' : ''}${c.hint ? ' ia-th-help' : ''}" data-k="${esc(c.key)}" title="${esc(c.hint ? `${c.hint} (click to sort)` : 'Sort')}">${esc(c.label)}${st.sort?.k === c.key ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}
        ${actions.length ? '<th>Actions</th>' : ''}</tr></thead><tbody>
        ${bodyHtml}
        </tbody>${footHtml}</table></div>
        ${pager(st.page, pages, size, start, groups ? shownGroups.length : shown.length, units.length)}`
      : `<div class="ia-empty">No rows${q ? ' match this filter' : ''}.</div>`}`;
    // Re-render on typing, keeping the caret in whichever box was being typed in.
    const live = (sel, set) => {
      const el = tb.querySelector(sel);
      if (!el) return;
      el.addEventListener('input', () => {
        set(el.value); st.page = 1;
        const pos = el.selectionStart;
        renderTab(key);
        const again = document.querySelector(`#${PANEL_ID} ${sel}`);
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
    };
    live('.ia-search', v => { st.search = v; });
    live('.ia-tf-item', v => { tf._item = v; });
    tb.querySelectorAll('[data-tf]').forEach(el => el.onchange = () => { tf[el.dataset.tf] = el.value; st.page = 1; renderTab(key); });
    const clr = tb.querySelector('[data-tf-clear]');
    if (clr) clr.onclick = () => { st.tf[tab.key] = {}; st.page = 1; renderTab(key); };
    if (rowChartObj) { try { rowChartObj.destroy(); } catch {} rowChartObj = null; }
    if (rc) {
      tb.querySelector('[data-rc-close]').onclick = () => { st.rowChart = null; renderTab(key); };
      if (rc.data) rowChartObj = drawChart(tb.querySelector('.ia-rowchart canvas'), rc.data.chart, AGENTS[key].c2);
    }
    tb.querySelector('[data-csv]').onclick = () => downloadCsv(tab, rows);
    tb.querySelectorAll('th[data-k]').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      st.sort = st.sort?.k === k ? { k, dir: -st.sort.dir } : { k, dir: tab.columns.find(c => c.key === k && numeric(c)) ? -1 : 1 };
      st.page = 1;
      renderTab(key);
    });
    const goTo = n => { st.page = n; renderTab(key); tb.querySelector('.ia-tbl-wrap')?.scrollTo({ top: 0 }); };
    tb.querySelectorAll('.ia-pager [data-pg]').forEach(b => b.onclick = () => goTo(Number(b.dataset.pg)));
    const sizeSel = tb.querySelector('.ia-pager select');
    if (sizeSel) sizeSel.onchange = () => { st.pageSize = Number(sizeSel.value); goTo(1); };
    tb.querySelectorAll('[data-act]').forEach(b => b.onclick = () => runAction(key, actions.find(a => a.id === b.dataset.act), shown[Number(b.dataset.i)]));
    tb.querySelectorAll('[data-sb]').forEach(el => el.onclick = () => { const r = shown[Number(el.dataset.sb)], c = tab.columns.find(x => x.key === el.dataset.sbk); showExplain(r, explainOf(r, c), c); });
    tb.querySelector('[data-colguide]')?.addEventListener('click', () => showColumnGuide(tab));
    tb.querySelectorAll('tr.ia-grp').forEach(tr => tr.onclick = () => { gOpen[tr.dataset.g] = !gOpen[tr.dataset.g]; renderTab(key); });
    tb.querySelectorAll('[data-gall]').forEach(b => b.onclick = () => {
      const on = b.dataset.gall === '1';
      for (const g of groups) gOpen[g.id] = on;
      renderTab(key);
    });
  }

  const PAGE_SIZES = [25, 50, 100, 200];
  function pager(page, pages, size, start, count, total) {
    // Page numbers: first, last, and a window around the current page, with gaps as "…".
    const nums = [];
    for (let n = 1; n <= pages; n++) {
      if (n === 1 || n === pages || Math.abs(n - page) <= 2) nums.push(n);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    const btn = (n, label, title, off) => `<button class="ia-act ia-pg${n === page && !title ? ' on' : ''}" data-pg="${n}"${off ? ' disabled' : ''}${title ? ` title="${title}"` : ''}>${label}</button>`;
    return `<div class="ia-pager">
      <label>Rows per page <select>${PAGE_SIZES.map(n => `<option${n === size ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <span class="ia-pg-info">${nf0.format(start + 1)}–${nf0.format(start + count)} of ${nf0.format(total)}</span>
      ${pages > 1 ? `<span class="ia-pg-nav">${btn(1, '«', 'First page', page === 1)}${btn(page - 1, '‹', 'Previous page', page === 1)}
        ${nums.map(n => n === '…' ? '<span class="ia-pg-gap">…</span>' : btn(n, nf0.format(n))).join('')}
        ${btn(page + 1, '›', 'Next page', page === pages)}${btn(pages, '»', 'Last page', page === pages)}</span>` : ''}
    </div>`;
  }

  function downloadCsv(tab, rows) {
    const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const cols = tab.columns;
    const lines = [cols.map(c => q(c.label)).join(','), ...rows.map(r => cols.map(c => q(r[c.key])).join(','))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(AGENTS[current]?.title || 'agent').replace(/\W+/g, '-')}-${tab.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── row actions ────────────────────────────────────────────────────────────
  function modal(title, bodyHtml, buttons) {
    const bg = document.createElement('div');
    bg.className = 'ia-modal-bg';
    bg.innerHTML = `<div class="ia-modal"><h3>${esc(title)}</h3><div class="ia-m-body">${bodyHtml}</div><div class="ia-m-foot"></div></div>`;
    const foot = bg.querySelector('.ia-m-foot');
    const close = () => bg.remove();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.onclick = () => b.onClick ? b.onClick(bg, close) : close();
      foot.appendChild(el);
    }
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    document.body.appendChild(bg);
    return bg;
  }
  // "About this agent" popup: purpose, business value, data sources and how to read the dashboard.
  // Rendered by agent-about.js so every agent in the AI Agents menu shares one popup.
  function showAbout(key) {
    const a = AGENTS[key];
    if (a.about) window.AgentAbout?.open(`${a.title} Agent`, a.about, a.c2);
  }
  // KPI drill-through popup (Power BI style): data summary (stat tiles, chart,
  // top contributors), how the figure is calculated, and an AI insight fetched
  // from /kpi-insight (falls back to the rule-based detail.insight).
  function showKpiDetail(key, index) {
    const st = state[key], a = AGENTS[key];
    const k = st.data?.kpis?.[index], d = k?.detail;
    if (!d) return;
    const ks = st.kpiAI ||= {};
    let view = 'summary', chart = null;
    const tabsHtml = () => [['summary', 'Data summary'], ['calc', 'How it’s calculated'], ['ai', '✦ AI insight']]
      .map(([v, l]) => `<button class="ia-kd-tab ${v === view ? 'on' : ''}" data-v="${v}">${l}</button>`).join('');
    const summaryHtml = () => `
      ${(d.stats || []).length ? `<div class="ia-kd-stats">${d.stats.map(x => `<div class="ia-kd-stat"><div class="l">${esc(x.label)}</div><div class="v">${fmt(x.value, x.fmt)}</div></div>`).join('')}</div>` : ''}
      ${d.chart ? `<div class="ia-kd-box"><div class="ia-kd-h">${esc(d.chart.title || '')}</div><div style="height:220px"><canvas></canvas></div></div>` : ''}
      ${d.table?.rows?.length ? `<div class="ia-kd-box"><div class="ia-kd-h">${esc(d.table.title || 'Contributors')} <span class="ia-m-hint">(${d.table.rows.length})</span></div>
        <div style="overflow:auto;max-height:300px"><table class="ia-grid"><thead><tr>${d.table.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${d.table.rows.map(r => `<tr>${d.table.columns.map(c => `<td${c.wrap ? ' style="white-space:normal;text-align:left;min-width:180px"' : ''}>${cell(r, c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`
        : d.table ? '<div class="ia-m-hint">No rows contribute to this KPI.</div>' : ''}`;
    const calcHtml = () => `
      <div class="ia-kd-box"><div class="ia-kd-h">Formula</div><div class="ia-kd-formula">${esc(d.formula || k.hint || '')}</div></div>
      ${(d.steps || []).length ? `<div class="ia-kd-box"><div class="ia-kd-h">Calculation steps</div><ol class="ia-kd-list">${d.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol></div>` : ''}
      ${(d.sources || []).length ? `<div class="ia-kd-box"><div class="ia-kd-h">SAP data sources</div><ul class="ia-kd-list">${d.sources.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="ia-m-hint">As of ${esc(st.data.asOf || '')} · read live from SAP Business One.</div>`;
    const aiHtml = () => {
      const r = ks[index];
      if (!r || r.loading) return '<div class="ia-kd-box ia-kd-ai"><span style="display:inline-block;animation:ia-spin 1s linear infinite">⟳</span> Generating AI insight…</div>';
      return `<div class="ia-kd-box ia-kd-ai"><div class="ia-kd-h">${r.source === 'ai' ? '✦ AI insight' : 'Insight · rule-based'}</div><div class="ia-insight">${md(r.text)}</div></div>
        ${r.error ? `<div class="ia-m-hint" style="color:#991B1B">AI unavailable: ${esc(r.error)} — showing rule-based insight.</div>` : ''}`;
    };
    const body = `<div class="ia-kd-head"><div class="ia-kd-val ${k.tone || ''}">${fmt(k.value, k.fmt)}</div><div class="ia-m-hint">${esc(k.hint || '')}</div></div>
      <div class="ia-kd-tabs"></div><div class="ia-kd-body"></div>`;
    const destroy = () => { try { chart?.destroy(); } catch {} chart = null; };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const close = () => { destroy(); document.removeEventListener('keydown', onKey); bg.remove(); };
    const bg = modal(k.label, body, [
      ...(k.tab && st.data.tabs.some(t => t.key === k.tab) ? [{ label: 'Open full list', onClick: () => {
        close(); st.tab = k.tab; st.page = 1; st.search = ''; st.sort = null; renderResult(key);
        document.querySelector(`#${PANEL_ID} .ia-tabs`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } }] : []),
      { label: 'Ask AI in chat', onClick: () => { close(); sendChat(`Explain the "${k.label}" KPI (${fmt(k.value, k.fmt).replace(/<[^>]+>/g, '')}): what drives it and what should we do?`); } },
      { label: 'Close', primary: true, onClick: () => close() },
    ]);
    bg.querySelector('.ia-modal').classList.add('ia-kd');
    bg.addEventListener('click', e => { if (e.target === bg) { destroy(); document.removeEventListener('keydown', onKey); } });
    document.addEventListener('keydown', onKey);
    const paint = () => {
      if (!bg.isConnected) return;
      destroy();
      bg.querySelector('.ia-kd-tabs').innerHTML = tabsHtml();
      bg.querySelectorAll('.ia-kd-tab').forEach(b => b.onclick = () => { view = b.dataset.v; paint(); });
      bg.querySelector('.ia-kd-body').innerHTML = view === 'calc' ? calcHtml() : view === 'ai' ? aiHtml() : summaryHtml();
      if (view === 'summary' && d.chart) chart = drawChart(bg.querySelector('.ia-kd-body canvas'), d.chart, a.c2);
    };
    paint();
    // AI insight is fetched once per KPI per analysis run (cache cleared on re-run).
    if (!ks[index]) {
      ks[index] = { loading: true };
      call(`${a.api}/kpi-insight`, { index })
        .then(r => { ks[index] = { text: r.insight || d.insight || 'No insight available.', source: r.source }; })
        .catch(e => { ks[index] = { text: d.insight || 'No insight available.', source: 'rules', error: e.message }; })
        .finally(() => { if (view === 'ai') paint(); });
    }
  }
  // Column guide: what the current tab shows and what every column means
  // (tab.desc + column.hint, written by each agent's backend).
  function showColumnGuide(tab) {
    const body = `${tab.desc ? `<div style="font-size:13px">${esc(tab.desc)}</div>` : ''}
      <table class="ia-grid"><thead><tr><th>Column</th><th style="text-align:left">What it means / how it is calculated</th></tr></thead><tbody>
      ${tab.columns.map(c => `<tr><td><b>${esc(c.label)}</b></td><td style="text-align:left;white-space:normal">${esc(c.hint || '—')}</td></tr>`).join('')}
      </tbody></table>
      <div class="ia-m-hint">Tip: values shown with a dotted underline in the table can be clicked to see the calculation for that row.</div>`;
    modal(`Column guide — ${String(tab.label).replace(/\s*\(\d+\)$/, '')}`, body, [{ label: 'Close', primary: true }]);
  }

  // ── "How is this calculated?" popups ───────────────────────────────────────
  // Backends attach explanations to rows so functional users can see the formula
  // behind a score, probability, suggested quantity, price or recommendation:
  //   row.explain = { <columnKey>: { title?, parts?, steps?, rules?, result?, note?, priority?, priorityReason? } }
  //   parts  — score components, summed: [{ label, max, points, formula, detail }]
  //   steps  — calculation steps:        [{ label, formula?, value, detail? }]
  //   rules  — decision table:           [{ rule, result, hit? }]  (hit = the rule that applied)
  //   result — the final value:          { label, value }
  // row.scoreBreakdown (older agents) is the same shape and explains the 'score' column.
  const explainOf = (r, c) => (c && r?.explain?.[c.key]) || (c?.fmt === 'score' && r?.scoreBreakdown) || null;
  function showExplain(row, ex, col) {
    if (!ex) return;
    const parts = ex.parts || [], steps = ex.steps || [], rules = ex.rules || [];
    const total = parts.reduce((s, p) => s + p.points, 0);
    const maxTotal = parts.reduce((s, p) => s + p.max, 0);
    const val = v => typeof v === 'number' ? nfN.format(v) : esc(v ?? '');
    const body = `
      ${parts.length ? `<table class="ia-grid"><thead><tr><th>Component</th><th>How it is calculated</th><th>Points</th></tr></thead><tbody>
        ${parts.map(p => `<tr><td><b>${esc(p.label)}</b><div class="ia-m-hint">${esc(p.detail)}</div></td>
          <td style="text-align:left;white-space:normal">${esc(p.formula)}</td>
          <td><b>${nfN.format(p.points)}</b> <span class="ia-m-hint">/ ${p.max}</span></td></tr>`).join('')}
        <tr><td><b>Total score</b></td><td></td><td><b>${Math.round(total)}</b> <span class="ia-m-hint">/ ${maxTotal}</span></td></tr>
      </tbody></table>` : ''}
      ${steps.length ? `<table class="ia-grid"><thead><tr><th>Step</th><th>How it is calculated</th><th>Value</th></tr></thead><tbody>
        ${steps.map(p => `<tr><td><b>${esc(p.label)}</b>${p.detail ? `<div class="ia-m-hint">${esc(p.detail)}</div>` : ''}</td>
          <td style="text-align:left;white-space:normal">${esc(p.formula || '')}</td><td><b>${val(p.value)}</b></td></tr>`).join('')}
        ${ex.result ? `<tr><td><b>${esc(ex.result.label)}</b></td><td></td><td><b>${val(ex.result.value)}</b></td></tr>` : ''}
      </tbody></table>` : ex.result && !parts.length ? `<div style="font-size:13px">${esc(ex.result.label)}: <b>${val(ex.result.value)}</b></div>` : ''}
      ${rules.length ? `<div class="ia-m-hint" style="margin-top:2px">Decision rules (the one that applied is highlighted):</div>
        <table class="ia-grid"><thead><tr><th>Rule</th><th style="text-align:left">Result</th></tr></thead><tbody>
        ${rules.map(x => `<tr class="${x.hit ? 'man' : ''}"><td style="white-space:normal">${x.hit ? '▶ ' : ''}${x.hit ? `<b>${esc(x.rule)}</b>` : esc(x.rule)}</td>
          <td style="text-align:left;white-space:normal">${x.hit ? `<b>${esc(x.result)}</b>` : esc(x.result)}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${ex.note ? `<div class="ia-m-hint">${esc(ex.note)}</div>` : ''}
      ${ex.priority ? `<div style="font-size:12px">Priority: ${badge(ex.priority)} — ${esc(ex.priorityReason || '')}</div>
        <div class="ia-m-hint">Priority comes from fixed rules (broken promise, open promise, days overdue), not from the score.</div>` : ''}`;
    const who = row?.cardName || row?.partner || row?.vendorName || row?.itemName || row?.itemCode || row?.salesperson || row?.name || '';
    const title = ex.title || (parts.length ? `Score ${row?.score ?? Math.round(total)}` : `How "${col?.label || 'this value'}" is calculated`);
    modal(who ? `${title} — ${who}` : title, body, [{ label: 'Close', primary: true }]);
  }
  const fill = (tpl, row) =>String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => row[k] ?? '');

  // Inline chart for one row, drawn above the table in the current tab.
  async function openRowChart(key, act, code, quiet) {
    const st = state[key];
    if (!code) return;
    st.rowChart = { tab: quiet && st.rowChart ? st.rowChart.tab : st.tab, act, code, data: null, error: null };
    if (!quiet && current === key) {
      renderTab(key);
      document.querySelector(`#${PANEL_ID} .ia-rowchart`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    try { st.rowChart.data = await call(act.endpoint, { itemCode: code }); }
    catch (e) { st.rowChart.error = e.message; }
    if (current === key && st.data) renderTab(key);
  }

  // Month-by-month override editor: statistical forecast, current value, override input.
  async function openGrid(key, act, row) {
    toast('Loading forecast…');
    const d = await call(act.load, { itemCode: row.itemCode });
    const months = d.months || [];
    const body = `<div class="ia-m-hint">Type a quantity to replace the statistical forecast for that month. Clear a box to go back to the statistical value.</div>
      <table class="ia-grid"><thead><tr><th>Month</th><th>Statistical</th><th>Low – High</th><th>Proj. inventory</th><th>Override qty</th></tr></thead><tbody>
      ${months.map(m => `<tr class="${m.manual ? 'man' : ''}"><td>${esc(m.label)}${m.manual ? ' <span class="ia-badge" style="background:#FEF3C7;color:#92400E">MANUAL</span>' : ''}</td>
        <td>${nfN.format(m.stat)}</td><td>${nf0.format(m.lower)} – ${nf0.format(m.upper)}</td><td>${nf0.format(m.inventory)}</td>
        <td><input type="number" min="0" step="any" data-m="${esc(m.key)}" value="${m.manual ? esc(m.value) : ''}" placeholder="${esc(nfN.format(m.stat))}"></td></tr>`).join('')}
      </tbody></table>`;
    const changes = (bg, clearAll) => {
      const out = {};
      bg.querySelectorAll('[data-m]').forEach(i => {
        const m = months.find(x => x.key === i.dataset.m);
        const v = clearAll ? '' : i.value.trim();
        if (v === '' ? m.manual : !(m.manual && Number(v) === m.value)) out[m.key] = v;
      });
      return out;
    };
    const save = async (bg, close, clearAll) => {
      const ch = changes(bg, clearAll);
      if (!Object.keys(ch).length) { close(); toast('No changes.'); return; }
      try {
        const r = await call(act.endpoint, { row, values: { months: ch } });
        close();
        if (r.message) toast(r.message);
        if (act.refresh) runAnalysis(key);
      } catch (e) { toast(e.message, true); }
    };
    modal(`${act.label} — ${row.itemCode} ${row.itemName || ''}`, body, [
      ...(months.some(m => m.manual) ? [{ label: 'Clear all overrides', onClick: (bg, close) => save(bg, close, true) }] : []),
      { label: 'Cancel' },
      { label: 'Save', primary: true, onClick: (bg, close) => save(bg, close, false) },
    ]);
  }

  async function runAction(key, act, row) {
    if (!act || !row) return;
    const post = async (extra) => {
      const d = await call(act.endpoint, { row, ...(act.extra || {}), ...(extra || {}) });
      if (d.message) toast(d.message);
      if (act.refresh) runAnalysis(key);
      return d;
    };
    try {
      if (act.kind === 'chart') return openRowChart(key, act, row[act.from || 'itemCode']);
      if (act.kind === 'grid') return await openGrid(key, act, row);
      if (act.kind === 'focus') {
        // Re-run the analysis with a parameter taken from the row (e.g. chart one item).
        const v = row[act.from] ?? '';
        state[key].params[act.param] = v;
        const el = document.querySelector(`#${PANEL_ID} .ia-params [data-k="${act.param}"]`);
        if (el) el.value = v;
        document.querySelector(`#${PANEL_ID} .ia-body`)?.scrollTo({ top: 0, behavior: 'smooth' });
        return runAnalysis(key);
      }
      if (act.kind === 'post') {
        if (act.confirm && !confirm(fill(act.confirm, row))) return;
        await post();
      } else if (act.kind === 'text') {
        toast('Drafting…');
        const d = await post();
        modal(d.title || act.label, `${d.to ? `<div style="font-size:12px">To: <b>${esc(d.to)}</b></div>` : ''}<textarea>${esc(d.text || '')}</textarea>`, [
          { label: 'Copy', onClick: (bg) => { const t = bg.querySelector('textarea'); t.select(); navigator.clipboard?.writeText(t.value); toast('Copied'); } },
          ...(d.to ? [{ label: 'Open in mail', onClick: (bg) => {
            const t = bg.querySelector('textarea').value; const m = t.match(/^Subject:\s*(.*)\n+/);
            location.href = `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(m ? m[1] : '')}&body=${encodeURIComponent(m ? t.slice(m[0].length) : t)}`;
          } }] : []),
          { label: 'Close', primary: true },
        ]);
      } else if (act.kind === 'form') {
        const fields = act.fields || [];
        modal(`${act.label} — ${row.cardName || row.itemCode || ''}`, fields.map(f => {
          const v = f.from ? row[f.from] : f.default ?? '';
          return `<label>${esc(f.label)}<input data-f="${esc(f.key)}" type="${f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}" step="any" value="${esc(v)}"></label>`;
        }).join(''), [
          { label: 'Cancel' },
          { label: 'Save', primary: true, onClick: async (bg, close) => {
            const values = {};
            bg.querySelectorAll('[data-f]').forEach(i => { values[i.dataset.f] = i.value; });
            try { await post({ values }); close(); } catch (e) { toast(e.message, true); }
          } },
        ]);
      }
    } catch (e) { toast(e.message, true); }
  }

  // ── chat ───────────────────────────────────────────────────────────────────
  function toggleChat(force) {
    const st = state[current];
    if (!st) return;
    st.chatOpen = force === undefined ? !st.chatOpen : force;
    document.querySelector(`#${PANEL_ID} .ia-chat`)?.classList.toggle('open', st.chatOpen);
    if (st.chatOpen) document.querySelector(`#${PANEL_ID} .ia-chat-in input`)?.focus();
  }
  function renderChat() {
    const st = state[current], a = AGENTS[current];
    const box = document.querySelector(`#${PANEL_ID} .ia-chat-msgs`);
    if (!box || !st) return;
    const intro = `<div class="ia-msg a">Ask me anything about the current <b>${esc(a.title)}</b> analysis. I answer only from the live SAP data you loaded with <b>Analyze</b>.</div>`;
    box.innerHTML = intro + st.chat.map(m => m.role === 'user'
      ? `<div class="ia-msg u" style="background:${a.c2}">${esc(m.text)}</div>`
      : m.pending ? '<div class="ia-msg a ia-typing" aria-label="Thinking"><i></i><i></i><i></i></div>'
        : `<div class="ia-msg a">${md(m.text)}</div>`).join('');
    // Suggestions: full list until the first question, then a compact single row.
    const busy = st.chat.some(m => m.pending);
    const chat = document.querySelector(`#${PANEL_ID} .ia-chat`);
    chat?.classList.toggle('started', st.chat.length > 0);
    chat?.querySelectorAll('.ia-chip, .ia-chat-in input, .ia-chat-in button').forEach(el => { el.disabled = busy; });
    box.scrollTop = box.scrollHeight;
  }
  async function sendChat(text) {
    const key = current, st = state[key];
    const inp = document.querySelector(`#${PANEL_ID} .ia-chat-in input`);
    const msg = (text ?? inp?.value ?? '').trim();
    if (!msg || st.chat.some(m => m.pending)) return;
    if (!st.chatOpen) toggleChat(true);
    if (inp) inp.value = '';
    st.chat.push({ role: 'user', text: msg });
    const pending = { role: 'ai', text: '', pending: true };
    st.chat.push(pending);
    renderChat();
    try {
      const d = await call(`${AGENTS[key].api}/chat`, { message: msg, sessionId: st.sessionId });
      st.sessionId = d.sessionId;
      pending.text = d.reply || 'No answer.';
    } catch (e) { pending.text = `⚠ ${e.message}`; }
    pending.pending = false;
    if (current === key) {
      renderChat();
      if (st.chatOpen) document.querySelector(`#${PANEL_ID} .ia-chat-in input`)?.focus();
    }
  }

  // ── navigation ─────────────────────────────────────────────────────────────
  window.showInsightAgent = function (key) {
    if (!AGENTS[key]) return;
    current = key;
    if (!state[key]) {
      state[key] = { params: defaultParams(key), chat: [], sessionId: null, tab: null, data: null, page: 1, pageSize: 50 };
    }
    hideOthers();
    const p = ensurePanel();
    p.style.display = 'flex';
    renderShell(key);
    document.querySelectorAll('.nav-item, .nav-subitem').forEach(n => n.classList.remove('active'));
    document.getElementById(`nav-ia-${key}`)?.classList.add('active');
    loadLookups(key);
    if (!AGENTS[key].manualRun && !state[key].data && !state[key].loading && !state[key].error) runAnalysis(key);
  };

  const hidePanel = () => {
    const p = document.getElementById(PANEL_ID);
    if (p && p.style.display !== 'none') {
      p.style.display = 'none';
      document.documentElement.classList.remove('ia-fi');
      destroyCharts();
      if (rowChartObj) { try { rowChartObj.destroy(); } catch {} rowChartObj = null; }
    }
  };
  // Other panels' show functions don't know about this panel, so step aside
  // whenever any other full-height panel (or the chat) becomes visible in
  // .main — covers the sidebar, the collapsed icon rail and programmatic opens.
  const isShown = el => el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  const observer = new MutationObserver(() => {
    const p = document.getElementById(PANEL_ID);
    const main = document.querySelector('.main');
    if (!p || !main || p.style.display === 'none') return;
    for (const el of main.children) {
      if (el !== p && (el.id === 'messages' || /-panel$/.test(el.id || '')) && isShown(el)) { hidePanel(); return; }
    }
  });
  const observe = () => {
    const main = document.querySelector('.main');
    // subtree is needed to see style changes on .main's children; the callback
    // itself only inspects direct children, so it stays cheap.
    if (main) observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe); else observe();
  // Sidebar prompt shortcuts (data-prompt) send a chat message without
  // switching views, so bring the chat back when one is clicked from here.
  document.addEventListener('click', e => {
    const nav = e.target.closest?.('.nav-item[data-prompt], .nav-subitem[data-prompt]');
    const p = document.getElementById(PANEL_ID);
    if (nav && p && p.style.display !== 'none' && window.showChatPanel) window.showChatPanel();
  }, true);
  const wrapShowChat = () => {
    const orig = window.showChatPanel;
    if (!orig || orig.__ia) return;
    const wrapped = function (...args) { hidePanel(); return orig.apply(this, args); };
    wrapped.__ia = true;
    window.showChatPanel = wrapped;
  };
  wrapShowChat();
  document.addEventListener('DOMContentLoaded', wrapShowChat);
  window.addEventListener('load', wrapShowChat);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.ia-modal-bg')) { document.querySelector('.ia-modal-bg').remove(); return; }
    const st = state[current];
    if (st?.chatOpen) { toggleChat(false); e.stopPropagation(); }
  }, true);
})();
