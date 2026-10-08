// ══════════════════════════════════════════════════════════════════════════════
// AGENT KPI HELP — "what does this number mean?" for the standalone agent screens.
//
// Click any KPI tile (or its small ⓘ) to see what it means, exactly how it is
// calculated, which SAP Business One data it comes from, its current value and
// how to act on it. Table headers get a tooltip + dotted underline, and each
// table gets an "ⓘ Column guide" link (clicking a header opens the same guide).
//
// Self-contained: nothing in index.html / insight-agents.js is changed. Popups
// are rendered by window.AgentAbout.open (agent-about.js). Tiles are found by
// the id of their value element; headers by their text. Everything is attached
// with event delegation on the panel, and re-applied after the agents re-render.
//
// The formulas below mirror the backend controllers (controllers/*.mjs) and the
// panel JS in index.html — keep them in sync when a calculation changes.
// ══════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const PANELS = {

    // ─────────────────────────────────────────────────────────────── MRP AUTO-PO
    'mrp-auto-po-panel': {
      name: 'MRP Auto-PO', color: '#2563EB',
      kpis: {
        'mrp-kpi-critical': {
          label: 'Critical Items',
          means: 'Purchased items that are below their minimum stock level **and have no free stock left at all**. These can stop sales or production right now.',
          calc: [
            '**Available** = In stock − Committed to customer orders.',
            '**Projected** = Available + Already on order from vendors.',
            'An item is in the MRP result when **Projected < Minimum stock**.',
            'It is **Critical** when **Available ≤ 0**.',
            'Count = number of MRP items with urgency Critical.',
          ],
          source: [
            '**Item master (OITM):** In Stock (OnHand), Committed (IsCommited), Ordered (OnOrder), Minimum level (MinLevel), Maximum level.',
            'Only **purchase items** with a **minimum stock level above 0** are checked. Figures are company-wide (all warehouses together).',
          ],
          action: ['Order these first: select them on **Items & Vendors** and click **Build Draft POs**.'],
          current: ['Updated each time you click **Run MRP**. The Urgency filter on the table does not change the tiles.'],
        },
        'mrp-kpi-high': {
          label: 'High Priority',
          means: 'Items below minimum that still have some stock, but the shortfall is large (70% or more of the minimum).',
          calc: [
            '**Gap** = Minimum stock − (Available + On order).',
            '**High** when Available > 0 and **Gap ÷ Minimum ≥ 70%**.',
            'Count = number of MRP items with urgency High.',
          ],
          source: ['**Item master (OITM):** OnHand, IsCommited, OnOrder, MinLevel (purchase items with a minimum level).'],
          action: ['Reorder soon — include them in the next draft POs after the Critical items.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-total': {
          label: 'Total Items',
          means: 'All items whose projected stock (free stock + incoming) is below the minimum stock level — Critical, High and Medium together.',
          calc: [
            'Count of items where **Available + On order < Minimum stock**.',
            'Urgency split: **Critical** = Available ≤ 0 · **High** = Gap ≥ 70% of minimum · **Medium** = everything else.',
          ],
          source: ['**Item master (OITM):** OnHand, IsCommited, OnOrder, MinLevel, MaxLevel.'],
          action: ['Work through the list on **Items & Vendors**. Items already sitting in an unposted draft PO are counted here but hidden in the table, so the table can show fewer rows.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-drafts': {
          label: 'Draft POs',
          means: 'Purchase-order drafts prepared by the agent (one per vendor) that have **not yet been posted** to SAP.',
          calc: ['Count of saved drafts whose status is not "posted".'],
          source: ['Stored by this application (not yet in SAP). Vendor, payment terms and last purchase price come from SAP: **OCRD**, **OCTG**, **OITM**.'],
          action: ['Open **Draft POs**, check quantities and prices, then **Post to SAP**.'],
        },
        'mrp-kpi-approvals': {
          label: 'Pending Approval',
          means: 'Documents waiting in the SAP approval workflow (approval procedures).',
          calc: [
            'Count of SAP approval requests with status **Pending** (newest 50).',
            'All document types are counted, not only purchase orders.',
            'Shows "—" until you open the **Approval** tab or click **Check Approvals**.',
          ],
          source: ['**SAP approval requests** (approval stages / OWDD) via the Service Layer.'],
          action: ['Ask the approvers to approve in SAP; approved POs can then be emailed to the vendor.'],
        },
        'mrp-kpi-posted': {
          label: 'POs Posted',
          means: 'Purchase orders posted to SAP from this screen **in the current session**.',
          calc: ['Counts each successful "Post to SAP" since this page was loaded. It resets to 0 when the page is reloaded.'],
          source: ['The posted documents are **Purchase Orders (OPOR)** in SAP.'],
          action: ['Use **Email Vendor** to send each posted PO, and check the **Audit Log** for the history.'],
        },
      },
      tables: [
        {
          tbody: 'mrp-items-tbody', title: 'MRP — Items & Vendors',
          summary: 'Items whose projected stock is below the minimum, with the preferred vendor and last purchase price, ready to turn into draft POs. Click the Urgency, Gap or Reorder Qty value in a row to see that row\'s calculation.',
          cols: {
            'Item': 'Item code (OITM).',
            'Description': 'Item name (OITM).',
            'Urgency': '**Critical** = no free stock (Available ≤ 0) · **High** = Gap ≥ 70% of minimum · **Medium** = otherwise.',
            'Available': 'In stock − Committed to customer orders (OITM OnHand − IsCommited). Red when 0 or less.',
            'Min': 'Minimum stock level set on the item (OITM MinLevel).',
            'Gap': 'Minimum − (Available + On order). How far projected stock is below the minimum.',
            'Reorder Qty': 'If a maximum stock is set: Maximum − (Available + On order). If not: Gap × 2. Always at least 1.',
            'Vendor': 'Preferred vendor of the item (OITM → OCRD name). "No vendor" if none is set.',
            'Unit Price': 'Last purchase price of the item (OITM LastPurPrc); 0 if unknown.',
            'Est. Total': 'Unit Price × Reorder Qty.',
            'Payment Terms': 'Vendor\'s payment terms (OCRD → OCTG).',
            'Lead(d)': 'Lead time in days from the item master (OITM LeadTime); 7 when not set.',
          },
          notes: ['Items already in an unposted draft PO are not shown here.', 'Tick the checkbox to include an item in **Build Draft POs**.'],
        },
        {
          tbody: 'mrp-approval-tbody', title: 'MRP — Pending approvals',
          summary: 'Documents waiting for approval in SAP (status Pending).',
          cols: {
            'Code': 'Approval request number in SAP.',
            'Object Type': 'SAP document type code (22 = Purchase Order).',
            'Doc Entry': 'Internal SAP key of the document waiting for approval (not the document number).',
            'Status': 'Approval status — only Pending requests are listed.',
            'Remarks': 'Remarks entered on the approval request.',
            'Created': 'Date the approval request was created.',
          },
        },
      ],
    },

    // ──────────────────────────────────────────────────── STOCK REORDER MONITOR
    'procurement-agent-panel': {
      name: 'Stock Reorder Monitor', color: '#0070F2',
      kpis: {
        'proc-kpi-critical': {
          label: 'Critical Stock',
          means: 'Items below minimum stock with **no free stock left**.',
          calc: [
            '**Available** = In stock − Committed to customer orders.',
            'Item is listed when **Available < Minimum stock** (incoming POs are not counted here).',
            '**Critical** when **Available ≤ 0**.',
          ],
          source: ['**Item master (OITM):** OnHand, IsCommited, MinLevel — purchase items with a minimum level above 0, all warehouses together.'],
          action: ['Order immediately — tick them and click **Generate Draft POs** / **Create PR**.'],
          current: ['Recalculated on open / Refresh. Typing in the item search recounts the three priority tiles for the visible items.'],
        },
        'proc-kpi-high': {
          label: 'High Priority',
          means: 'Items below minimum that still have some stock, but the gap is 70% or more of the minimum.',
          calc: ['**Gap** = Minimum − Available.', '**High** when Available > 0 and **Gap ÷ Minimum ≥ 70%**.'],
          source: ['**Item master (OITM):** OnHand, IsCommited, MinLevel.'],
          action: ['Reorder soon, after the Critical items.'],
        },
        'proc-kpi-medium': {
          label: 'Medium Priority',
          means: 'Items below minimum where the gap is less than 70% of the minimum.',
          calc: ['Available > 0 and **Gap ÷ Minimum < 70%**.'],
          source: ['**Item master (OITM):** OnHand, IsCommited, MinLevel.'],
          action: ['Plan the reorder in the normal purchasing cycle.'],
        },
        'proc-kpi-sos': {
          label: 'Open Sales Orders',
          means: 'Number of open customer orders — the demand that is reserving (committing) stock.',
          calc: ['Count of sales order documents with status **Open**. Counts documents, not amounts. Shows "—" when 0.'],
          source: ['**Sales Orders (ORDR)**, DocStatus = Open.'],
          action: ['Context: high open demand means committed stock will keep rising.'],
        },
        'proc-kpi-pos': {
          label: 'Open Purchase Orders',
          means: 'Number of open purchase orders — stock already on its way.',
          calc: ['Count of purchase order documents with status **Open**. Shows "—" when 0.'],
          source: ['**Purchase Orders (OPOR)**, DocStatus = Open.'],
          action: ['Check the **On Order** column before ordering more, to avoid double ordering.'],
        },
      },
      tables: [{
        tbody: 'proc-reorder-tbody', title: 'Stock Reorder Monitor',
        summary: 'Items whose free stock is below the minimum stock level, most urgent first. Click Priority, Gap or Reorder Qty in a row to see that row\'s calculation.',
        cols: {
          'Item Code': 'Item code (OITM). Click it to look the item up.',
          'Description': 'Item name (OITM).',
          'Priority': '**Critical** = Available ≤ 0 · **High** = Gap ≥ 70% of minimum · **Medium** = otherwise.',
          'Available': 'In stock − Committed (OITM OnHand − IsCommited). Red when 0 or less.',
          'Min Stock': 'Minimum stock level on the item (OITM MinLevel).',
          'Gap': 'Minimum − Available (shown as a negative number).',
          'On Order': 'Quantity already on open purchase orders (OITM OnOrder). Information only — not used in the gap.',
          'Reorder Qty': 'If a maximum is set: Maximum − Available − On order. If not: Gap × 2. At least 1.',
          'Lead (d)': 'Lead time in days (OITM LeadTime); "—" when not set.',
          'Preferred Vendor': 'Preferred vendor code on the item (OITM). "No vendor" if empty.',
          'Order Qty': 'Quantity you will order — starts at Reorder Qty and can be edited; used for Draft POs / PR.',
          'After Order': 'Available + Order Qty, compared with the minimum: **CRITICAL** (≤ 0), **BELOW MIN**, **OVER MAX** or **✓ OK**, plus % of minimum and the expected arrival date (today + lead time).',
        },
        labels: { 'Order Qty': 'Order Qty ✎' },
      }],
    },

    // ──────────────────────────────────────────────── PURCHASE THREE WAY MATCH
    'purchase-three-way-match-panel': {
      name: 'Purchase Three Way Match', color: '#8B5CF6',
      kpis: {
        'twm-po-total': {
          label: 'Total PO Amount',
          means: 'Total value of all purchase orders in the selected year (and vendor, if chosen) — what was ordered.',
          calc: ['Sum of PO document totals (incl. tax), open and closed, dated 1 Jan – 31 Dec of the selected year.', 'The line below shows the number of POs.'],
          source: ['**Purchase Orders (OPOR):** DocTotal, DocDate, CardCode.'],
          action: ['Baseline to compare goods received and invoiced against.'],
          current: ['Changes with **Year**, **Vendor** and the **Status** filter (the tiles add up only the vendors shown).'],
        },
        'twm-grpo-total': {
          label: 'Total GRPO Amount',
          means: 'Total value of goods receipts (GRPO) in the period — what was actually delivered.',
          calc: ['Sum of goods receipt document totals in the selected year / vendor. The line below shows the number of receipts.'],
          source: ['**Goods Receipt PO (OPDN):** DocTotal, DocDate.'],
          action: ['If much lower than the PO amount, deliveries are still outstanding.'],
        },
        'twm-inv-total': {
          label: 'Total AP Invoice',
          means: 'Total value of vendor invoices in the period — what you were billed.',
          calc: ['Sum of A/P invoice document totals in the selected year / vendor. The line below shows the number of invoices.'],
          source: ['**A/P Invoices (OPCH):** DocTotal, DocDate.'],
          action: ['Compare with POs and receipts before paying.'],
        },
        'twm-variance': {
          label: 'Net Variance',
          means: 'Difference between what was invoiced and what was ordered.',
          calc: [
            '**Net Variance = Total AP Invoice − Total PO Amount.**',
            '**Green** = within ±1 (matched) · **Red** = positive (invoiced more than ordered) · **Orange** = negative (invoiced less than ordered).',
          ],
          source: ['**OPCH** and **OPOR** document totals for the selected year / vendor.'],
          action: ['Red: check for over-billing or price differences. Orange: invoices are probably still to come.'],
        },
      },
      tables: [{
        tbody: 'twm-tbody', title: 'Purchase Three Way Match',
        summary: 'One row per vendor: what was ordered (PO), received (GRPO) and invoiced (A/P invoice) in the selected year, compared by total value. Click Variance, Match % or Status in a row for that row\'s calculation.',
        cols: {
          'Vendor': 'Vendor code and name.',
          'PO Docs': 'Number of purchase orders (OPOR).',
          'PO Amount': 'Sum of PO totals (OPOR DocTotal).',
          'GRPO Docs': 'Number of goods receipts (OPDN).',
          'GRPO Amount': 'Sum of goods receipt totals (OPDN DocTotal).',
          'Invoice Docs': 'Number of A/P invoices (OPCH).',
          'Invoice Amount': 'Sum of A/P invoice totals (OPCH DocTotal).',
          'Variance': 'Invoice Amount − PO Amount.',
          'Match %': 'Invoice ÷ PO × 100 (0 when no PO). Green ≥ 95%, orange ≥ 75%, red below 75%. Can be above 100%.',
          'Status': 'First rule that applies: **Matched** (variance within ±1) → **GRPO Pending** (an open PO and received < ordered) → **Inv Pending** (received > invoiced) → **Variance** (difference > 5% of PO) → otherwise **Matched** (within 5%).',
        },
        notes: ['Totals are compared per vendor per calendar year; documents are not linked one-to-one, so a PO in December invoiced in January looks unmatched in both years.', 'Amounts are document totals including tax.'],
      }],
    },

    // ───────────────────────────────────────────────────────── PRODUCTION AGENT
    'production-agent-panel': {
      name: 'Production Agent', color: '#0F766E',
      kpis: {
        'prod-kpi-total': {
          label: 'Total Open',
          means: 'Number of production orders that are not closed or cancelled (Planned or Released).',
          calc: ['Count of production orders whose status is not Closed / Cancelled.'],
          source: ['**Production Orders (OWOR):** Status, DueDate, PlannedQty, CmpltQty.'],
          action: ['Overview of the current production workload.'],
          current: ['Updated on open / Refresh. The risk, item and date filters only narrow the table, not the tiles.'],
        },
        'prod-kpi-critical': {
          label: 'Critical Risk',
          means: 'Production orders (not components) where at least one still-needed component has **no free stock at all**.',
          calc: [
            'Per component: **Still needed** = Planned − Issued; **Available** = In stock − Committed.',
            'Order is **Critical** when any component has Available ≤ 0 while still needed > 0.',
          ],
          source: ['**OWOR** (orders), **WOR1** (components: PlannedQty, IssuedQty), **OITM** (OnHand, IsCommited — all warehouses). Incoming purchase orders are not counted as available.'],
          action: ['Expedite or emergency-source the missing component, or reschedule the order.'],
        },
        'prod-kpi-high': {
          label: 'High Risk',
          means: 'Orders that are not critical, but where a short component is covered **less than 50%** by free stock.',
          calc: ['**Coverage** = Available ÷ Still needed × 100 (0–100%).', '**High** when any short component has coverage < 50%.'],
          source: ['**WOR1** + **OITM** as for Critical Risk.'],
          action: ['Raise a purchase request now and check that open POs arrive in time.'],
        },
        'prod-kpi-medium': {
          label: 'Medium Risk',
          means: 'Orders with a shortage where every short component is at least 50% covered.',
          calc: ['Any component with Shortage = Still needed − Available > 0, and none below 50% coverage.'],
          source: ['**WOR1** + **OITM**.'],
          action: ['Monitor and prepare backup sourcing.'],
        },
        'prod-kpi-dueweek': {
          label: 'Due This Week',
          means: 'Open production orders due from today up to 7 days ahead.',
          calc: ['Days left = due date − today (rounded up). Counted when **0 ≤ days left ≤ 7**.'],
          source: ['**OWOR.DueDate**.'],
          action: ['Confirm materials and capacity for these orders.'],
        },
        'prod-kpi-overdue': {
          label: 'Overdue',
          means: 'Open production orders whose due date has already passed.',
          calc: ['Days left < 0. Orders without a due date are not counted.'],
          source: ['**OWOR.DueDate**, open orders only.'],
          action: ['Complete or reschedule them in SAP.'],
        },
      },
      tables: [
        {
          tbody: 'prod-orders-tbody', title: 'Production orders',
          summary: 'Open production orders with their component-stock risk. Click the Risk badge in a row to see why it has that risk.',
          cols: {
            'Doc #': 'Production order number (OWOR DocNum). Click the row for details.',
            'Product': 'Finished item being produced (name and code).',
            'Planned Qty': 'Quantity of finished product to make (OWOR PlannedQty).',
            'Completed': 'Quantity completed so far, with % of planned.',
            'Due Date': 'Production order due date.',
            'Days Left': 'Due date − today. Negative = overdue (red); 0–3 orange; 4–7 amber.',
            'Risk': '**Critical** = a needed component has no free stock · **High** = a short component < 50% covered · **Medium** = some shortage · **On Track** = no shortage.',
            'Shortages': 'Number of components on this order that are short.',
            'Detail': 'Opens the order detail (overview, components & stock, costing).',
          },
        },
        {
          tbody: 'prod-shortage-tbody', title: 'Component shortages',
          summary: 'Components that are short across all open production orders, biggest shortage first (screen filters are not applied).',
          cols: {
            'Item Code': 'Component item code (WOR1).',
            'Description': 'Component name.',
            'Total Needed': 'Sum of still-needed quantity (Planned − Issued) on the orders where it is short.',
            'Available Stock': 'In stock − Committed (OITM). Red when 0 or less.',
            'Total Shortage': 'Sum of the shortages on each affected order (shown negative).',
            'Affected Orders': 'Production order numbers where this component is short.',
            'Severity': '**Critical** = no free stock · **High** = free stock < 50% of total needed · **Medium** = otherwise.',
          },
        },
      ],
    },

    // ─────────────────────────────────────────────────── PURCHASE RECOMMENDATION
    'purchasing-agent-panel': {
      name: 'Purchase Recommendation', color: '#7C3AED',
      kpis: {
        'pu-kpi-reorder': {
          label: 'To Reorder',
          means: 'Stock items whose quantity in stock is below their minimum stock level.',
          calc: ['Count of inventory items with a minimum level > 0 where **In stock < Minimum**.'],
          source: ['**Item master (OITM):** OnHand, MinLevel, OnOrder, IsCommited — all warehouses together.'],
          action: ['Review the **Reorder** list and raise purchase orders.'],
          current: ['Updated on Refresh; the table filters do not change the tiles.'],
        },
        'pu-kpi-critical': {
          label: 'Zero Stock',
          means: 'Items below minimum with **nothing in stock**.',
          calc: ['Urgency **Critical** = In stock ≤ 0.'],
          source: ['**OITM.OnHand**.'],
          action: ['Raise emergency purchase orders now.'],
        },
        'pu-kpi-high': {
          label: 'High Risk Items',
          means: 'Items that still have stock, but stock plus incoming is under half of the minimum.',
          calc: ['**High** = In stock > 0 and (In stock + On order) < 50% × Minimum.'],
          source: ['**OITM:** OnHand, OnOrder, MinLevel.'],
          action: ['Order soon.'],
        },
        'pu-kpi-supprisks': {
          label: 'Supplier Risks',
          means: 'Number of vendors rated **HIGH** risk because most of their open purchase orders are late.',
          calc: [
            'Per vendor, POs dated in the last **180 days** (not cancelled).',
            '**Overdue rate** = open POs past due date ÷ open POs × 100.',
            '**HIGH** = at least one overdue PO and overdue rate > 50%.',
          ],
          source: ['**Purchase Orders (OPOR):** CardCode, DocDate, DocDueDate, DocStatus, DocTotal.'],
          action: ['Escalate with these vendors or line up alternative suppliers.'],
        },
        'pu-kpi-overdue': {
          label: 'Overdue PO only',
          means: 'Number of open purchase orders (not vendors) past their delivery date.',
          calc: ['Open POs (status Open) with due date before today, dated in the last 180 days.'],
          source: ['**OPOR:** DocStatus, DocDueDate, DocDate.'],
          action: ['Chase the suppliers for a confirmed delivery date.'],
        },
        'pu-kpi-impact': {
          label: 'Orders at Risk',
          means: 'Open customer orders due in the next **45 days** that contain an item that is short.',
          calc: [
            '**Short item** = an item from the reorder list that is out of stock, or whose stock is lower than the quantity committed to customers.',
            'Count of distinct open sales orders (due today … today + 45 days) with an open line for a short item.',
          ],
          source: ['**Sales Orders (ORDR + RDR1):** DocDueDate, OpenQty; **OITM** stock figures.'],
          action: ['Warn sales / the customer or reallocate stock to the most important orders.'],
        },
      },
      tables: [
        {
          tbody: 'pu-reorder-tbody', title: 'Reorder recommendations',
          summary: 'Items below their minimum stock with a suggested order quantity. Click Suggested Qty, EOQ or Urgency in a row for that row\'s calculation.',
          cols: {
            'Item Code': 'Item code (OITM).',
            'Description': 'Item name.',
            'On Hand': 'Quantity in stock (OITM OnHand). Red at 0, orange below 50% of minimum.',
            'Min Stock': 'Minimum stock level (OITM MinLevel).',
            'On Order': 'Quantity already on open purchase orders (OITM OnOrder).',
            'Suggested Qty': 'The larger of: shortfall (Minimum − On hand − On order), EOQ − On order, or 1.',
            'EOQ': 'Economic order quantity = √(2 × yearly demand × order cost ÷ holding cost), with yearly demand = Minimum × 12, order cost 50, holding 25% of a unit cost of 1 — i.e. √(4800 × Minimum), rounded up.',
            'Vendor': 'Preferred vendor from the item master (OITM.CardCode, name from OCRD). "—" means no preferred vendor is set on the item.',
            'Urgency': '**Critical** = On hand ≤ 0 · **High** = (On hand + On order) < 50% of minimum · **Medium** = otherwise.',
          },
          notes: ['EOQ uses fixed assumptions (not real prices or sales history); treat it as a guide.'],
        },
        {
          tbody: 'pu-supplier-tbody', title: 'Supplier risk',
          summary: 'Vendor performance on purchase orders from the last 180 days. Click Risk in a row for that row\'s calculation.',
          cols: {
            'Vendor': 'Vendor name and code.',
            'POs (6mo)': 'Number of purchase orders dated in the last 180 days (not cancelled).',
            'Spend': 'Sum of those PO totals (OPOR DocTotal).',
            'Spend %': 'Vendor spend ÷ spend with all vendors × 100. Red above 40%, orange above 25%.',
            'Open POs': 'POs still open.',
            'Overdue': 'Open POs whose due date has passed.',
            'Overdue Rate': 'Overdue ÷ Open POs × 100. Red above 50%, orange above 20%.',
            'Risk': '**HIGH** = overdue > 0 and overdue rate > 50% · **MEDIUM** = overdue rate > 20% or spend share > 40% · **LOW** = otherwise.',
          },
        },
        {
          tbody: 'pu-impact-tbody', title: 'Sales orders at risk',
          summary: 'Open sales orders due in the next 45 days that contain a short item. Click Severity in a row for that row\'s calculation.',
          cols: {
            'SO #': 'Sales order number (ORDR DocNum).',
            'Customer': 'Customer name and code.',
            'Due Date': 'Sales order due date.',
            'Days Left': 'Due date − today. Red ≤ 3 days, orange ≤ 7.',
            'Value': 'Total value of the whole sales order (ORDR DocTotal).',
            'Affected Items': 'Short items on the order with their open quantity.',
            'Severity': '**CRITICAL** = due in ≤ 3 days · **HIGH** = 4–7 days · **MEDIUM** = more than 7 days.',
          },
        },
      ],
    },

    // ────────────────────────────────────────────────────────────── RUSH ORDERS
    'rush-orders-panel': {
      name: 'Rush Orders', color: '#DC2626',
      kpis: {
        'ro-kpi-total': {
          label: 'Scanned',
          means: 'Open customer orders due within the chosen "Urgent within" window (overdue orders included).',
          calc: ['Count of open, not-cancelled sales orders with due date ≤ today + the selected number of days.'],
          source: ['**Sales Orders (ORDR):** DocStatus, DocDueDate, DocTotal; customer from **OCRD**.'],
          action: ['If the number is large, narrow the "Urgent within" window.'],
          current: ['Changes with **Urgent within**; recalculated on **Scan Orders**.'],
        },
        'ro-kpi-critical': {
          label: 'Critical',
          means: 'Orders with an urgency score of **75 or more**.',
          calc: [
            '**Score (0–100)** = Due-date points + Priority points + Value points + Customer-tier points.',
            '**Due date (max 40):** overdue/due today 40 · ≤ 1 day 38 · ≤ 3 days 30 · ≤ 7 days 20 · ≤ 14 days 10 · later 0.',
            '**Value (max 20):** ≥ 100,000 → 20 · ≥ 50,000 → 16 · ≥ 20,000 → 12 · ≥ 5,000 → 7 · ≥ 1,000 → 3.',
            '**Priority (max 20):** from a priority field on the sales order (e.g. U_Priority: Emergency 20 · High 15 · Medium 10). If the company has no such field, its 20 points are spread over the other three factors (× 1.25) so the score still reaches 100.',
            '**Customer tier (max 20):** VIP customer 20 · customer in a high-tier group 15 · everyone else 5. Set VIPs and groups with the **★ Customer tiers** button.',
            'Tags: **CRITICAL ≥ 75 · URGENT ≥ 55 · MONITOR ≥ 35 · NORMAL < 35**.',
          ],
          source: ['**ORDR:** DocDueDate, DocTotal, priority UDF if present; **OCRD:** customer group (GroupCode).'],
          action: ['Expedite immediately.'],
        },
        'ro-kpi-urgent': {
          label: 'Urgent',
          means: 'Orders with an urgency score from **55 to 74**.',
          calc: ['Same score as Critical (due date + value + priority + customer tier). Example: overdue (40) + value ≥ 20,000 (12) + standard customer (5) = 57 → Urgent.'],
          source: ['**ORDR:** DocDueDate, DocTotal.'],
          action: ['Check stock and expedite options today (use the **Action** button on the row).'],
        },
        'ro-kpi-approved': {
          label: 'Auto-Approved',
          means: 'Critical/Urgent orders that are fully in stock and whose express-shipping cost is within your "Max expedite cost" limit.',
          calc: [
            'Only Critical/Urgent orders are analysed. If any line has less free stock than its open quantity → **HOLD** (never auto-approved).',
            '**Expedite cost** = Order value × 2.5% + 150 (capped at 10 × Max expedite cost).',
            '**Auto-approved** when Expedite cost ≤ Max expedite cost.',
          ],
          source: ['**ORDR / RDR1** (open quantity), **OITM** (In stock − Committed).'],
          action: ['Confirm the express bookings for these orders.'],
          current: ['Changes with **Urgent within** and **Max expedite cost**.'],
        },
        'ro-kpi-xcost': {
          label: 'Expedite Cost',
          means: 'Estimated total express-shipping cost for all analysed (Critical/Urgent) orders.',
          calc: ['Sum of Expedite cost (Order value × 2.5% + 150, capped) over Critical/Urgent orders; HOLD orders add 0.'],
          source: ['**ORDR.DocTotal**.'],
          action: ['Compare with **Revenue Protected** to judge whether expediting pays off.'],
        },
        'ro-kpi-revenue': {
          label: 'Revenue Protected',
          means: 'Total value of the orders that were auto-approved for expediting.',
          calc: ['Sum of order value (ORDR DocTotal) of the Auto-Approved orders.'],
          source: ['**ORDR.DocTotal**.'],
          action: ['Shows the sales value secured by approving the expedites.'],
        },
      },
      tables: [{
        tbody: 'ro-tbody', title: 'Rush orders',
        summary: 'Open sales orders due within the chosen window, highest urgency score first. Click the Score or Tag of a row for its breakdown.',
        cols: {
          'Order #': 'Sales order number (ORDR DocNum).',
          'Customer': 'Customer name.',
          'Due Date': 'Order due date. Red "OVERDUE" when due today or earlier; amber when ≤ 3 days.',
          'Value': 'Order total (ORDR DocTotal).',
          'Score': 'Urgency score 0–100 = due-date points (max 40) + value points (max 20) + priority (max 20) + customer tier (max 20). Without a priority field the other three are scaled × 1.25. Click the score for the breakdown.',
          'Tag': 'CRITICAL ≥ 75 · URGENT ≥ 55 · MONITOR ≥ 35 · NORMAL < 35.',
          'AI Rec': '**HOLD** = some line lacks stock · **APPROVE_EXPEDITE** = score ≥ 75 and in stock · **REVIEW** = otherwise. Only for Critical/Urgent orders.',
          'Expedite Cost': 'Order value × 2.5% + 150, capped at 10 × Max expedite cost. "—" for HOLD or non-urgent orders.',
          'Escalate To': 'Sales Director when score ≥ 85, otherwise Operations Manager.',
          'Actions': 'Approve (creates a SAP activity) or hold the expedite.',
        },
        notes: ['After **AI Insight**, the AI may overwrite AI Rec / Expedite Cost / Escalate To for the top rows; the KPI tiles are not recalculated.'],
      }],
    },

    // ───────────────────────────────────────────────────────── SHIPMENT DELAYS
    'shipment-delay-panel': {
      name: 'Shipment Delays', color: '#E9730C',
      kpis: {
        'shp-kpi-checked': {
          label: 'Open POs',
          means: 'All open purchase orders that were checked for delivery risk.',
          calc: ['Count of open, not-cancelled purchase orders (no date limit).'],
          source: ['**Purchase Orders (OPOR):** DocStatus, CANCELED, DocDueDate.'],
          action: ['Context for the risk tiles.'],
        },
        'shp-kpi-atrisk': {
          label: 'At-Risk POs',
          means: 'Open POs with at least a medium chance of arriving late (Critical + High + Medium).',
          calc: [
            '**Delay probability** per PO, based on the vendor\'s overdue rate and how soon the PO is due:',
            '• Overdue: 90% + 0.3% per day late (max 30 days), capped at 99%.',
            '• Not yet due: vendor overdue rate × urgency factor + 5%, capped at 95%. Factor: ≤ 2 days ×2.2 · ≤ 5 ×1.6 · ≤ 10 ×1.1 · ≤ 21 ×0.7 · later ×0.4.',
            'Counted when probability **≥ 25%** or the PO is overdue.',
          ],
          source: ['**OPOR** (open POs, and the vendor\'s POs of the last 180 days for its overdue rate).'],
          action: ['Ask these vendors for confirmed ship dates.'],
        },
        'shp-kpi-critical': {
          label: 'Critical',
          means: 'Open POs that are already overdue or have a delay probability of 80% or more.',
          calc: ['Risk **CRITICAL** = overdue, or delay probability ≥ 80%.'],
          source: ['**OPOR:** DocDueDate + vendor history.'],
          action: ['Escalate to the vendor today and look for an alternative source.'],
        },
        'shp-kpi-high': {
          label: 'High Risk',
          means: 'Open POs, not overdue, with a delay probability from 50% up to 79%.',
          calc: ['Risk **HIGH** = probability ≥ 50% (Critical POs are counted separately).'],
          source: ['**OPOR** + vendor history.'],
          action: ['Request vendor confirmation and ask for an expedite.'],
        },
        'shp-kpi-soimpact': {
          label: 'SOs Impacted',
          means: 'Customer orders due in the next 60 days that contain an item from a Critical or High-risk PO.',
          calc: ['Takes the items on the Critical/High-risk POs and counts open sales orders due today … +60 days that contain one of those items.',
            'Checks up to 200 risky POs × 300 open sales orders, read through DB Direct.'],
          source: ['**POR1** (PO lines), **ORDR / RDR1** (sales orders).'],
          action: ['Warn the customers or reallocate stock.'],
        },
        'shp-kpi-prodimpact': {
          label: 'Prod. Orders Impacted',
          means: 'Planned or released production orders due in the next 60 days that are short of a component sitting on a Critical or High-risk purchase order.',
          calc: [
            'For each component of a planned/released production order due within 60 days: **still to issue** = planned qty − issued qty.',
            'The component must be on an open line of a **Critical or High-risk PO**.',
            '**COVERED** when stock on hand (all warehouses) ≥ still to issue — not counted.',
            '**STOP** when not covered and the PO is overdue or due **after the order\'s start date**.',
            '**AT RISK** when not covered but the PO is due on/before the start date.',
            'Count = production orders with at least one STOP or AT RISK component (the sub-line shows how many will stop).',
          ],
          source: ['**OWOR / WOR1** (production orders and components), **POR1** (PO lines), **OITM** (on hand).',
            'Read through DB Direct; checks up to 200 risky POs.'],
          action: ['Expedite the PO, issue from another warehouse, use a substitute, or reschedule the production order.'],
        },
        'shp-kpi-vendors': {
          label: 'Risky Vendors',
          means: 'Vendors where half or more of their open POs (from the last 6 months) are past due.',
          calc: ['**Overdue rate** = open POs past due ÷ open POs × 100 (POs dated in the last 180 days).', 'Counted when overdue rate **≥ 50%** (risk HIGH).'],
          source: ['**OPOR:** CardCode, DocDate, DocDueDate, DocStatus.'],
          action: ['Review these vendors and consider a backup supplier.'],
        },
      },
      tables: [
        {
          tbody: 'shp-pos-tbody', title: 'Shipment risk (POs)',
          summary: 'Open purchase orders with Medium risk or worse, most critical first. Click Delay Prob. or Risk in a row for its calculation.',
          cols: {
            'PO #': 'Purchase order number (OPOR DocNum).',
            'Vendor': 'Vendor name.',
            'Due Date': 'PO delivery due date.',
            'Days Left': 'Due date − today; shows "Nd late" when overdue.',
            'Delay Prob.': 'Overdue: 90% + 0.3%/day late (max 99%). Otherwise vendor overdue rate × urgency factor (×2.2 … ×0.4) + 5%, max 95%.',
            'Risk': 'CRITICAL = overdue or ≥ 80% · HIGH ≥ 50% · MEDIUM ≥ 25% (LOW is not listed).',
            'Value': 'PO total (OPOR DocTotal).',
            'Note': 'Days overdue and the vendor\'s reliability label, when relevant.',
          },
        },
        {
          tbody: 'shp-vend-tbody', title: 'Vendor reliability',
          summary: 'Vendor delivery performance: what is open today, how the vendor actually delivered in the last 6 months (goods receipts vs PO due dates), and its current overdue rate. Use the filters above the table, click a row for its open POs, Delay History for every past delivery, and Follow up to draft an expediting e-mail.',
          cols: {
            'Vendor': 'Vendor name and code. Click the row to expand its open purchase orders (and item lines).',
            'Open POs': 'All purchase orders open today for this vendor (any PO date).',
            'Open Value': 'Σ DocTotal of the open POs.',
            'Overdue': 'Open POs past their due date, their value, and how many days the oldest one is late.',
            'At Risk': 'Open POs with Critical or High delay risk (overdue, or ≥ 50% delay probability).',
            'Next Due': 'The next open PO that is not yet overdue, its due date and days left.',
            'On-Time %': 'Goods-receipt lines received on or before their due date (PO line ship date, else PO due date) ÷ receipt lines with a due date, last 6 months. Needs DB Direct.',
            'Lead Time': 'Average days from PO date to goods receipt, last 6 months.',
            'Delay History': 'Number of late deliveries and their average days late. Click for every delivery of the last 12 months with a monthly trend.',
            'Overdue Rate': 'Open POs (dated in the last 180 days) past due ÷ those open POs × 100 (a current snapshot).',
            'Action': 'Follow up — drafts an e-mail asking the vendor to confirm ship dates for overdue, at-risk and soon-due POs.',
            'Spend Share': 'The vendor\'s PO value ÷ total PO value of all vendors in the last 6 months × 100. A high share means a delay from this vendor hurts more.',
            'Reliability': '0% Reliable · ≤ 15% Generally On-Time · ≤ 40% Occasionally Late · ≤ 70% Frequently Delayed · above 70% Unreliable.',
            'Risk': 'HIGH ≥ 50% overdue rate · MEDIUM ≥ 20% · LOW below 20%.',
          },
        },
        {
          tbody: 'shp-impact-tbody', title: 'Sales orders impacted',
          summary: 'One row per customer order and at-risk item: the item is on a Critical/High-risk purchase order.',
          cols: {
            'SO #': 'Sales order number (ORDR DocNum).',
            'Customer': 'Customer name.',
            'SO Due': 'Sales order due date.',
            'Item at Risk': 'Item on the sales order that is also on a delayed PO.',
            'Qty': 'Open (undelivered) quantity of that item on the sales order.',
            'Delayed PO': 'The Critical/High-risk purchase order for that item, and its vendor.',
            'PO Due': 'Due date of that purchase order ("overdue" when already past).',
            'Delay Prob.': 'Delay probability of that purchase order.',
          },
        },
        {
          tbody: 'shp-prod-tbody', title: 'Production impact',
          summary: 'One row per production order and component that sits on a Critical/High-risk purchase order. Filter by impact or search above the table.',
          cols: {
            'Impact': 'STOP = stock does not cover the remaining qty and the PO is overdue or due after the start date · AT RISK = not covered, PO due before the start · COVERED = stock on hand covers it.',
            'Prod. Order': 'Production order number (OWOR DocNum) and status (Planned / Released).',
            'Product': 'Item the production order makes.',
            'Start': 'Production order start date and days until it starts.',
            'Due': 'Production order due date.',
            'Component': 'Component (WOR1) that is on a delayed PO.',
            'Still to Issue': 'Planned component qty − issued qty.',
            'On Hand': 'Stock on hand of the component, all warehouses (OITM OnHand). Red when it does not cover the remaining qty.',
            'Delayed PO': 'The most urgent Critical/High-risk PO for that component, and its vendor.',
            'PO Due': 'Due date of that PO ("overdue" when already past).',
            'Delay Prob.': 'Delay probability of that PO.',
          },
        },
      ],
    },

    // ────────────────────────────────────────────────────── ORDER INTELLIGENCE
    'order-intelligence-panel': {
      name: 'Order Intelligence', color: '#0070F2',
      kpis: {
        'oi-kpi-checked': {
          label: 'SOs Checked',
          means: 'Open customer orders due in the next 60 days that were checked against stock.',
          calc: ['Open, not-cancelled sales orders with due date from today to today + 60 days, earliest first, **maximum 60**.', 'Shows 0 if no item in the company is short.'],
          source: ['**Sales Orders (ORDR):** DocStatus, CANCELED, DocDueDate.'],
          action: ['If it shows exactly 60, some orders in the window were not checked.'],
        },
        'oi-kpi-atrisk': {
          label: 'At-Risk Orders',
          means: 'Checked orders with at least one line for an item whose stock is lower than total committed demand.',
          calc: ['**Short item** = In stock < Committed.', 'Count of checked orders with an open line for a short item (Critical + High + Medium).'],
          source: ['**ORDR / RDR1** (OpenQty), **OITM** (OnHand, IsCommited — all warehouses).'],
          action: ['Work through the orders table, Critical first.'],
        },
        'oi-kpi-critical': {
          label: 'Critical',
          means: 'At-risk orders where **none** of the short-line quantity can be supplied.',
          calc: [
            'Item coverage = In stock ÷ Committed × 100.',
            'Order coverage = estimated available ÷ open quantity on its short lines × 100 (available per line = open qty × item coverage).',
            '**Critical** = order coverage 0%.',
          ],
          source: ['**OITM**, **RDR1**.'],
          action: ['Expedite purchasing / production or agree a new date with the customer.'],
        },
        'oi-kpi-high': {
          label: 'High Risk',
          means: 'At-risk orders where less than half of the short-line quantity can be supplied.',
          calc: ['Order coverage above 0% and below 50%. (Coverage 50% or more = Medium.)'],
          source: ['**OITM**, **RDR1**.'],
          action: ['Consider partial delivery, reallocating stock or expediting.'],
        },
        'oi-kpi-value': {
          label: 'Value at Risk',
          means: 'Total value of the at-risk orders.',
          calc: ['Sum of the full order total (ORDR DocTotal, incl. tax/freight) of all at-risk orders — not only the short lines. Shown as K / M.'],
          source: ['**ORDR.DocTotal**.'],
          action: ['Prioritise expediting by value.'],
        },
        'oi-kpi-items': {
          label: 'Short Items',
          means: 'Number of different stock items whose quantity in stock is below the quantity committed to customers.',
          calc: ['Count of inventory items with **In stock < Committed** (company-wide, not only items on the checked orders).'],
          source: ['**Item master (OITM):** OnHand, IsCommited.'],
          action: ['Open **Stock Shortfalls** and check whether On Order covers the gap.'],
        },
      },
      tables: [
        {
          tbody: 'oi-orders-tbody', title: 'At-risk sales orders',
          summary: 'Open sales orders (next 60 days) that contain a short item, most severe first. Click Coverage or Risk in a row for its calculation.',
          cols: {
            'SO #': 'Sales order number — click for the line detail.',
            'Customer': 'Customer name and code.',
            'Due Date': 'Order due date.',
            'Days Left': 'Due date − today. Red ≤ 3 days, orange ≤ 7.',
            'Order Value': 'Full order total (ORDR DocTotal).',
            'Coverage': 'Estimated available ÷ open quantity on the order\'s short lines × 100.',
            'Short Items': 'Short item codes on the order.',
            'Risk': 'Critical = 0% coverage · High = below 50% · Medium = 50% or more.',
            'Detail': 'Shows needed, estimated available, shortage and on-order per short line.',
          },
          notes: ['Stock is not allocated order by order: each order gets the item\'s company-wide coverage ratio.'],
        },
        {
          tbody: 'oi-items-tbody', title: 'Stock shortfalls',
          summary: 'Items whose stock is below the quantity committed to customer orders. Click Coverage in a row for its calculation.',
          cols: {
            'Item Code': 'Item code (OITM).',
            'Description': 'Item name.',
            'On Hand': 'Quantity in stock, all warehouses (OITM OnHand).',
            'Committed': 'Quantity reserved by all open sales orders (OITM IsCommited).',
            'Shortage': 'Committed − On Hand.',
            'On Order': 'Quantity on open purchase orders (OITM OnOrder); "✓ covers" when On Hand + On Order ≥ Committed.',
            'Coverage': 'On Hand ÷ Committed × 100.',
            'Affected SOs': 'Checked sales orders that contain this item.',
          },
        },
      ],
    },

    // ───────────────────────────────────────────────────────── DYNAMIC PRICING
    'dynamic-pricing-panel': {
      name: 'Dynamic Pricing', color: '#F59E0B',
      kpis: {
        'dp-kpi-increase': {
          label: 'Price Increase',
          means: 'Items where the pricing rules recommend **raising** the price.',
          calc: [
            'Rules are checked in order; the first that applies decides:',
            '**Price Establishment** (no price-list price and no sales in 12 months) → cost ÷ (1 − target%) · **Discount Recovery** (avg discount > 15%) → +min(15, discount × 0.7)% · **Margin Recovery** (margin more than 10 pts below target) → +min(20, gap × 1.3)% · **Shortage Pricing** (> 200 units/yr and below min stock) → +8% · **Demand Capture** (> 200 units/yr, margin not above target) → +5% · **Margin Improvement** (margin 2–10 pts below target, some sales) → +min(10, gap)% · **Market Alignment** (realised GP below 30%) → +8%.',
          ],
          source: [
            '**A/R invoices (OINV + INV1)** of the last 12 months: revenue, gross profit, units (cancelled excluded).',
            '**OITM:** cost (AvgPrice), stock, min/max levels, group · **ITM1:** price on the selected price list.',
          ],
          action: ['Open **Details** for each item, then update the price list in SAP.'],
          current: ['Changes with **Price List** and **Margin Target %**; the search and filter buttons do not change the tiles.'],
        },
        'dp-kpi-decrease': {
          label: 'Price Decrease',
          means: 'Items where the rules recommend a **price cut**.',
          calc: ['**Dead Stock** (no sales in 12 months but stock on hand) → −15%.', '**Overstock Clearance** (stock > 110% of max level and demand low or medium) → −7%.'],
          source: ['**INV1** (12-month units), **OITM** (OnHand, MaxLevel).'],
          action: ['Decide on clearance, promotion or bundling.'],
        },
        'dp-kpi-hold': {
          label: 'Hold Price',
          means: 'Items where no pricing rule fired — the price looks balanced — plus items with no price, no sales and no cost (price must be set manually).',
          calc: ['Scenario **Balanced / Hold** → 0% change.', '**Price Establishment** without a cost in SAP is also a Hold: there is nothing to calculate a price from.'],
          source: ['Same data as the other tiles.'],
          action: ['No action needed.'],
        },
        'dp-kpi-avg': {
          label: 'Avg Price Change',
          means: 'Average suggested price change across all analysed items.',
          calc: ['Simple average of Change % over all items (holds count as 0%), 1 decimal. Not weighted by revenue.'],
          source: ['Calculated from the recommendations.'],
          action: ['Use as a gauge of the overall pricing direction.'],
        },
        'dp-kpi-total': {
          label: 'Total Items',
          means: 'Number of sellable items analysed.',
          calc: ['Sales items (OITM SellItem = Y); items with no list price, no sales, no cost and no stock are skipped.'],
          source: ['**OITM**, **ITM1**, **INV1**.'],
          action: ['Context for the other tiles.'],
        },
      },
      tables: [{
        tbody: 'dp-tbody', title: 'Pricing recommendations',
        summary: 'One row per sellable item with the recommended price. Click Suggested Price, Change % or Recommendation for its calculation; Details shows all signals.',
        cols: {
          'Item Code': 'Item code (OITM).',
          'Item Name': 'Item name.',
          'Group': 'Item group code (OITM ItmsGrpCod).',
          'Avg Selling Price': 'Current price used as the base: price on the selected price list first; else 12-month average selling price (revenue ÷ units); else cost (no selling price yet — Price Establishment sets it at the target margin).',
          'Suggested Price': 'Current price × (1 + Change %).',
          'Change %': 'Percentage from the scenario that applied (positive = increase, negative = decrease).',
          'Recommendation': 'Increase / Decrease / Hold, with the scenario name. Sorted decreases first, then increases, then holds — biggest change first.',
          'Details': 'Demand, inventory, margin and benchmark signals behind the recommendation.',
        },
        notes: ['**Margin %** = (price − cost) ÷ price × 100, compared with your Margin Target.', '**Demand** from 12-month units sold: high > 200 · medium > 30 · low > 0 · none = 0.', 'No real competitor prices are used; the benchmark is a fixed 35% gross profit.'],
      }],
    },

    // ───────────────────────────────────────────────────── PRODUCT FORECASTING
    'product-forecast-panel': {
      name: 'Product Forecasting', color: '#059669',
      kpis: {
        'pf-kpi-total': {
          label: 'Total Products',
          means: 'Number of products that had sales in the chosen history period.',
          calc: ['Count of items with at least one month of invoiced sales. History "N years" starts on 1 January, N−1 years ago, up to today (1 year = this year to date).'],
          source: ['**A/R invoices (OINV + INV1):** quantity per item per month; **OITM** for item group, stock.'],
          action: ['Size of the portfolio being forecast.'],
          current: ['Changes with **History** and **Item Group** after you click **Analyse**.'],
        },
        'pf-kpi-growing': {
          label: 'Growing',
          means: 'Products whose monthly sales are trending **up** by more than 8% per month.',
          calc: [
            '**Avg monthly** = units of the last 12 months that had sales ÷ number of those months.',
            '**Trend %** = monthly trend (straight-line slope) ÷ Avg monthly × 100.',
            '**Growing** when Trend % > +8.',
          ],
          source: ['**INV1** monthly quantities.'],
          action: ['Check stock and plan to build it up.'],
        },
        'pf-kpi-stable': {
          label: 'Stable',
          means: 'Products with a flat sales trend.',
          calc: ['Trend % between −8 and +8.'],
          source: ['**INV1** monthly quantities.'],
          action: ['Replenish as normal.'],
        },
        'pf-kpi-declining': {
          label: 'Declining',
          means: 'Products whose monthly sales are trending **down** by more than 8% per month.',
          calc: ['Trend % < −8.'],
          source: ['**INV1** monthly quantities.'],
          action: ['Reduce reorder quantities; consider promotion or phase-out.'],
        },
        'pf-kpi-stockout': {
          label: 'Stockout Risk',
          means: 'Products at **HIGH** risk of running out of stock.',
          calc: [
            '**Weeks of cover** = In stock ÷ next month\'s forecast × 4.33 (uses Avg monthly if there is no forecast).',
            '**HIGH** when cover < 4 weeks or no stock. (MEDIUM = 4–10 weeks, LOW = 10+ weeks — not counted here.)',
          ],
          source: ['**OITM.OnHand** (all warehouses) + the forecast.'],
          action: ['Raise purchase or production orders now.'],
        },
        'pf-kpi-fc12m': {
          label: 'Horizon Forecast',
          means: 'Total forecast units for all products over the selected forecast horizon.',
          calc: [
            'Per month: (average of the last 6 sales months + trend × months ahead) × seasonal index of that calendar month, never below 0.',
            'Summed over the months of the **Forecast** horizon and over all products. The tile title follows the horizon you pick (3-, 6- or 12-Month Forecast), and so does the matching table column.',
          ],
          source: ['**INV1** monthly history.'],
          action: ['Use for capacity, budget and purchasing planning.'],
        },
      },
      tables: [{
        tbody: 'pf-tbody', title: 'Product forecast',
        summary: 'Forecast per product, highest stock-out risk first. Click Trend, Stock Cover, Risk or Confidence in a row for its calculation.',
        cols: {
          'Item Code': 'Item code.',
          'Item Name': 'Item name.',
          'Avg Monthly': 'Units sold in the last 12 months that had sales ÷ number of those months.',
          '3-Month FC': 'Sum of the forecast for the next 3 months.',
          '12-Month FC': 'Sum of the forecast for all months in the selected horizon.',
          'Trend': 'Growing > +8%/month · Declining < −8%/month · otherwise Stable.',
          'Stock Cover': 'In stock ÷ next month\'s forecast × 4.33, in weeks.',
          'Risk': 'HIGH < 4 weeks cover or no stock · MEDIUM 4–10 weeks · LOW 10+ weeks.',
          'Confidence': 'Data score (months with sales ÷ months in history, max 50) + stability score (50 − |trend %| × 0.5). Green ≥ 70, amber ≥ 40.',
          'Detail': 'Monthly history and forecast for the product.',
        },
        notes: ['Months without sales are skipped (not counted as 0), which can make Avg Monthly look higher for products that sell irregularly.'],
      }],
    },

    // ────────────────────────────────────────────────────────── ACTIVITY AGENT
    'activity-agent-panel': {
      name: 'Activity Agent', color: '#7C3AED',
      kpis: {
        'aa-kpi-scanned': {
          label: 'Scanned',
          means: 'Number of open service calls and open sales orders that were checked.',
          calc: ['Open (not closed) service calls — newest 80 — plus open sales orders due within the "Orders due within" window (overdue included) — first 60.'],
          source: ['**Service Calls (OSCL)**, **Sales Orders (ORDR)**.'],
          action: ['Context only.'],
          current: ['Changes with **Orders due within** and the Service Calls / Sales Orders checkboxes after **Scan Now**.'],
        },
        'aa-kpi-needs': {
          label: 'Needs Activity',
          means: 'Scanned service calls / orders whose customer has had **no CRM activity** within the inactivity window.',
          calc: ['Cut-off = today − "Inactive >" days.', 'Needs activity when the customer has **no activity at all**, or its latest activity date is **before the cut-off**.'],
          source: ['**Activities (OCLG):** latest ActivityDate per customer (any type, open or closed).'],
          action: ['Log a call, note or meeting with these customers (**+ Log** on the row).'],
        },
        'aa-kpi-sc': {
          label: 'Service Calls',
          means: 'Number of open service calls scanned (all of them, not only those needing activity).',
          calc: ['Count of non-closed service calls, newest 80. 0 when the Service Calls box is unticked.'],
          source: ['**OSCL**.'],
          action: ['Review open service calls.'],
        },
        'aa-kpi-so': {
          label: 'Orders',
          means: 'Number of open sales orders due within the window that were scanned.',
          calc: ['Open, not-cancelled sales orders with due date ≤ today + "Orders due within" days (overdue included), first 60.'],
          source: ['**ORDR**.'],
          action: ['Confirm delivery with the customer.'],
        },
        'aa-kpi-created': {
          label: 'Created',
          means: 'Number of activities actually created in SAP by this scan.',
          calc: ['Count of activities posted to SAP. Stays 0 unless **Create in SAP** is ticked.'],
          source: ['New **Activities (OCLG)** linked to the service call or order.'],
          action: ['Check them on the **Activity List** tab.'],
        },
      },
      tables: [
        {
          tbody: 'aa-tbody', title: 'Scan results',
          summary: 'Open service calls and sales orders with the date of the customer\'s last CRM activity.',
          cols: {
            'Type': 'SC = service call (OSCL) · SO = sales order (ORDR).',
            'Ref': 'Service call ID or sales order number.',
            'Customer': 'Customer name and code.',
            'Description': 'Service call subject, or order number, due date and value.',
            'Last Activity': 'Latest activity date for this customer (any document); "Never" if none.',
            'Inactive Days': 'Days since that activity. Red above 14, amber above 7.',
            'Status': '**Needs Follow-up** when the last activity is older than the "Inactive >" setting (or never), otherwise Active.',
            'Action': '**+ Log** opens the Create tab pre-filled for a follow-up.',
          },
          notes: ['Last Activity belongs to the customer, not to this particular service call or order.'],
        },
        {
          tbody: 'aa-list-tbody', title: 'Activity list',
          summary: 'Activities from SAP (newest first, up to 100) for the chosen filters.',
          cols: {
            '#': 'Activity number (OCLG ClgCode).',
            'Date': 'Activity date.',
            'BP': 'Business partner code and name.',
            'Subject': 'Activity subject.',
            'Type': 'Phone Call, Note, Meeting, Task or Other.',
            'Priority': 'High, Normal or Low.',
            'Follow-up': 'Recontact (follow-up) date.',
            'Status': 'Open or Closed.',
            'Action': '**Close** marks an open activity as closed in SAP.',
          },
        },
      ],
    },
  };

  // ══════════════════════════════════════════════════════════════════════════
  // ENGINE — decorates tiles / headers and opens the popups.
  // ══════════════════════════════════════════════════════════════════════════
  const TILE_TIP = "Click for what this means and how it's calculated";
  // "3-Month FC" / "6-Month FC" / "12-Month FC" are one column whose label follows the horizon.
  const norm = s => String(s ?? '').replace(/[✎↑↓▲▼⇅ⓘ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b\d+-month\b/g, 'n-month');
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function injectCss() {
    if (document.getElementById('akh-css')) return;
    const s = document.createElement('style');
    s.id = 'akh-css';
    s.textContent = `
.akh-tile{position:relative;cursor:help}
.akh-tile:hover{box-shadow:0 0 0 1px #93C5FD,0 2px 8px rgba(37,99,235,.12)}
.akh-tile.akh-iconly{cursor:inherit}
.akh-i{position:absolute;top:3px;right:5px;width:15px;height:15px;border-radius:50%;border:1px solid currentColor;color:#94A3B8;font:700 10px/13px Georgia,serif;font-style:italic;text-align:center;cursor:help;background:rgba(255,255,255,.85);user-select:none;z-index:1}
.akh-tile:hover .akh-i{color:#2563EB}
.akh-th{text-decoration:underline dotted #94A3B8;text-underline-offset:3px;cursor:help}
.akh-colbar{display:flex;justify-content:flex-end;padding:3px 8px;background:transparent}
.akh-colbtn{border:0;background:transparent;color:#2563EB;font-size:11px;font-weight:600;cursor:pointer;padding:2px 4px;font-family:inherit;display:inline-flex;align-items:center;gap:4px}
.akh-colbtn:hover{text-decoration:underline}
html[data-ui="fiori"] .akh-i{color:#556b82;border-color:#556b82}
html[data-ui="fiori"] .akh-tile:hover{box-shadow:0 0 0 1px #0064d9}
html[data-ui="fiori"] .akh-tile:hover .akh-i{color:#0064d9;border-color:#0064d9}
html[data-ui="fiori"] .akh-th{text-decoration-color:#556b82}
html[data-ui="fiori"] .akh-colbtn{color:#0064d9;font-size:12px}
`;
    document.head.appendChild(s);
  }

  function tileFor(valueEl) {
    return valueEl.closest('.fd-kpi') || valueEl.parentElement;
  }

  // ── Rich popups (data summary + chart + AI insight) ───────────────────────
  // A panel with `richData()` (its last loaded result) and `rich(kpiId, data)`
  // opens the same 3-tab popup as the insight agents (window.KpiDetail from
  // insight-agents.js). The text above (calc / source / action) becomes the
  // "How it's calculated" tab. Without data the plain text popup is used.
  const RICH = {
    'shipment-delay-panel': {
      data: () => window.shpScanData,
      build: shipmentDetail,
      ai: (K, detail, value) => postJson('/api/shipment-delays/chat', {
        sessionId: `kpi_${Date.now()}`,
        message: `Explain the "${K.label}" KPI (value ${value}) on the Shipment Delay dashboard to a purchasing manager. ` +
          'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming PO numbers, vendors, customers and amounts), ' +
          '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only the figures in the context; amounts are in local currency, no currency symbols.',
        context: { kpi: K.label, value, formula: K.calc, stats: detail.stats, rows: (detail.table?.rows || []).slice(0, 15) },
      }).then(r => (!r.reply || /^AI not configured|^Unable to process/.test(r.reply) ? null : { text: r.reply, source: 'ai' })),
    },
  };
  const richCache = new WeakMap();   // scan result → { kpiId: {text, source} }

  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': localStorage.getItem('hanny_token') || '' }, body: JSON.stringify(body) })
      .then(r => r.json()).then(d => { if (d.ok === false) throw new Error(d.error || 'Request failed'); return d; });
  }

  function richPopup(panelId, kpiId) {
    const P = PANELS[panelId], K = P && P.kpis[kpiId], R = RICH[panelId];
    const data = R && R.data && R.data();
    if (!K || !R || !data || !window.KpiDetail) return false;
    const built = R.build(kpiId, data);
    if (!built) return false;
    const calc = K.calc || [];
    const detail = { ...built, formula: calc[0] || K.means, steps: calc.slice(1), sources: K.source || [], actions: K.action || [] };
    const shown = txt(document.getElementById(kpiId)) || String(built.value ?? '—');
    if (!richCache.has(data)) richCache.set(data, {});
    window.KpiDetail.open({
      label: `${K.label} — ${P.name}`, valueHtml: escHtml(shown), tone: built.tone, hint: K.means, color: P.color,
      footnote: 'Live from SAP Business One — refreshed each time you click Scan.',
      detail, cache: richCache.get(data), cacheKey: kpiId,
      loadAI: R.ai ? () => R.ai(K, detail, shown) : null,
    });
    return true;
  }
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shipment Delays: one detail per KPI from the last /api/shipment-delays/scan.
  function shipmentDetail(kpiId, d) {
    const s = d.summary || {}, pos = d.atRiskPOs || [], vendors = d.vendors || [], sos = d.impactedSOs || [];
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sum = (l, k) => l.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const top = (l, k, n) => [...l].sort((a, z) => (Number(z[k]) || 0) - (Number(a[k]) || 0)).slice(0, n);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const RISKS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    const RISK_BADGE = { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue', LOW: 'green' };
    const RISK_COLOR = { CRITICAL: '#BB0000', HIGH: '#E9730C', MEDIUM: '#0070F2', LOW: '#107E3E' };
    const C = {
      po: { key: 'docNum', label: 'PO #' }, vendor: { key: 'vendorName', label: 'Vendor', sub: 'cardCode' },
      due: { key: 'docDueDate', label: 'Due', fmt: 'date' }, left: { key: 'daysLeftTxt', label: 'Days left' },
      prob: { key: 'delayProbPct', label: 'Delay prob.', fmt: 'pct' }, risk: { key: 'riskTag', label: 'Risk', fmt: 'badge', badge: RISK_BADGE },
      value: { key: 'docTotal', label: 'Value', fmt: 'amt' },
    };
    const poRows = pos.map(p => ({ ...p, daysLeftTxt: p.isOverdue ? `${p.daysOverdue}d late` : (p.daysLeft ?? '—') }));
    const byVendor = list => [...list.reduce((m, p) => {
      const k = p.vendorName || p.cardCode;
      const v = m.get(k) || { name: k, n: 0, value: 0 }; v.n++; v.value += p.docTotal || 0; return m.set(k, v);
    }, new Map()).values()].sort((a, z) => z.value - a.value);
    const band = (list, bands, f) => bands.map(([label, test]) => list.filter(p => test(f(p))).length);
    const totalVal = s.totalValue ?? sum(pos, 'docTotal');

    if (kpiId === 'shp-kpi-checked') {
      const rv = s.riskValue || {};
      const counts = { CRITICAL: s.critical || 0, HIGH: s.high || 0, MEDIUM: (s.atRisk || 0) - (s.critical || 0) - (s.high || 0), LOW: s.lowCount ?? null };
      return {
        stats: [{ label: 'Open POs', value: s.totalPOs, fmt: 'int' }, { label: 'Total value', value: totalVal, fmt: 'amt' },
          { label: 'Overdue POs', value: s.overdueCount, fmt: 'int' }, { label: 'Overdue value', value: s.overdueValue, fmt: 'amt' },
          { label: 'Low risk (on track)', value: s.lowCount, fmt: 'int' }, { label: 'Vendors with open POs', value: s.vendorsWithOpen, fmt: 'int' }],
        chart: { title: 'Open POs by delay risk', type: 'bar', fmt: 'int', labels: RISKS,
          series: [{ name: 'POs', values: RISKS.map(r => counts[r] ?? 0) }] },
        table: { title: 'Highest-value POs at Medium risk or worse (Low-risk POs are not listed)', columns: [C.po, C.vendor, C.due, C.risk, C.value], rows: top(poRows, 'docTotal', 20) },
        insight: `**${s.totalPOs ?? 0} open POs worth ${fa(totalVal)}; ${s.atRisk ?? 0} (${pct(s.atRisk || 0, s.totalPOs || 0)}%) carry a medium-or-higher delay risk.**\n\n` +
          (rv.CRITICAL != null ? `- Value by risk: Critical ${fa(rv.CRITICAL)}, High ${fa(rv.HIGH)}, Medium ${fa(rv.MEDIUM)}, Low ${fa(rv.LOW)}.\n` : '') +
          (s.overdueCount ? `- ${s.overdueCount} POs (${fa(s.overdueValue)}) are already past their due date.\n` : '- No open PO is past its due date.\n') +
          `- ${s.lowCount ?? '—'} POs are on track (Low risk) and need no action.`,
      };
    }
    if (kpiId === 'shp-kpi-atrisk') {
      const vv = byVendor(pos);
      const atVal = sum(pos, 'docTotal');
      return {
        stats: [{ label: 'At-risk POs', value: pos.length, fmt: 'int' }, { label: '% of open POs', value: pct(pos.length, s.totalPOs || 0), fmt: 'pct' },
          { label: 'Value at risk', value: atVal, fmt: 'amt' }, { label: 'Already overdue', value: pos.filter(p => p.isOverdue).length, fmt: 'int' },
          { label: 'Avg delay probability', value: pos.length ? sum(pos, 'delayProbPct') / pos.length : 0, fmt: 'pct' }, { label: 'Vendors involved', value: vv.length, fmt: 'int' }],
        chart: { title: 'At-risk PO value by vendor (top 10)', type: 'bar', horizontal: true, stacked: true, labels: vv.slice(0, 10).map(v => v.name),
          series: RISKS.slice(0, 3).map(r => ({ name: r, color: RISK_COLOR[r], values: vv.slice(0, 10).map(v => Math.round(sum(pos.filter(p => (p.vendorName || p.cardCode) === v.name && p.riskTag === r), 'docTotal'))) })) },
        table: { title: 'At-risk POs — highest delay probability first', columns: [C.po, C.vendor, C.due, C.left, C.prob, C.risk, C.value], rows: top(poRows, 'delayProbPct', 25) },
        insight: pos.length ? `**${pos.length} open POs worth ${fa(atVal)} are likely to arrive late (${pct(atVal, totalVal)}% of open PO value).**\n\n` +
          `- Critical ${s.critical || 0}, High ${s.high || 0}, Medium ${pos.length - (s.critical || 0) - (s.high || 0)}.\n` +
          (vv[0] ? `- Most exposed vendor: **${vv[0].name}** — ${vv[0].n} POs, ${fa(vv[0].value)}.\n` : '') +
          `- Ask these vendors for confirmed ship dates, starting with the Critical POs.` : '**No open PO is at medium or higher delay risk.**',
      };
    }
    if (kpiId === 'shp-kpi-critical' || kpiId === 'shp-kpi-high') {
      const crit = kpiId === 'shp-kpi-critical', tag = crit ? 'CRITICAL' : 'HIGH';
      const rows = poRows.filter(p => p.riskTag === tag);
      const vv = byVendor(rows);
      const bands = crit
        ? [['Not yet due (≥ 80%)', p => !p.isOverdue], ['1–7d late', p => p.isOverdue && p.daysOverdue <= 7], ['8–30d late', p => p.isOverdue && p.daysOverdue > 7 && p.daysOverdue <= 30], ['31–60d late', p => p.isOverdue && p.daysOverdue > 30 && p.daysOverdue <= 60], ['> 60d late', p => p.isOverdue && p.daysOverdue > 60]]
        : [['≤ 2 days', p => p.daysLeft <= 2], ['3–5 days', p => p.daysLeft > 2 && p.daysLeft <= 5], ['6–10 days', p => p.daysLeft > 5 && p.daysLeft <= 10], ['11–21 days', p => p.daysLeft > 10 && p.daysLeft <= 21], ['> 21 days', p => p.daysLeft > 21]];
      const overdue = rows.filter(p => p.isOverdue);
      const oldest = top(overdue, 'daysOverdue', 1)[0];
      const first = [...rows].sort((a, z) => (a.daysLeft ?? -999) - (z.daysLeft ?? -999))[0];
      return {
        tone: rows.length ? 'bad' : 'good',
        stats: crit
          ? [{ label: 'Critical POs', value: rows.length, fmt: 'int' }, { label: 'Value', value: sum(rows, 'docTotal'), fmt: 'amt' },
              { label: 'Already overdue', value: overdue.length, fmt: 'int' }, { label: 'Not due, ≥ 80% risk', value: rows.length - overdue.length, fmt: 'int' },
              { label: 'Oldest (days late)', value: oldest ? oldest.daysOverdue : 0, fmt: 'int' }, { label: 'Vendors', value: vv.length, fmt: 'int' }]
          : [{ label: 'High-risk POs', value: rows.length, fmt: 'int' }, { label: 'Value', value: sum(rows, 'docTotal'), fmt: 'amt' },
              { label: 'Due in ≤ 5 days', value: rows.filter(p => p.daysLeft <= 5).length, fmt: 'int' }, { label: 'Due in ≤ 10 days', value: rows.filter(p => p.daysLeft <= 10).length, fmt: 'int' },
              { label: 'Avg delay probability', value: rows.length ? sum(rows, 'delayProbPct') / rows.length : 0, fmt: 'pct' }, { label: 'Vendors', value: vv.length, fmt: 'int' }],
        chart: { title: crit ? 'Critical POs by days late' : 'High-risk POs by days until due', type: 'bar', fmt: 'int', labels: bands.map(b => b[0]),
          series: [{ name: 'POs', color: RISK_COLOR[tag], values: band(rows, bands, p => p) }] },
        table: { title: crit ? 'Critical POs — most overdue first' : 'High-risk POs — due soonest first', columns: [C.po, C.vendor, C.due, C.left, C.prob, C.value, { key: 'vendorReliability', label: 'Vendor reliability' }],
          rows: crit ? [...rows].sort((a, z) => (z.daysOverdue || 0) - (a.daysOverdue || 0) || z.delayProbPct - a.delayProbPct) : [...rows].sort((a, z) => (a.daysLeft ?? 999) - (z.daysLeft ?? 999)) },
        insight: !rows.length ? `**No ${crit ? 'critical' : 'high-risk'} POs right now.**` : crit
          ? `**${rows.length} critical POs worth ${fa(sum(rows, 'docTotal'))}: ${overdue.length} already overdue, ${rows.length - overdue.length} not yet due but ≥ 80% likely to be late.**\n\n` +
            (oldest ? `- Oldest: **PO ${oldest.docNum}** from ${oldest.vendorName} — ${oldest.daysOverdue} days late, ${fa(oldest.docTotal)}.\n` : '') +
            (vv[0] ? `- Biggest vendor exposure: **${vv[0].name}** — ${vv[0].n} critical POs, ${fa(vv[0].value)}.\n` : '') +
            '- Escalate to these vendors today and line up an alternative source for anything a customer is waiting for.'
          : `**${rows.length} high-risk POs worth ${fa(sum(rows, 'docTotal'))}; ${rows.filter(p => p.daysLeft <= 5).length} are due within 5 days.**\n\n` +
            (first ? `- Due first: **PO ${first.docNum}** from ${first.vendorName} in ${first.daysLeft} days (${first.delayProbPct}% delay probability).\n` : '') +
            (vv[0] ? `- Most exposed vendor: **${vv[0].name}** — ${vv[0].n} POs, ${fa(vv[0].value)}.\n` : '') +
            '- Ask for written ship-date confirmation and an expedite where possible.',
      };
    }
    if (kpiId === 'shp-kpi-soimpact') {
      const custs = [...sos.reduce((m, r) => m.set(r.customerName, (m.get(r.customerName) || 0) + 1), new Map())].sort((a, z) => z[1] - a[1]);
      const soCount = new Set(sos.map(r => r.soNum)).size;
      const soon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      const dueSoon = new Set(sos.filter(r => r.soDueDate && String(r.soDueDate).slice(0, 10) <= soon).map(r => r.soNum)).size;
      const worst = top(sos, 'delayProbPct', 1)[0];
      return {
        tone: soCount ? 'warn' : 'good',
        stats: [{ label: 'Sales orders', value: soCount, fmt: 'int' }, { label: 'Order lines at risk', value: sos.length, fmt: 'int' },
          { label: 'Customers', value: custs.length, fmt: 'int' }, { label: 'Items', value: new Set(sos.map(r => r.itemCode)).size, fmt: 'int' },
          { label: 'Delayed POs linked', value: new Set(sos.map(r => r.poNum)).size, fmt: 'int' }, { label: 'SOs due ≤ 14 days', value: dueSoon, fmt: 'int' }],
        chart: custs.length ? { title: 'At-risk order lines by customer (top 10)', type: 'bar', horizontal: true, fmt: 'int', labels: custs.slice(0, 10).map(c => c[0]), series: [{ name: 'Lines', values: custs.slice(0, 10).map(c => c[1]) }] } : null,
        table: { title: 'Customer orders waiting on a delayed PO — soonest due first',
          columns: [{ key: 'soNum', label: 'SO #' }, { key: 'customerName', label: 'Customer' }, { key: 'soDueDate', label: 'SO due', fmt: 'date' }, { key: 'itemCode', label: 'Item', sub: 'itemDesc' }, { key: 'poNum', label: 'PO #' }, { key: 'delayProbPct', label: 'PO delay prob.', fmt: 'pct' }],
          rows: [...sos].sort((a, z) => String(a.soDueDate).localeCompare(String(z.soDueDate))) },
        insight: soCount ? `**${soCount} customer orders (${sos.length} lines) depend on items from Critical or High-risk POs; ${dueSoon} are due within 14 days.**\n\n` +
          (custs[0] ? `- Most affected customer: **${custs[0][0]}** — ${custs[0][1]} order lines.\n` : '') +
          (worst ? `- Riskiest link: SO ${worst.soNum} item **${worst.itemCode}** waits on PO ${worst.poNum} (${worst.delayProbPct}% delay probability).\n` : '') +
          `- Tell these customers early or reallocate stock. Checked: ${s.soImpactScope || 'sample'}.`
          : `**No open customer order due in the next 60 days depends on a Critical or High-risk PO** (checked: ${s.soImpactScope || 'sample'}).`,
      };
    }
    if (kpiId === 'shp-kpi-prodimpact') {
      const all = d.prodImpact || [];
      const short = all.filter(r => r.impact !== 'COVERED');
      const orders = new Set(short.map(r => r.prodNum));
      const stopOrders = new Set(short.filter(r => r.impact === 'STOP').map(r => r.prodNum));
      const soonest = [...short].filter(r => r.startDate).sort((a, z) => String(a.startDate).localeCompare(String(z.startDate)))[0];
      const comps = [...short.reduce((m, r) => m.set(r.compItem, (m.get(r.compItem) || 0) + 1), new Map())].sort((a, z) => z[1] - a[1]);
      const vend = [...short.reduce((m, r) => m.set(r.vendor || '—', (m.get(r.vendor || '—') || 0) + 1), new Map())].sort((a, z) => z[1] - a[1]);
      const IMPS = ['STOP', 'AT RISK', 'COVERED'];
      return {
        tone: stopOrders.size ? 'bad' : orders.size ? 'warn' : 'good',
        stats: [{ label: 'Orders impacted', value: orders.size, fmt: 'int' }, { label: 'Orders that will stop', value: stopOrders.size, fmt: 'int' },
          { label: 'Short component lines', value: short.length, fmt: 'int' }, { label: 'Covered by stock', value: all.length - short.length, fmt: 'int' },
          { label: 'Components affected', value: comps.length, fmt: 'int' }, { label: 'Starting within 7 days', value: new Set(short.filter(r => r.daysToStart != null && r.daysToStart <= 7).map(r => r.prodNum)).size, fmt: 'int' }],
        chart: all.length ? { title: 'Component lines by impact', type: 'bar', fmt: 'int', labels: IMPS,
          series: [{ name: 'Lines', values: IMPS.map(i => all.filter(r => r.impact === i).length) }] } : null,
        table: { title: 'Production orders short of components — STOP first, then by start date',
          columns: [{ key: 'impact', label: 'Impact', fmt: 'badge', badge: { STOP: 'red', 'AT RISK': 'amber', COVERED: 'green' } },
            { key: 'prodNum', label: 'Prod. order', sub: 'prodItem' }, { key: 'startDate', label: 'Start', fmt: 'date' }, { key: 'compItem', label: 'Component', sub: 'compName' },
            { key: 'remaining', label: 'To issue', fmt: 'num' }, { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'poNum', label: 'PO', sub: 'vendor' }, { key: 'poDue', label: 'PO due', fmt: 'date' }],
          rows: short },
        insight: orders.size ? `**${orders.size} production orders are short of components that sit on delayed POs; ${stopOrders.size} will stop because the PO arrives after the start date or is already overdue.**\n\n` +
          (soonest ? `- Starts first: **order ${soonest.prodNum}** (${soonest.prodItem}) on ${soonest.startDate} — needs ${soonest.remaining} × ${soonest.compItem}, on hand ${soonest.onHand ?? '—'}, PO ${soonest.poNum} due ${soonest.poDue || '—'}.\n` : '') +
          (comps[0] ? `- Most-needed component: **${comps[0][0]}** (${comps[0][1]} order lines).\n` : '') +
          (vend[0] && vend[0][0] !== '—' ? `- Vendor to chase first: **${vend[0][0]}** (${vend[0][1]} lines).\n` : '') +
          '- Expedite those POs, transfer stock from another warehouse, use a substitute, or reschedule the orders.'
          : `**No planned or released production order due in the next 60 days is short of a component on a delayed PO.**${all.length ? ` ${all.length} component lines on delayed POs are covered by stock.` : ''}`,
      };
    }
    if (kpiId === 'shp-kpi-vendors') {
      const risky = vendors.filter(v => v.riskLevel === 'HIGH');
      const withOpen = vendors.filter(v => v.openPOs > 0).sort((a, z) => z.overdueRate - a.overdueRate || z.openPOs - a.openPOs);
      const worst = [...risky].sort((a, z) => z.overdueRate - a.overdueRate || z.spendShare - a.spendShare)[0];
      const RELS = ['Reliable', 'Generally On-Time', 'Occasionally Late', 'Frequently Delayed', 'Unreliable'];
      return {
        tone: risky.length ? 'bad' : 'good',
        stats: [{ label: 'Risky vendors', value: risky.length, fmt: 'int' }, { label: 'Vendors analysed', value: vendors.length, fmt: 'int' },
          { label: 'Their open POs', value: sum(risky, 'openPOs'), fmt: 'int' }, { label: 'Their overdue POs', value: sum(risky, 'overduePOs'), fmt: 'int' },
          { label: 'Their spend share', value: sum(risky, 'spendShare'), fmt: 'pct' }, { label: 'Longest delay (days)', value: Math.max(0, ...risky.map(v => v.maxDelayDays || 0)), fmt: 'int' }],
        chart: { title: 'Vendors by reliability (open POs, last 180 days)', type: 'bar', fmt: 'int', labels: RELS,
          series: [{ name: 'Vendors', values: RELS.map(r => vendors.filter(v => v.reliability === r).length) }] },
        table: { title: 'Vendors with open POs — highest overdue rate first',
          columns: [{ key: 'vendorName', label: 'Vendor', sub: 'vendorCode' }, { key: 'openPOs', label: 'Open POs', fmt: 'int' }, { key: 'overduePOs', label: 'Overdue', fmt: 'int' },
            { key: 'overdueRate', label: 'Overdue rate', fmt: 'pct' }, { key: 'avgDelayDays', label: 'Avg delay (d)', fmt: 'int' }, { key: 'spendShare', label: 'Spend share', fmt: 'pct' }, { key: 'riskLevel', label: 'Risk', fmt: 'badge', badge: { HIGH: 'red', MEDIUM: 'amber', LOW: 'green' } }],
          rows: withOpen.slice(0, 25) },
        insight: risky.length ? `**${risky.length} of ${vendors.length} vendors have half or more of their open POs past due; together they hold ${Math.round(sum(risky, 'spendShare') * 10) / 10}% of PO spend.**\n\n` +
          (worst ? `- Worst: **${worst.vendorName || worst.vendorCode}** — ${worst.overduePOs} of ${worst.openPOs} open POs overdue (${worst.overdueRate}%), avg ${worst.avgDelayDays} days late.\n` : '') +
          `- ${vendors.filter(v => v.reliability === 'Unreliable').length} vendors are rated Unreliable (> 70% overdue).\n` +
          '- Review these vendors, agree delivery recovery plans and qualify a backup supplier for the biggest ones.'
          : `**No vendor has 50% or more of its open POs overdue.** ${vendors.filter(v => v.riskLevel === 'MEDIUM').length} vendors are at medium risk (20–49%).`,
      };
    }
    return null;
  }

  function kpiPopup(panelId, kpiId) {
    if (richPopup(panelId, kpiId)) return;
    const P = PANELS[panelId], K = P && P.kpis[kpiId];
    if (!K || !window.AgentAbout) return;
    const valueEl = document.getElementById(kpiId);
    const tile = valueEl && tileFor(valueEl);
    let shown = txt(valueEl);
    const sub = tile && tile.querySelector('.fd-kpi-sub');
    const subTxt = sub && sub !== valueEl ? txt(sub) : '';
    const empty = !shown || shown === '—' || shown === '-';
    const current = empty
      ? ['Not calculated yet — run the scan / load the data on this screen first, then click the tile again.']
      : [`**${shown}**${subTxt && subTxt !== '—' ? ' — ' + subTxt : ''}`].concat(K.current || []);
    const sections = [
      { title: 'How it is calculated', items: K.calc },
      { title: 'Where the data comes from (SAP Business One)', items: K.source },
      { title: 'Current value on screen', items: current },
      { title: 'How to use it', items: K.action },
    ].filter(s => s.items && s.items.length);
    window.AgentAbout.open(`${K.label} — ${P.name}`, { summary: K.means, sections }, P.color, { prefix: false });
  }

  function columnPopup(panelId, tIdx, focusKey) {
    const P = PANELS[panelId], T = P && P.tables[tIdx];
    if (!T || !window.AgentAbout) return;
    const items = Object.keys(T.cols).map(k => {
      const label = T.labels && T.labels[k] || k;
      return { k, line: `**${label}** — ${T.cols[k]}` };
    });
    // Put the clicked column first so the user sees it immediately.
    if (focusKey) items.sort((a, b) => (b.k === focusKey) - (a.k === focusKey));
    const sections = [{ title: 'Columns (left to right)', items: items.map(i => i.line) }];
    if (T.notes && T.notes.length) sections.push({ title: 'Good to know', items: T.notes });
    window.AgentAbout.open(`Column guide — ${T.title}`, { summary: T.summary, sections }, P.color, { prefix: false });
  }

  function decorate(panel) {
    const pid = panel.id, P = PANELS[pid];
    if (!P) return;
    // KPI tiles
    Object.keys(P.kpis).forEach(id => {
      const v = document.getElementById(id);
      if (!v || !panel.contains(v)) return;
      const tile = tileFor(v);
      if (!tile || tile.dataset.akhKpi === id) return;
      tile.dataset.akhKpi = id;
      tile.classList.add('akh-tile');
      // A tile that already has its own click action only gets the ⓘ icon.
      if (tile.hasAttribute('onclick') || tile.dataset.akhIconly) tile.classList.add('akh-iconly');
      if (!tile.hasAttribute("title")) tile.title = TILE_TIP;
      // The ⓘ icon is only needed on tiles with their own click action; any
      // other tile opens the popup when clicked anywhere.
      if (tile.classList.contains('akh-iconly') && !tile.querySelector(':scope > .akh-i')) {
        const i = document.createElement('span');
        i.className = 'akh-i';
        i.textContent = 'i';
        i.setAttribute('role', 'button');
        i.setAttribute('aria-label', `What does ${P.kpis[id].label} mean?`);
        i.title = TILE_TIP;
        tile.appendChild(i);
      }
    });
    // Table headers + column-guide control
    P.tables.forEach((T, tIdx) => {
      const body = document.getElementById(T.tbody);
      const table = body && body.closest('table');
      if (!table || !panel.contains(table)) return;
      const keys = {};
      Object.keys(T.cols).forEach(k => { keys[norm(k)] = k; });
      table.querySelectorAll('thead th').forEach(th => {
        const k = keys[norm(th.textContent)];
        if (!k || th.dataset.akhCol) return;
        th.dataset.akhCol = k;
        th.dataset.akhTable = String(tIdx);
        th.classList.add('akh-th');
        th.title = `${(T.labels && T.labels[k]) || k}: ${T.cols[k].replace(/\*\*/g, '')}\n(click for the full column guide)`;
      });
      if (!table.dataset.akhBar) {
        table.dataset.akhBar = '1';
        const bar = document.createElement('div');
        bar.className = 'akh-colbar';
        bar.innerHTML = '<button type="button" class="akh-colbtn" title="What does each column mean?">ⓘ Column guide</button>';
        bar.dataset.akhTable = String(tIdx);
        table.parentNode.insertBefore(bar, table);
      }
    });
  }

  function onPanelClick(e) {
    const panel = e.currentTarget, pid = panel.id;
    const t = e.target;
    if (!(t instanceof Element)) return;
    // Column guide button
    const bar = t.closest('.akh-colbtn');
    if (bar) { e.preventDefault(); columnPopup(pid, +bar.parentNode.dataset.akhTable); return; }
    // Header click (never steal clicks on inputs inside headers, e.g. select-all)
    const th = t.closest('th[data-akh-col]');
    if (th && !t.closest('input,button,select,a,label')) { columnPopup(pid, +th.dataset.akhTable, th.dataset.akhCol); return; }
    // KPI tile
    const tile = t.closest('[data-akh-kpi]');
    if (!tile || !panel.contains(tile)) return;
    const onIcon = !!t.closest('.akh-i');
    if (tile.classList.contains('akh-iconly') && !onIcon) return;
    if (t.closest('input,button,select,a') && !onIcon) return;
    if (onIcon) e.stopPropagation();
    kpiPopup(pid, tile.dataset.akhKpi);
  }

  function attach(panel) {
    if (panel.dataset.akhBound) return;
    panel.dataset.akhBound = '1';
    decorate(panel);
    panel.addEventListener('click', onPanelClick);
    // Agents re-render parts of the panel; re-apply (idempotent) after changes.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => decorate(panel), 150);
    }).observe(panel, { childList: true, subtree: true });
  }

  function init() {
    injectCss();
    Object.keys(PANELS).forEach(id => {
      const p = document.getElementById(id);
      if (p) attach(p);
    });
  }

  window.AgentKpiHelp = {
    panels: PANELS,
    openKpi: kpiPopup,
    openColumns: columnPopup,
    refresh: init,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
