// ══════════════════════════════════════════════════════════════════════════════
// AGENT ABOUT — "ⓘ About" button + popup for every agent in the AI Agents menu.
//
// window.AgentAbout.open(title, about, color) renders the popup; the insight
// agents (insight-agents.js) call it from their own header button. The other
// agents have hand-built panels in index.html, so this file adds the button to
// each panel's header the first time it is shown (see PANELS below).
//
// about = { summary, sections: [{ title, items: [..], ordered? }] }
// **bold** is the only markup supported in the text.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  function injectCss() {
    if (document.getElementById('agent-about-css')) return;
    const s = document.createElement('style');
    s.id = 'agent-about-css';
    s.textContent = `
.aa-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2100;display:flex;align-items:center;justify-content:center;padding:16px}
.aa-modal{background:#fff;border-radius:8px;width:760px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25);color:#32363A;font-family:inherit}
.aa-modal h3{margin:0;padding:12px 16px;font-size:14px;border-bottom:1px solid #E5E7EB;display:flex;align-items:center;gap:8px}
.aa-modal h3 .aa-x{margin-left:auto;border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#64748B;padding:0 4px}
.aa-body{padding:14px 16px;overflow:auto;font-size:13px;line-height:1.55}
.aa-sum{margin:0 0 4px;padding:10px 12px;background:#F8FAFC;border-left:3px solid #64748B;border-radius:4px}
.aa-body section{margin-top:12px}
.aa-body h4{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#475569}
.aa-body ul,.aa-body ol{margin:0;padding-left:20px}
.aa-body li{margin:3px 0}
.aa-foot{display:flex;justify-content:flex-end;padding:10px 16px;border-top:1px solid #E5E7EB}
.aa-foot button{font-size:12px;padding:6px 16px;border-radius:4px;border:1px solid #0070F2;background:#0070F2;color:#fff;cursor:pointer;font-weight:600}
.aa-btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;flex-shrink:0;font-family:inherit}
.aa-btn:hover{background:rgba(255,255,255,.22)}
.aa-btn svg{width:13px;height:13px}
html[data-ui="fiori"] .aa-btn{background:#fff;border:1px solid #bcc3ca;color:#0064d9;border-radius:8px;height:32px;padding:0 12px;font-size:13px}
html[data-ui="fiori"] .aa-btn:hover{background:#eaecee}
html[data-ui="fiori"] .aa-modal{border-radius:16px;font-family:'72fiori','72','Segoe UI',system-ui,sans-serif;color:#1d2d3e}
html[data-ui="fiori"] .aa-modal h3{font-size:16px;padding:16px 20px}
html[data-ui="fiori"] .aa-foot button{height:36px;border-radius:8px;font-size:14px}
@media (max-width:640px){.aa-body{padding:12px}.aa-modal h3{padding:12px}}
`;
    document.head.appendChild(s);
  }

  const INFO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

  // opts.prefix: false drops the "About — " in front of the title (KPI / column help).
  function open(title, about, color, opts = {}) {
    if (!about) return;
    injectCss();
    document.querySelector('.aa-bg')?.remove();
    const bg = document.createElement('div');
    bg.className = 'aa-bg';
    bg.innerHTML = `<div class="aa-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${INFO_SVG.replace('<svg ', `<svg width="18" height="18" style="color:${esc(color || '#0070F2')}" `)}${opts.prefix === false ? '' : 'About — '}${esc(title)}<button class="aa-x" title="Close" aria-label="Close">&times;</button></h3>
      <div class="aa-body">
        <p class="aa-sum" style="border-left-color:${esc(color || '#64748B')}">${inline(about.summary)}</p>
        ${(about.sections || []).map(s => `<section><h4>${esc(s.title)}</h4>
          <${s.ordered ? 'ol' : 'ul'}>${s.items.map(i => `<li>${inline(i)}</li>`).join('')}</${s.ordered ? 'ol' : 'ul'}></section>`).join('')}
      </div>
      <div class="aa-foot"><button>Got it</button></div>
    </div>`;
    const close = () => bg.remove();
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    bg.querySelector('.aa-x').onclick = close;
    bg.querySelector('.aa-foot button').onclick = close;
    document.body.appendChild(bg);
    bg.querySelector('.aa-foot button').focus();
  }
  document.addEventListener('keydown', e => {
    const bg = document.querySelector('.aa-bg');
    if (e.key === 'Escape' && bg) { bg.remove(); e.stopPropagation(); }
  }, true);

  // ── Panel agents ───────────────────────────────────────────────────────────
  // nav: sidebar item id · panel: panel element id · title: header title text
  // (the button goes right after the header element holding it) · color: accent.
  const PANELS = [
    // ── Supply Chain ───────────────────────────────────────────────────────
    { nav: 'nav-mrp-auto-po', panel: 'mrp-auto-po-panel', title: 'MRP Auto-PO Agent', name: 'MRP Auto-PO', color: '#2563eb',
      about: {
        summary: 'Automates replenishment end to end: runs MRP to find items below their reorder point, adds vendor, last price and payment terms, builds draft Purchase Orders grouped by vendor, posts them to SAP (through your approval workflow) and emails the vendor. Every run is recorded in an audit log.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Never run out of key items** — shortages are detected and ordered automatically.',
            '**One click from shortage to PO** — no manual list building or PO typing.',
            '**Controls kept** — POs go through SAP approval before they are sent.',
            '**Full traceability** — every MRP run and PO is in the audit log.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing** — hours of daily reorder work reduced to a review.',
            '**Operations / Sales** — stock is available when customers order.',
            '**Management / Audit** — approvals and a complete history of automated orders.',
          ] },
          { title: 'How it works (SAP Business One data)', items: [
            '**Items** — minimum / maximum stock, lead time, preferred vendor, available, on order.',
            '**Vendors, last purchase prices and payment terms.**',
            '**Reorder qty** = max stock − (available + on order); if no max is set, 2 × the gap.',
            '**Urgency:** Critical = no stock left, High = gap ≥ 70% of minimum, otherwise Medium.',
          ] },
          { title: 'What you see on the screen', items: [
            '**8-step progress bar** — MRP Trigger → Threshold → AI Analysis → Draft PO → Approval → Manager ✓ → Auto PO → Email Vendor.',
            '**KPI tiles** — Critical Items, High Priority, Total Items, Draft POs, Pending Approval, POs Posted.',
            '**Items & Vendors** — gap, reorder qty, vendor, price, estimated total; **Build Draft POs**.',
            '**Draft POs** — one card per vendor: **Post to SAP**, **Email Vendor**, **Check Approval**.',
            '**Approval** and **Audit Log** tabs, and **MRP Auto-PO AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Click **Run MRP** — show Critical / High items.',
            'Open **Items & Vendors**, select items, **Build Draft POs**.',
            'On **Draft POs**, post one to SAP and show it in **Approval**.',
            'Click **Email Vendor**, then show the **Audit Log**.',
          ] },
        ],
      } },
    { nav: 'nav-procurement-agent', panel: 'procurement-agent-panel', title: 'Stock Reorder Monitor', name: 'Stock Reorder Monitor', color: '#E9730C',
      about: {
        summary: 'A live list of every item below its minimum stock level, shown together with open sales orders and open purchase orders. Select the items, adjust quantities, and generate draft POs grouped by preferred vendor — then post them to SAP — or raise a Purchase Request through AI.',
        sections: [
          { title: 'Why use this agent', items: [
            '**See shortages instantly** — no need to run stock reports.',
            '**Simulate before ordering** — change Order Qty and see the stock level after the order.',
            '**Draft POs in one click** — grouped by preferred vendor.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing / Stores** — a daily reorder worklist.',
            '**Sales** — fewer stock-outs on customer orders.',
            '**Management** — visibility of critical stock.',
          ] },
          { title: 'Where the data comes from (SAP Business One)', items: [
            '**Items** — available stock, minimum / maximum, lead time, preferred vendor.',
            '**Open sales orders** and **open purchase orders**.',
            '**Priority:** Critical = no stock, High = gap ≥ 70% of minimum, otherwise Medium.',
            '**Creates:** SAP **Purchase Orders** (or Purchase Requests via AI).',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Critical Stock, High Priority, Medium Priority, Open Sales Orders, Open Purchase Orders.',
            '**Reorder Monitor** — available, min stock, gap, on order, reorder qty, vendor, editable **Order Qty** and **After Order**.',
            '**Draft POs** — one per vendor with **Post to SAP**; items without a preferred vendor are listed separately.',
            '**Procurement AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Show the **Critical Stock** tile and the top rows.',
            'Edit an **Order Qty** and show **After Order**.',
            'Select items and click **Generate Draft POs**.',
            'Open **Draft POs** and **Post to SAP**.',
          ] },
        ],
      } },
    { nav: 'nav-purchase-three-way-match', panel: 'purchase-three-way-match-panel', title: 'Purchase Three Way Match', name: 'Purchase Three Way Match', color: '#354A5E',
      about: {
        summary: 'Compares, vendor by vendor for a year, the value ordered (Purchase Orders), received (Goods Receipts) and billed (A/P Invoices). It shows which vendors are fully matched, where receipts or invoices are still pending, and where invoices differ from the PO.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Stop over-billing** — invoice vs PO variance per vendor.',
            '**Find pending work** — goods not yet received, or received but not invoiced.',
            '**Year-level control** — the whole purchase cycle in one table.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Accounts payable** — focus on vendors with variances.',
            '**Purchasing** — chase pending deliveries.',
            '**Finance / Audit** — evidence of purchase-cycle control.',
          ] },
          { title: 'How it works (SAP Business One data)', items: [
            '**Purchase orders, goods receipts (GRPO) and A/P invoices** for the selected year.',
            '**Variance** = invoice amount − PO amount; **Match %** = invoice ÷ PO.',
            '**Status:** Matched, GRPO Pending, Invoice Pending, or Variance (difference over 5%).',
            'Read-only — nothing is posted.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Total PO Amount, Total GRPO Amount, Total AP Invoice, Net Variance.',
            '**Three-Way Match by Vendor** — PO, GRPO and invoice docs and amounts, variance, Match % (green ≥ 95%, orange ≥ 75%, red below) and status.',
            '**Filters** — vendor, year, status.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Choose the year — show the four totals and **Net Variance**.',
            'Filter **Variance** — vendors billing differently from the PO.',
            'Filter **GRPO Pending** — deliveries to chase.',
          ] },
        ],
      } },
    { nav: 'nav-production-agent', panel: 'production-agent-panel', title: 'Production Agent', name: 'Production Agent', color: '#2D6A4F',
      about: {
        summary: 'Checks every open production order against component stock and flags the orders at risk of delay because components are short. It shows which components are missing, how many orders each affects, and which orders are due this week or overdue.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Avoid stopped production** — know missing components before the job starts.',
            '**Prioritise purchasing** — components that block the most orders come first.',
            '**Meet due dates** — overdue and due-this-week orders highlighted.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Production planning** — realistic schedule.',
            '**Purchasing** — clear shortage list.',
            '**Sales / Management** — on-time delivery and cost visibility.',
          ] },
          { title: 'How it works (SAP Business One data)', items: [
            '**Production orders** and their **component lines** (planned vs issued).',
            '**Component stock** — available, on hand, on order, average price.',
            '**Shortage** = still needed − available.',
            '**Risk:** Critical = a component has no stock, High = a component under 50% covered, Medium = any shortage, otherwise On Track.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Total Open, Critical Risk, High Risk, Medium Risk, Due This Week, Overdue.',
            '**Production Orders** — product, planned / completed qty, due date, days left, risk, shortages.',
            '**Component Shortage** — needed, available, shortage, affected orders, severity.',
            '**Timeline**, order detail (components, stock, costing) and **Production AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Show **Critical Risk** and **Overdue** tiles.',
            'Filter **Critical** and open one order\'s detail.',
            'Open **Component Shortage** — what purchasing must expedite.',
          ] },
        ],
      } },
    { nav: 'nav-purchasing-agent', panel: 'purchasing-agent-panel', title: 'Purchase Recommendation', name: 'Purchase Recommendation', color: '#2563EB',
      about: {
        summary: 'Recommends what to buy and how much (including an economic order quantity), rates each supplier\'s delivery risk from the last 6 months, and lists the customer sales orders that current shortages will affect.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Buy the right quantity** — suggested qty and EOQ per item.',
            '**Know your risky suppliers** — overdue rate and spend concentration.',
            '**Protect customer orders** — see which sales orders are at risk.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing** — prioritised buying list and supplier risk view.',
            '**Sales** — early warning on affected customer orders.',
            '**Management** — reduced supply risk.',
          ] },
          { title: 'How it works (SAP Business One data)', items: [
            '**Items** — on hand, minimum, on order, committed.',
            '**Purchase orders** (last 6 months) and **sales orders** due in 45 days.',
            '**Urgency:** Critical = no stock, High = stock + on order under 50% of minimum, otherwise Medium.',
            '**Supplier risk:** High = over 50% of POs overdue; Medium = over 20% overdue or over 40% of spend.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — To Reorder, Zero Stock, High Risk Items, Supplier Risks, Overdue PO, Orders at Risk.',
            '**Purchase Recommendations** — on hand, min, on order, suggested qty, EOQ, vendor, urgency.',
            '**Supplier Risks** — POs, spend, spend %, overdue rate, risk.',
            '**Order Impact** — sales orders, due date, days left, affected items, severity.',
            '**AI insights** banner and **Purchasing AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Show **To Reorder** and **Zero Stock**.',
            'Open **Supplier Risks** — the least reliable suppliers.',
            'Open **Order Impact** — customer orders that need attention.',
          ] },
        ],
      } },
    { nav: 'nav-rush-orders', panel: 'rush-orders-panel', title: 'Rush Order Prioritisation Agent', name: 'Rush Orders', color: '#991B1B',
      about: {
        summary: 'Scores every open sales order 0–100 for urgency, compares the cost of expediting with the revenue at risk, and recommends whether to approve expediting, hold, or escalate — with optional SAP Activity alerts.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Handle the right orders first** — a clear, objective urgency ranking.',
            '**Spend expedite money wisely** — cost vs revenue at risk for each order.',
            '**Fast escalation** — high-value urgent orders go to the right manager.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Operations / Logistics** — a daily priority list.',
            '**Sales** — key customers and big orders protected.',
            '**Management** — controlled expedite cost and revenue protected.',
          ] },
          { title: 'How the score is built (SAP Business One data)', items: [
            '**Days to due date** (up to 40 points), **order priority** (20, from a priority field such as U_Priority — if there is none its points are spread over the other factors), **order value** (20), **customer tier** (20: VIP 20, high-tier group 15, others 5).',
            '**Tags:** CRITICAL ≥ 75, URGENT ≥ 55, MONITOR ≥ 35, otherwise NORMAL.',
            '**Expedite** auto-approved when cost is within your limit; otherwise escalated (Sales Director for score ≥ 85, else Operations Manager).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Settings** — Urgent within (days), Max expedite cost, Create SAP Alerts, Dry Run, and **★ Customer tiers** (VIP customers and high-tier customer groups).',
            '**KPI tiles** — Scanned, Critical, Urgent, Auto-Approved, Expedite Cost, Revenue Protected.',
            '**Orders table** — score, tag, AI recommendation, expedite cost, escalate to; click score to see how it was calculated.',
            '**Action** (Critical/Urgent) — revenue at risk, margin impact, **Approve Expedite + Alert** or **Hold / Monitor**.',
            '**AI Escalation Report** and **Rush Order AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Keep **Dry Run** on, click **Scan Orders**.',
            'Show the **Critical** tile and top orders; click a score to explain it.',
            'Open **Action** on one order and show cost vs revenue at risk.',
            'Show the **AI Escalation Report**.',
          ] },
        ],
      } },
    { nav: 'nav-shipment-delay', panel: 'shipment-delay-panel', title: 'Shipment Delay Prediction', name: 'Shipment Delays', color: '#7C3AED',
      about: {
        summary: 'Predicts how likely each open purchase order is to arrive late, based on the vendor\'s delivery history and how close the due date is. It rates every vendor on what is open today and how it actually delivered (goods receipts vs PO due dates), shows when goods are due in week by week, lists the customer orders and production orders that will be hit, and drafts the expediting e-mail to the vendor.',
        sections: [
          { title: 'Why use this agent', items: [
            '**See delays before they happen** — a delay probability on every open PO.',
            '**Protect customer commitments** — sales orders depending on late POs are listed.',
            '**Keep production running** — production orders that will stop for lack of a component on a late PO are flagged before their start date.',
            '**Fact-based vendor reviews** — real on-time %, days late and lead time from goods receipts, plus a delivery-by-delivery delay history.',
            '**Expedite faster** — one click drafts a follow-up e-mail with the vendor\'s overdue and upcoming POs.',
            '**Plan inbound** — see how much PO value is due each week and how much of it is at risk.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing / Expediting** — chase the right vendors early, with the PO list ready in the e-mail.',
            '**Warehouse / Planning** — know what is arriving in the coming weeks and what may slip.',
            '**Production** — see which orders are short of components and reschedule or expedite in time.',
            '**Sales / Customer service** — warn customers in advance.',
            '**Management / Vendor review** — on-time %, lead time and spend share per vendor, exportable to Excel.',
          ] },
          { title: 'How it works (SAP Business One data)', items: [
            '**All data is read through DB Direct** (SQL on the SAP database) — configure it under Tools → DB Connection.',
            '**Purchase orders (OPOR / POR1)** — all open POs, and POs of the last 6 months for the overdue rate.',
            '**Goods receipts (OPDN / PDN1)** copied from POs — actual delivery vs due date (PO line ship date, else PO due date).',
            '**Open sales orders (ORDR / RDR1)** due in the next 60 days — up to 300 orders against 200 risky POs.',
            '**Production orders (OWOR / WOR1)** planned or released, due in the next 60 days, and **stock on hand (OITM)** — STOP when the component is short and the PO arrives after the start date, AT RISK when short, COVERED when stock covers it.',
            '**Vendor master (OCRD)** — e-mail, contact person and phone for the follow-up e-mail.',
            '**Delay probability:** overdue POs 90% + 0.3% per day late; others = vendor overdue rate × urgency (×2.2 when due in ≤ 2 days … ×0.4 after 21 days) + 5%.',
            '**PO risk:** Critical ≥ 80% or already overdue, High ≥ 50%, Medium ≥ 25%.',
            '**Vendor reliability** from the overdue rate: Reliable → Generally On-Time → Occasionally Late → Frequently Delayed → Unreliable.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Open POs, At-Risk POs, Critical, High Risk, SOs Impacted, Prod. Orders Impacted, Risky Vendors. Click a tile for its data summary, chart, calculation and AI insight.',
            '**Shipment Risk** — PO, vendor, due date, days left, delay probability, risk, value.',
            '**Vendor Reliability** — filters (vendor, risk, reliability, open / overdue only) and CSV export; open POs and value, overdue, at risk, next due, on-time %, lead time, delay history, overdue rate, spend share, rating.',
            '**Vendor drill-down** — click a vendor row for its open POs and item lines; **⏱ Delay History** shows every delivery of the last 12 months with a monthly on-time trend.',
            '**✉ Follow up** — editable expediting e-mail; copy it or open it in your mail app (nothing is sent automatically).',
            '**SO Impact** — customer orders depending on delayed POs, with quantity, PO and PO due date.',
            '**Production Impact** — production orders short of a component on a delayed PO: still to issue, on hand, PO due vs start date, filter by STOP / AT RISK / COVERED.',
            '**Inbound Schedule** — open PO value due per week (overdue, next 8 weeks, later) with the at-risk share; click a week for its POs.',
            '**AI advisory** banner and **Shipment Delay AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Click **Scan** — show At-Risk POs and SOs Impacted; click a KPI tile for its breakdown.',
            'Open **Shipment Risk** sorted by delay probability.',
            'Open **Vendor Reliability**, filter to overdue vendors and expand the worst one.',
            'Click **⏱ Delay History** for that vendor, then **✉ Follow up** to draft the e-mail.',
            'Open **Inbound Schedule** to show what arrives in the next weeks, then **SO Impact** and **Production Impact** (STOP lines first).',
          ] },
        ],
      } },

    // ── OCR Processing ─────────────────────────────────────────────────────
    { nav: 'nav-ocr-po-scan', panel: 'ocr-po-scan-panel', header: '.owb-top', title: 'Purchase Order Scan Agent', name: 'Scan PO', color: '#6366f1',
      about: {
        summary: 'Turns a supplier\'s quotation or purchase-order document (PDF or photo) into an SAP Purchase Order. AI reads the document, matches the vendor and items to SAP, and shows the original next to the ready-to-post PO so you only check and correct — no retyping.',
        sections: [
          { title: 'Why use this agent', items: [
            '**No manual data entry** — vendor, dates, items, quantities and prices are read automatically.',
            '**Fewer errors** — every field is compared with the document and with SAP master data.',
            '**Faster purchasing** — a PO is posted in a minute instead of being keyed line by line.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing team** — more time for buying, less for typing.',
            '**Finance / Audit** — every scanned document is logged and linked to the posted PO.',
            '**Data quality** — items not in SAP are flagged instead of being guessed.',
          ] },
          { title: 'What it reads and checks', items: [
            '**Accepts:** PDF, JPG, PNG, WEBP (max 15 MB).',
            '**Reads:** document no., date, vendor, currency and each line (item, description, qty, unit, price, total).',
            '**Checks in SAP:** vendor (business partner), item master, warehouses, tax codes and exchange rate.',
            '**Creates:** an SAP **Purchase Order**.',
          ] },
          { title: 'What you see on the screen', items: [
            '**Left:** the original document. **Right:** the SAP PO form (header + item lines).',
            '**Match Score** — overall % with verdict **Ready / Review / Fix needed**, plus a bar per check: Vendor, Items, Quantities, Unit prices, Total, Header details. Green ≥ 90%, amber 70–89%, red < 70%.',
            '**Items table** — "On document" vs SAP item, with status Matched / Check match / Not in SAP.',
            '**Post Purchase Order to SAP** — after posting, the PO number and document entry are shown.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Drag a supplier PO/quotation onto the upload area.',
            'Show the document on the left and the filled PO on the right.',
            'Point to the **Match Score** and fix any amber/red line (pick the right SAP item).',
            'Click **Post Purchase Order to SAP** and show the new PO number.',
          ] },
        ],
      } },
    { nav: 'nav-ocr-expense', panel: 'ocr-expense-panel', header: '.owb-top', title: 'Expense Invoice Scan Agent', name: 'Scan Expense Invoice', color: '#f59e0b',
      about: {
        summary: 'Books non-stock expense bills — telephone, courier, rent, professional fees and similar — straight into SAP. AI reads the bill, suggests the vendor, G/L expense account and tax code, and posts a service-type A/P Invoice after your review.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Clear the expense pile fast** — no typing of vendor, amounts or tax.',
            '**Right account every time** — G/L expense account and tax code are suggested per line.',
            '**Totals are verified** — net, tax and total on the form are compared with the bill.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Accounts payable** — faster month-end and fewer posting errors.',
            '**Finance** — expenses booked on time, to the correct accounts.',
            '**Audit** — each scanned bill is stored and linked to the posted invoice.',
          ] },
          { title: 'What it reads and checks', items: [
            '**Reads:** invoice no., invoice/due date, vendor, expense category, currency, line amounts, tax and grand total.',
            '**Checks in SAP:** vendor, G/L expense accounts, tax codes (rate matched to the bill).',
            '**Creates:** an SAP **A/P Invoice (service type)** posted to G/L accounts.',
          ] },
          { title: 'What you see on the screen', items: [
            '**Left:** the bill. **Right:** A/P Invoice header and **Expense Lines** (description, G/L account, tax code, net, tax, gross).',
            '**Totals — form vs. invoice** — Net, Tax and Total each marked "Matches" or showing the difference.',
            '**Match Score** — Vendor, G/L accounts, Net, Tax, Total, Header details.',
            '**Post A/P Invoice to SAP** — shows the invoice number and SAP total after posting.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Upload a telephone or courier bill.',
            'Show the suggested **G/L account** and **tax code** on each line.',
            'Show **Totals — form vs. invoice** all matching.',
            'Click **Post A/P Invoice to SAP**.',
          ] },
        ],
      } },
    { nav: 'nav-ocr-apinv', panel: 'scan-apinv-panel', title: 'Scan A/P Invoice', name: 'Scan A/P Invoice', color: '#1d4ed8',
      about: {
        summary: 'Performs a three-way match — Purchase Order → Goods Receipt (GRPO) → Supplier Invoice. You pick the open GRPO, upload the supplier\'s invoice, and the agent compares every line\'s quantity and price before posting the A/P Invoice linked to that GRPO.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Pay only for what was received** — invoice quantities must match the goods receipt.',
            '**Catch overcharging** — price differences above 2% are flagged.',
            '**No retyping** — the invoice is read by OCR and posted from the GRPO.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Accounts payable** — faster, controlled invoice processing.',
            '**Finance / Audit** — a documented three-way match for every supplier invoice.',
            '**Purchasing** — quick visibility of supplier billing errors.',
          ] },
          { title: 'What it reads and checks', items: [
            '**Reads:** invoice no., dates, vendor, currency, line items (qty, price, tax) and totals.',
            '**Checks in SAP:** open GRPOs for the vendor; pairs invoice lines with GRPO lines by item code / description.',
            '**Rules:** quantity must match exactly; price may differ by up to 2%.',
            '**Creates:** an SAP **A/P Invoice** copied from the GRPO (fully linked).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Guided chat** on the left — select GRPO → upload invoice → review → post.',
            '**Match table** — GRPO qty vs invoice qty, GRPO price vs invoice price, with status: Match, Price Δ, Qty Mismatch, Not Invoiced, Extra Line.',
            '**Invoice Summary** sidebar — GRPO and match details, invoice total vs GRPO total.',
            '**A/P Invoice — Review & Post** form (red rows = mismatch) and **Post A/P Invoice**, then print.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Pick an open **GRPO** from the vendor list.',
            'Upload the supplier invoice.',
            'Show the **match table** — any Price Δ or Qty Mismatch in red.',
            'Open the form, review and click **Post A/P Invoice**.',
          ] },
        ],
      } },
    { nav: 'nav-ocr-inward', panel: 'ocr-inward-panel', header: '.owb-top', title: 'Inward Register Agent', name: 'Scan Inward', color: '#16a34a',
      about: {
        summary: 'Digitises the inward register at the stores/gate. Upload the supplier\'s delivery challan; AI reads it, matches supplier, items and the open Purchase Order in SAP, warns about duplicates and over-deliveries, and saves the entry to the Inward Register.',
        sections: [
          { title: 'Why use this agent', items: [
            '**No handwritten register** — challans are captured in seconds.',
            '**Catch over-supply** — received qty is checked against the PO open qty.',
            '**Avoid double entry** — duplicate challans are detected.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Stores / Security** — quick, accurate inward logging.',
            '**Purchasing** — knows which deliveries arrived against which PO.',
            '**Accounts** — a reliable record before GRPO and invoice posting.',
          ] },
          { title: 'What it reads and checks', items: [
            '**Reads:** challan no. and date, vehicle no., driver, supplier, PO reference and material lines (item, qty, unit).',
            '**Checks in SAP:** supplier, warehouse, items, and the supplier\'s **open POs** (auto-linked from the PO reference).',
            '**Flags:** "Over PO by N", "Not on PO", possible duplicate challan.',
            '**Saves to:** the Inward Register (no SAP document is posted).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Left:** the challan. **Right:** Inward Entry (challan, vehicle, driver, supplier, warehouse, against PO).',
            '**Materials Received** — document item vs SAP item, qty received, PO open qty, match.',
            '**Match Score** — Duplicate check, Challan details, Supplier, Materials, PO link, Quantities vs PO.',
            '**Save to Inward Register** — shows the register entry number.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Upload a delivery challan.',
            'Show the **PO auto-linked** and PO open qty next to received qty.',
            'Point out any **Over PO** warning.',
            'Click **Save to Inward Register**.',
          ] },
        ],
      } },
    { nav: 'nav-ocr-gatepass', panel: 'ocr-gatepass-panel', header: '.owb-top', title: 'Gate Pass Register Agent', name: 'Scan Gate Pass', color: '#0891b2',
      about: {
        summary: 'Digitises security-gate passes for visitors, vehicles and materials. Upload or photograph a gate pass; AI reads it, checks the details, links the company to an SAP business partner where possible, and saves it to the Gate Pass Register.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Paperless gate register** — searchable instead of a paper book.',
            '**Complete records** — required fields and in/out times are validated.',
            '**No duplicates** — the same pass cannot be logged twice by mistake.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Security** — quick, consistent logging of every movement.',
            '**Administration / Compliance** — reliable record of who and what entered or left.',
            '**Stores** — material passes are traceable.',
          ] },
          { title: 'What it reads and checks', items: [
            '**Reads:** pass no., date, type (visitor / vehicle / material), direction (in / out), person or vehicle, company, purpose, material, time in/out, authorised by.',
            '**Checks:** company against SAP customers/vendors/leads (optional), duplicate pass, time out not before time in.',
            '**Saves to:** the Gate Pass Register (no SAP document is posted).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Left:** the gate pass. **Right:** the Gate Pass form.',
            '**Match Score** — Duplicate check, Required details, In/out times, Company in SAP, Material details.',
            '**Save to Gate Pass Register** — shows the register entry.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Upload a visitor or material gate pass.',
            'Show the fields filled automatically and the **Match Score**.',
            'Click **Save to Gate Pass Register**.',
          ] },
        ],
      } },
    { nav: 'nav-ocr-document', panel: 'ocr-document-panel', title: 'Document Mode Agent', name: 'Scan Document Mode', color: '#64748b',
      about: {
        summary: 'A single entry point for any document when you are not sure what it is. Upload it; AI summarises it, suggests the document type, and lets you send it to the right agent (Purchase Order, Expense Invoice, A/P Invoice, Inward, Gate Pass) or simply archive it.',
        sections: [
          { title: 'Why use this agent', items: [
            '**One inbox for paperwork** — staff do not need to know which screen to use.',
            '**AI classification** — the document type is suggested automatically.',
            '**Nothing gets lost** — every document is recorded, even if only archived.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Front office / Mailroom** — quick triage of incoming documents.',
            '**Finance & Purchasing** — documents reach the right workflow faster.',
          ] },
          { title: 'What it reads', items: [
            '**Accepts:** PDF, JPG, PNG, WEBP (max 15 MB).',
            '**Reads:** title, document no., date, parties, amounts and a short summary.',
            '**Saves:** a classified document record. Nothing is posted to SAP from this screen.',
          ] },
          { title: 'What you see on the screen', items: [
            '**Extracted Document** table — Title, Doc #, Date, Parties, Amounts, AI Suggested Type, Summary.',
            '**Route buttons** — Purchase Order, Expense Invoice, A/P Invoice, Inward, Gate Pass, Archive Only.',
            '**Classification** sidebar with the result and record number.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Upload an unknown document.',
            'Show the AI summary and the **suggested type**.',
            'Click the matching route button and open that agent to process it.',
          ] },
        ],
      } },

    // ── Sales & Pricing ────────────────────────────────────────────────────
    { nav: 'nav-dynamic-pricing', panel: 'dynamic-pricing-panel', title: 'Dynamic Pricing Agent', name: 'Dynamic Pricing', color: '#F59E0B',
      about: {
        summary: 'Recommends whether to increase, decrease or hold the price of each item in a selected SAP price list, based on demand, stock level and gross margin against your target. Approved prices can be written back to the SAP price list in one click.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Improve margin** — items selling well below target margin are flagged for an increase.',
            '**Clear excess stock** — overstock and dead stock get a price cut suggestion.',
            '**Capture demand** — high-demand or short items can carry a higher price.',
            '**Explainable** — every suggestion shows the factors behind it.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Management** — pricing decisions driven by data, not habit.',
            '**Sales** — consistent, defensible price lists.',
            '**Finance / Inventory** — better margin and less money tied up in slow stock.',
          ] },
          { title: 'Where the data comes from (SAP Business One)', items: [
            '**Items** — stock on hand, min/max inventory, average cost.',
            '**Sales history** — quantities sold and average selling price.',
            '**Price lists** — current prices; updated when you click Apply.',
            '**9 pricing rules, checked in order** — Price establishment (cost ÷ (1 − target)), Dead stock −15%, Discount recovery, Margin recovery (more than 10% below target), Shortage +8%, Demand capture +5%, Margin improvement (2–10% below target), Overstock clearance −7%, Market alignment +8% — otherwise Balanced (hold).',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Price Increase, Price Decrease, Hold Price, Avg Price Change, Total Items.',
            '**Table** — Item, Group, Avg Selling Price, Suggested Price, Change %, Recommendation; filter All / Increase / Decrease / Hold.',
            '**Item detail** — demand, inventory, margin and competitor factors, with **Apply** to update the SAP price list.',
            '**How Pricing Scenarios Are Calculated** — the rule table, and **Pricing AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Select a **Price List**, set **Margin Target %**, click **Analyse**.',
            'Show the KPI split — increases vs decreases.',
            'Open one item\'s **Details** to explain the reasoning.',
            'Click **Apply** to update the SAP price (on a demo company).',
          ] },
        ],
      } },
    { nav: 'nav-order-intelligence', panel: 'order-intelligence-panel', title: 'Order Intelligence', name: 'Order Intelligence', color: '#C2410C',
      about: {
        summary: 'Checks every open sales order due in the next 60 days against available stock and flags the orders that may not be delivered on time because items are short. Orders are ranked by severity with an AI advisory on what to do.',
        sections: [
          { title: 'Why use this agent', items: [
            '**No delivery surprises** — know today which orders are at risk.',
            '**Act early** — expedite purchases or reallocate stock before the due date.',
            '**See the bottleneck items** — the few items causing most of the risk.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Sales / Customer service** — inform customers proactively.',
            '**Purchasing / Production** — prioritise the items that block orders.',
            '**Management** — value of revenue at risk.',
          ] },
          { title: 'Where the data comes from (SAP Business One)', items: [
            '**Open sales orders** due within 60 days and their lines.',
            '**Item stock** — on hand, committed and on order (open POs).',
            '**Coverage %** = on hand ÷ committed. **CRITICAL** = no stock, **HIGH** = under 50%, otherwise MEDIUM.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — SOs Checked, At-Risk Orders, Critical, High Risk, Value at Risk, Short Items.',
            '**At-Risk Orders** — SO #, customer, due date, days left, value, coverage, short items, risk (with detail drawer).',
            '**Stock Shortfalls** — item, on hand, committed, shortage, on order, affected SOs.',
            '**AI advisory** banner and **Order Intelligence AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Open the agent (it scans automatically) — show **Value at Risk**.',
            'Filter **Critical** orders and open one detail.',
            'Switch to **Stock Shortfalls** — the items to expedite.',
            'Ask AI: "Bottleneck items" or "Recommendations".',
          ] },
        ],
      } },
    { nav: 'nav-product-forecast', panel: 'product-forecast-panel', title: 'Product Forecasting Agent', name: 'Product Forecasting', color: '#0D3B6B',
      about: {
        summary: 'Forecasts monthly demand for every item in an item group from 1–3 years of SAP sales history, using trend and seasonality. It classifies items as Growing, Stable or Declining and warns which items will run out of stock.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Plan stock ahead** — 3- and 12-month demand per item.',
            '**Spot trends** — growing and declining products at a glance.',
            '**Avoid stock-outs** — weeks of stock cover vs forecast demand.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Purchasing / Production** — buy and produce to expected demand.',
            '**Sales & Marketing** — focus on growing products, act on declining ones.',
            '**Finance** — better inventory planning and budgeting.',
          ] },
          { title: 'Where the data comes from (SAP Business One)', items: [
            '**Sales history** by item and month (1, 2 or 3 years).',
            '**Items** — stock on hand, min/max inventory, cost, item group.',
            '**Model** — trend × seasonal index. Trend > +8% = Growing, < −8% = Declining.',
            '**Stock-out risk** — under 4 weeks cover = HIGH, under 10 weeks = MEDIUM.',
          ] },
          { title: 'What you see on the screen', items: [
            '**KPI tiles** — Total Products, Growing, Stable, Declining, Stockout Risk, 12-Month Forecast.',
            '**Table** — Avg Monthly, 3-Month FC, 12-Month FC, Trend, Stock Cover, Risk, Confidence.',
            '**Item detail** — history and forecast charts with monthly breakdown.',
            '**AI Market Demand Analysis** and **Forecast AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Choose an item group, History 2 years, Forecast 12 months, click **Analyse**.',
            'Show the Growing / Declining / Stockout Risk tiles.',
            'Filter **High Risk** and open one item\'s forecast chart.',
            'Ask AI: "Replenish now".',
          ] },
        ],
      } },
    { nav: 'nav-mail-po', panel: 'mail-po-panel', header: '.wf-header', title: 'Mail PO → SO', name: 'Mail PO → SO', color: '#22c55e',
      about: {
        summary: 'Watches your sales email inbox for customer purchase orders (PDF attachments), reads them with AI and turns them into SAP Sales Orders — automatically when the monitor is running, or after you review each one side by side with the PDF.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Orders entered in minutes** — no retyping customer POs from email.',
            '**Nothing missed** — every PO email in the inbox is picked up.',
            '**Checked before posting** — customer, items, units and availability are matched to SAP.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Sales order desk** — handles more orders with the same team.',
            '**Customers** — faster order confirmation.',
            '**Management** — a full activity log of every order processed.',
          ] },
          { title: 'How it works', items: [
            '**Reads:** customer PO PDFs from the configured mailbox (IMAP).',
            '**Checks in SAP:** customer (business partner, credit), items, units of measure, warehouse, stock availability.',
            '**Creates:** an SAP **Sales Order**.',
          ] },
          { title: 'What you see on the screen', items: [
            '**Inbox** tab — Scan Inbox, Start / Stop Monitor, email list (From, Subject, Date, PDF, Open).',
            '**Review** — PDF on one side, Sales Order form on the other.',
            '**Settings** tab — email configuration (IMAP/SMTP, address, app password, poll interval) with Save & Test Connection.',
            '**Activity** tab — log of processed emails. Header shows **Running / Stopped**.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Show the **Settings** tab (mailbox configured).',
            'On **Inbox**, click **Scan Inbox** and open a PO email.',
            'Review the PDF vs the Sales Order form and create the order.',
            'Show the **Activity** log, then **Start Monitor** for automatic processing.',
          ] },
        ],
      } },
    { nav: 'nav-po-workflow', panel: 'workflow-panel', header: '.wf-header', title: 'PO → Sales Order', name: 'PO → Sales Order', color: '#0f766e',
      about: {
        summary: 'Upload a customer\'s purchase order PDF and the agent guides it to an SAP Sales Order in four checked steps: read the PO, find the customer, check the credit limit, and check item availability (ATP).',
        sections: [
          { title: 'Why use this agent', items: [
            '**Fast order entry** — the PO is read automatically.',
            '**Credit control built in** — orders that would exceed the credit limit are flagged before posting.',
            '**Promise only what you can deliver** — stock availability is checked per line.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Sales team** — orders posted correctly the first time.',
            '**Finance** — credit policy applied on every order.',
            '**Warehouse** — fewer orders that cannot be fulfilled.',
          ] },
          { title: 'Checks performed (SAP Business One)', items: [
            '**Customer** — matched to the SAP business partner.',
            '**Credit** — balance + open orders + this order vs credit limit (warning above 80%, blocked above 100%).',
            '**ATP** — available = in stock − committed; each line is OK / Partial / None / Not found, with item suggestions for unmapped lines.',
            '**Creates:** an SAP **Sales Order**.',
          ] },
          { title: 'What you see on the screen', items: [
            '**Upload area** for the customer PO PDF.',
            '**4 step cards** — Parse Purchase Order, Find Customer in SAP B1, Credit Limit Check, Item Availability (ATP).',
            '**Review** section, then **Create Sales Order in SAP B1**.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Upload a customer PO PDF.',
            'Walk through the 4 step cards as they turn green / amber.',
            'Map any unmatched item, then click **Create Sales Order in SAP B1**.',
          ] },
        ],
      } },

    // ── CRM ────────────────────────────────────────────────────────────────
    { nav: 'nav-activity-agent', panel: 'activity-agent-panel', title: 'Activity Agent', name: 'Activity Agent', color: '#7c3aed',
      about: {
        summary: 'Finds customers, sales orders and service calls with no recent follow-up and automatically logs SAP Activities for them. You can also create activities manually and review or close all activities in one list.',
        sections: [
          { title: 'Why use this agent', items: [
            '**No customer forgotten** — inactive accounts and orders are found automatically.',
            '**Consistent CRM records** — follow-ups are logged in SAP, linked to the right document.',
            '**Plan the week** — orders due soon and open service calls in one view.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Sales & Service teams** — clear follow-up list.',
            '**Management** — visibility of customer engagement.',
            '**Customers** — timely updates and better service.',
          ] },
          { title: 'Where the data comes from (SAP Business One)', items: [
            '**Service calls** and **open sales orders** (by due date).',
            '**Activities** — last contact per customer/document.',
            '**Creates / closes:** SAP **Activities** (phone call, meeting, task, note).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Scan & Auto-Log** — settings (orders due within, inactive days), KPIs (Scanned, Needs Activity, Service Calls, Orders, Created) and a list with last activity and inactive days.',
            '**Create Activity** — form linked to a customer and document.',
            '**Activity List** — filter by customer, date and status; close activities.',
            '**AI Activity Recommendations** and **Activity Agent AI** chat.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Click **Scan Now** — show **Needs Activity**.',
            'Tick **Create in SAP** and scan again to auto-log activities.',
            'Open **Activity List** to show them in SAP.',
            'Ask AI: "Orders due this week".',
          ] },
        ],
      } },
    { nav: 'nav-prompt-activity', panel: 'prompt-activity-panel', title: 'Prompt Activity', name: 'Prompt Activity', color: '#db2777',
      about: {
        summary: 'Log a CRM activity by simply describing it in plain English — e.g. "Called ABC Ltd about overdue invoice 1234, follow up Friday". AI extracts the customer, type, dates, linked document and notes; you review and post it to SAP as an Activity.',
        sections: [
          { title: 'Why use this agent', items: [
            '**Log activities in seconds** — type one sentence instead of filling a form.',
            '**More activities get recorded** — less effort means better CRM discipline.',
            '**Accurate links** — activity is linked to the customer and document.',
          ] },
          { title: 'How it helps the organisation', items: [
            '**Sales & Service staff** — quick logging, even on the move.',
            '**Management** — complete customer interaction history in SAP.',
          ] },
          { title: 'How it works', items: [
            '**Input:** a plain-English description.',
            '**AI extracts:** customer code, activity type, priority, activity and follow-up dates, document type and number, subject, notes.',
            '**Creates:** an SAP **Activity** linked to the customer (and sales order / invoice / quotation / service call / PO if mentioned).',
          ] },
          { title: 'What you see on the screen', items: [
            '**Left:** "Describe the activity" box, **Parse with AI** and example prompts.',
            '**Right:** confidence bar, missing-field warning and the editable extracted fields.',
            '**Post to SAP** button.',
          ] },
          { title: 'Suggested demo flow', ordered: true, items: [
            'Click an example prompt (or type your own).',
            'Click **Parse with AI** — show the fields filled automatically.',
            'Correct anything if needed and **post to SAP**.',
          ] },
        ],
      } },
  ];

  // Header = the panel's first child. Put the button after the header child that
  // holds the title; if the title is not found, right after the Back button.
  function addButton(cfg) {
    const panel = document.getElementById(cfg.panel);
    if (!panel || panel.querySelector('.aa-btn')) return;
    const hdr = cfg.header ? panel.querySelector(cfg.header) : panel.firstElementChild;
    if (!hdr) return;
    injectCss();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aa-btn';
    btn.title = 'What this agent does and how to read it';
    btn.innerHTML = `${INFO_SVG}About`;
    btn.onclick = e => { e.stopPropagation(); open(cfg.name, cfg.about, cfg.color); };
    const leaf = [...hdr.querySelectorAll('*')].find(el => !el.children.length && el.textContent.trim() === cfg.title);
    let anchor = leaf;
    while (anchor && anchor.parentElement !== hdr) anchor = anchor.parentElement;
    if (anchor) anchor.after(btn);
    else (hdr.querySelector('button') ? hdr.querySelector('button').after(btn) : hdr.appendChild(btn));
  }
  const addAll = () => PANELS.forEach(addButton);

  // Panels are static markup in index.html, but some are moved or re-rendered,
  // so (re)add whenever an agent's menu item is clicked, and once on load.
  document.addEventListener('click', e => {
    const nav = e.target.closest?.('.nav-subitem[id], .nav-item[id]');
    const cfg = nav && PANELS.find(p => p.nav === nav.id);
    if (cfg) setTimeout(() => addButton(cfg), 0);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addAll); else addAll();
  window.addEventListener('load', addAll);

  window.AgentAbout = { open, panels: PANELS, refresh: addAll };
})();
