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
            '**Available** = In stock − Committed (sales orders and production-order components).',
            '**Projected** = Available + Ordered (open purchase orders).',
            'An item is in the MRP result when **Projected < Minimum stock** (SAP MRP "Consider minimum inventory level").',
            'It is **Critical** when **Available ≤ 0**.',
            'Count = number of MRP items with urgency Critical.',
          ],
          source: [
            '**Item master (OITM):** In Stock (OnHand), Committed (IsCommited), Ordered (OnOrder), Minimum level (MinLevel).',
            'Scope as in SAP MRP: **active** (not inactive), **inventory** and **purchase** items with a minimum level above 0. Items with procurement method **Make** are left out (SAP plans those as production orders). Company-wide — all warehouses together.',
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
          source: ['**Item master (OITM):** OnHand, IsCommited, OnOrder, MinLevel (active purchase items with a minimum level).'],
          action: ['Reorder soon — include them in the next draft POs after the Critical items.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-medium': {
          label: 'Medium',
          means: 'Items below minimum that still have free stock and a smaller shortfall (under 70% of the minimum).',
          calc: [
            '**Medium** when Available > 0, Projected < Minimum and **Gap ÷ Minimum < 70%**.',
            'Count = number of MRP items with urgency Medium.',
          ],
          source: ['**Item master (OITM):** OnHand, IsCommited, OnOrder, MinLevel.'],
          action: ['Combine them into the same vendor POs as the Critical / High items to save on freight and order handling.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-total': {
          label: 'Total Items',
          means: 'All items whose projected stock (free stock + incoming) is below the minimum stock level — Critical, High and Medium together.',
          calc: [
            'Count of items where **Available + On order < Minimum stock**.',
            'Urgency split: **Critical** = Available ≤ 0 · **High** = Gap ≥ 70% of minimum · **Medium** = everything else.',
            '**Reorder qty** (SAP MRP rules): net requirement = Maximum − Projected when a maximum above the minimum is set, otherwise Minimum − Projected; then at least the **Minimum order qty**, rounded up to the **Order multiple**, and converted to **purchasing units** (÷ Items per purchase unit, rounded up).',
          ],
          source: ['**Item master (OITM):** OnHand, IsCommited, OnOrder, MinLevel, MaxLevel, MinOrdrQty, OrdrMulti, NumInBuy, BuyUnitMsr, PrcrmntMtd, InvntItem, frozenFor.'],
          action: ['Work through the list on **Items & Vendors**. Items already sitting in an unposted draft PO are counted here but hidden in the table, so the table can show fewer rows.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-value': {
          label: 'Reorder Value',
          means: 'Estimated purchase value of the suggested reorder quantities for the items on **Items & Vendors**.',
          calc: [
            'Σ **Unit price × Purchase qty** over the analysed items.',
            '**Unit price** (per purchasing unit) = Last purchase price (per inventory unit) × Items per purchase unit.',
            'Items without a last purchase price count as 0 — the sub-line shows how many.',
            'Items already in a draft PO are not included (their value is on the **Draft POs** tab).',
          ],
          source: ['**OITM:** LastPurPrc, NumInBuy, BuyUnitMsr. Amounts are in local currency; vendor currency is not converted.'],
          action: ['Check the biggest lines before building the POs, and fill in prices for items without one.'],
          current: ['Calculated after the AI Analysis step of **Run MRP**.'],
        },
        'mrp-kpi-novendor': {
          label: 'No Vendor',
          means: 'Items that need reordering but have **no preferred vendor** on the item master.',
          calc: ['Count of MRP items whose preferred vendor (OITM CardCode) is empty.'],
          source: ['**Item master (OITM):** Preferred Vendor (CardCode).'],
          action: ['They go into an "unassigned" draft PO — pick the vendor on the **Draft POs** tab before posting, and set the preferred vendor in SAP so the next run assigns it automatically.'],
          current: ['Updated on **Run MRP**.'],
        },
        'mrp-kpi-drafts': {
          label: 'Draft POs',
          means: 'Purchase-order drafts prepared by the agent (one per vendor) that have **not yet been posted** to SAP.',
          calc: ['Count of saved drafts whose status is not "posted".', 'Line quantities and prices are in the **purchasing unit** — the unit the SAP PO line uses.'],
          source: ['Stored by this application (not yet in SAP). Vendor, payment terms and last purchase price come from SAP: **OCRD**, **OCTG**, **OITM**.'],
          action: ['Open **Draft POs**, check quantities and prices, then **Post to SAP**.'],
        },
        'mrp-kpi-approvals': {
          label: 'Pending Approval',
          means: '**Purchase orders** waiting in the SAP approval workflow (approval procedures).',
          calc: [
            'Count of SAP approval requests with status **Pending** and document type **Purchase Order (22)**, newest 50.',
            'Other document types are listed on the **Approval** tab but not counted here.',
          ],
          source: ['**SAP approval requests** (approval stages / OWDD) via the Service Layer.'],
          action: ['Ask the approvers to approve in SAP; approved POs can then be emailed to the vendor.'],
          current: ['Loaded when the agent opens, on the **Approval** tab and on **Check Approvals**.'],
        },
        'mrp-kpi-posted': {
          label: 'POs Posted',
          means: 'Purchase orders posted to SAP from this agent **in the last 24 hours**.',
          calc: ['Count of saved drafts with status "posted" and a posting time within the last 24 hours. Survives page reloads.'],
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
            'Available': 'In stock − Committed (OITM OnHand − IsCommited), inventory UoM. Red when 0 or less.',
            'On Order': 'Quantity already ordered from vendors on open POs (OITM OnOrder) — counted as incoming supply.',
            'Min': 'Minimum stock level set on the item (OITM MinLevel).',
            'Gap': 'Minimum − (Available + On order). How far projected stock is below the minimum.',
            'Reorder Qty': 'In **purchasing units**. Net requirement (Maximum − Projected if a maximum above the minimum is set, else Minimum − Projected), at least the minimum order qty, rounded up to the order multiple, ÷ items per purchase unit (rounded up). The grey line shows the same quantity in inventory units.',
            'Vendor': 'Preferred vendor of the item (OITM → OCRD name). "No vendor" if none is set.',
            'Unit Price': 'Per purchasing unit: last purchase price (OITM LastPurPrc, per inventory unit) × items per purchase unit; 0 if unknown.',
            'Est. Total': 'Unit Price × Reorder Qty.',
            'Payment Terms': 'Vendor\'s payment terms (OCRD → OCTG).',
            'Lead(d)': 'Lead time in days from the item master (OITM LeadTime); 7 assumed when not set (marked *).',
          },
          notes: ['Items already in an unposted draft PO are not shown here.', 'Make items (procurement method Make) are not listed — plan them as production orders.', 'Tick the checkbox to include an item in **Build Draft POs**.'],
        },
        {
          tbody: 'mrp-approval-tbody', title: 'MRP — Pending approvals',
          summary: 'Documents waiting for approval in SAP (status Pending). Purchase orders are highlighted.',
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
          means: 'Production orders that are still open (Planned or Released) — the full workload the shop floor still has to finish.',
          calc: [
            '**Total Open** = count of production orders whose status is **not Closed / Cancelled**.',
            'Every open order then gets one risk level from its components: **Critical**, **High**, **Medium** or **On Track**.',
            'Critical + High + Medium + Ready to Produce = Total Open.',
            '**Completion %** of an order = Completed qty ÷ Planned qty × 100.',
          ],
          source: ['**Production Orders (OWOR):** Status, DueDate, PlannedQty, CmpltQty, ItemCode, Warehouse.'],
          action: [
            'Use the split by risk to see how much of the workload is blocked by materials.',
            'Many open orders with a low completion % means the shop floor is falling behind — check capacity.',
          ],
          current: ['Updated on open / Refresh. The risk, item and date filters only narrow the table, not the tiles.'],
        },
        'prod-kpi-critical': {
          label: 'Critical Risk',
          means: 'Production orders that **cannot be completed today**: at least one component that is still needed has **no free stock at all**.',
          calc: [
            '**Critical** when any component has **Available ≤ 0** while **Still needed > 0**.',
            'Per component: **Still needed** = Planned qty − Issued qty (not below 0).',
            '**Available** = In stock − Committed (all warehouses together).',
            '**Shortage** = Still needed − Available (not below 0).',
            'Count = open orders with risk Critical (each order counted once, however many components are short).',
          ],
          source: ['**OWOR** (orders), **WOR1** (components: PlannedQty, IssuedQty), **OITM** (OnHand, IsCommited — all warehouses). Incoming purchase orders are **not** counted as available until received.'],
          action: [
            'Expedite or emergency-source the missing component, transfer it from another warehouse, or use a substitute.',
            'If material cannot arrive before the due date, reschedule the order and tell sales.',
          ],
        },
        'prod-kpi-high': {
          label: 'High Risk',
          means: 'Orders that can start, but a short component is covered **less than 50%** by free stock — production will stop part-way.',
          calc: [
            '**High** when not Critical and any short component has **Coverage < 50%**.',
            '**Coverage %** = Available ÷ Still needed × 100 (capped 0–100%).',
            'Still needed = Planned − Issued; Available = In stock − Committed.',
          ],
          source: ['**WOR1** + **OITM** as for Critical Risk.'],
          action: ['Raise a purchase request now and check that the open POs (On Order) arrive before the order\'s due date.'],
        },
        'prod-kpi-medium': {
          label: 'Medium Risk',
          means: 'Orders with a material gap where every short component is still **at least 50% covered** — most of the run can go ahead.',
          calc: [
            '**Medium** when the order has a shortage, is not Critical, and **every** short component has **Coverage ≥ 50%**.',
            'Shortage = Still needed − Available > 0.',
            'Coverage % = Available ÷ Still needed × 100.',
          ],
          source: ['**WOR1** + **OITM**.'],
          action: ['Monitor; run a partial batch with the stock on hand and prepare backup sourcing for the rest.'],
        },
        'prod-kpi-dueweek': {
          label: 'Due This Week',
          means: 'Open production orders due from today up to 7 days ahead — the short-term schedule that needs materials and capacity now.',
          calc: [
            '**Due This Week** = count of open orders with **0 ≤ Days left ≤ 7**.',
            '**Days left** = Due date − today, rounded up to whole days.',
            'Orders without a due date are not counted.',
          ],
          source: ['**OWOR.DueDate**, open orders only.'],
          action: ['Check that none of these is Critical or High; confirm materials and machine / labour capacity for each.'],
        },
        'prod-kpi-overdue': {
          label: 'Overdue',
          means: 'Open production orders whose due date has already passed — deliveries that depend on them are late or at risk.',
          calc: [
            '**Overdue** = count of open orders with **Days left < 0** (due date before today).',
            'Days late = today − Due date.',
            'Orders without a due date are not counted.',
          ],
          source: ['**OWOR.DueDate**, open orders only.'],
          action: [
            'Finish and report completion in SAP, or set a realistic new due date.',
            'Overdue orders that are also short of material need sourcing first — see the Risk column.',
          ],
        },
        'prod-kpi-ready': {
          label: 'Ready to Produce',
          means: 'Open orders where **every component is fully covered by free stock** — they can be released and run to completion now.',
          calc: [
            '**Ready to Produce** = count of open orders where **no component is short** (risk On Track).',
            'For every component: Still needed (Planned − Issued) ≤ Available (In stock − Committed).',
            '**Readiness %** = Ready to Produce ÷ Total Open × 100 (shown under the value).',
          ],
          source: ['**OWOR** + **WOR1** + **OITM** (OnHand, IsCommited — all warehouses).'],
          action: [
            'Schedule these first to keep machines busy while short orders wait for material.',
            'Each order is checked against the full free stock, so if several ready orders share a component, release them in due-date order.',
          ],
          current: ['The line under the value shows Readiness % of all open orders.'],
        },
        'prod-kpi-shortval': {
          label: 'Shortage Value',
          means: 'Estimated purchase value of the materials missing for open production orders — the money needed to unblock production.',
          calc: [
            '**Shortage Value** = Σ over short components of **Total shortage × Average price**.',
            'Total shortage of a component = Σ of its shortage on each open order (same figure as the Component Shortage tab).',
            'Shortage per order line = (Planned − Issued) − (In stock − Committed), not below 0.',
            'Average price = item average cost (OITM AvgPrice), or the last purchase price when no average is set; components without any price add 0.',
          ],
          source: ['**WOR1** (PlannedQty, IssuedQty), **OITM** (OnHand, IsCommited, AvgPrice, LastPurPrc).'],
          action: [
            'Focus purchasing on the few components that make up most of the value.',
            'Each order is checked against the full free stock, so when several orders share a component the real gap can be larger — see "Combined gap" in the detail.',
          ],
          current: ['The line under the value shows how many distinct components are short.'],
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
        'ro-kpi-overdue': {
          label: 'Overdue',
          means: 'Scanned orders whose due date has already passed.',
          calc: ['Count of scanned open sales orders with **due date before today** (days left < 0).', 'These already earn the full 40 due-date points of the urgency score.'],
          source: ['**ORDR:** DocDueDate, DocTotal.'],
          action: ['Call the customer with a new delivery date and expedite or split-ship.'],
        },
        'ro-kpi-hold': {
          label: 'Stock Hold',
          means: 'Critical or Urgent orders that cannot be expedited because at least one line lacks free stock.',
          calc: ['Only Critical/Urgent orders are analysed.', 'A line lacks stock when free stock (**In stock − Committed**) is below its open quantity.', 'Any short line puts the whole order on **HOLD** — it is never auto-approved.'],
          source: ['**ORDR / RDR1** (open quantity), **OITM** (OnHand − IsCommited).'],
          action: ['Check other warehouses, ask purchasing for an emergency replenishment, or tell the customer about a partial delivery.'],
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
          'Decision': 'Your saved decision for the order — ✓ APPROVED or ⏸ HOLD, with the date (hover for who, the note and the SAP activity number). Kept across rescans.',
          'Actions': 'Decide / Change opens the order: Approve Expedite creates a High-priority SAP task linked to the sales order (not with Dry Run on); Hold / Monitor only saves the decision. Only Critical/Urgent orders have it.',
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

    // ──────────────────────────────────────────────── SALES ORDER CONFIRMATION
    // Mirrors controllers/order-confirmation-agent.mjs (GET /orders) and socLoad / updateSelection in index.html.
    'soc-panel': {
      name: 'Sales Order Confirmation', color: '#107E3E',
      kpis: {
        'soc-kpi-pending': {
          label: 'Awaiting Confirmation',
          means: 'Open sales orders in the list that have **not been confirmed** yet (the "Approved" box on the SAP order is not ticked).',
          calc: [
            'Count of listed orders where **Confirmed = No**.',
            'The list holds open, not-cancelled sales orders that match the filters: **Status**, **Search** (SO number, customer code / name or customer PO ref) and the **From / To** posting dates.',
            'With Status = **Confirmed** this tile is 0, because only confirmed orders are listed.',
          ],
          source: ['**Sales Orders (ORDR):** DocStatus = Open, Canceled = N, Confirmed = N.'],
          action: ['Open an order to check lines and the customer\'s credit, then **Confirm** it — or tick several and use **Confirm Selected**.'],
          current: ['Recalculated when you click **Go**. At most 1,000 orders are loaded — narrow the filters if the status line says so.'],
        },
        'soc-kpi-value': {
          label: 'Pending Value (LC)',
          means: 'Total value of the orders still waiting for confirmation, in local currency.',
          calc: [
            '**Σ Document Total (LC)** of the listed orders that are not confirmed.',
            'Document total **includes tax and freight**, after document discount.',
            'Foreign-currency orders are counted at their local-currency total (ORDR DocTotal), so they add up with the rest.',
          ],
          source: ['**ORDR.DocTotal** (local currency).'],
          action: ['Confirm the largest orders first so they can be picked and delivered.'],
        },
        'soc-kpi-cust': {
          label: 'Customers',
          means: 'Number of different customers that have an order in the current list.',
          calc: ['Count of distinct customer codes (ORDR CardCode) across **all listed orders** — pending and confirmed, depending on the Status filter.'],
          source: ['**ORDR.CardCode**.'],
          action: ['A few customers with many pending orders may need a call rather than order-by-order review.'],
        },
        'soc-kpi-sel': {
          label: 'Selected',
          means: 'Orders you have ticked for **Confirm Selected**, and their value.',
          calc: ['Count of ticked orders; the line below is **Σ Document Total (LC)** of those orders.', 'Already-confirmed orders cannot be ticked.'],
          source: ['Your selection on this screen.'],
          action: ['Click **Confirm Selected** to set Confirmed = Yes on all of them in SAP.'],
          current: ['Resets when the list is reloaded.'],
        },
      },
      tables: [{
        tbody: 'soc-tbody', title: 'Open sales orders',
        summary: 'Open, not-cancelled sales orders from SAP, newest posting date first. Click a row for its lines and the customer\'s credit position.',
        cols: {
          'SO #': 'Sales order number (ORDR DocNum).',
          'Customer': 'Customer name and code (ORDR CardName / CardCode).',
          'Customer Ref': 'Customer\'s own PO / reference number (ORDR NumAtCard).',
          'Posting Date': 'Order posting date (ORDR DocDate) — the From / To filter uses this date.',
          'Delivery Date': 'Promised delivery date (ORDR DocDueDate).',
          'Sales Employee': 'Sales employee on the order (ORDR SlpCode → OSLP name).',
          'Total': 'Document total **in the order\'s currency**, including tax (DocTotalFC for foreign-currency orders, otherwise DocTotal). The KPI tiles use the local-currency total.',
          'Status': '**Confirmed** when the order\'s Confirmed / Approved flag is Yes, otherwise **Pending**.',
        },
        notes: ['Confirming sets ORDR **Confirmed = Yes** through the Service Layer; nothing else on the order changes.'],
      }],
    },
  };

  // ══════════════════════════════════════════════════════════════════════════
  // SALES ANALYSIS — the four tiles and the table columns follow the view tab
  // (Sales / Avg Selling Price / Back Orders / Customer Balance / On-Time /
  // By Document) and the Documents selector, so the help is built on demand
  // from window.saState() (index.html). Formulas mirror
  // controllers/sales-analysis-agent.mjs (VIEW_MEASURES, DOC_SETS,
  // finalizeMeasures) and saUpdateKPIs / saRenderTable in index.html.
  // ══════════════════════════════════════════════════════════════════════════
  const saState = () => (window.saState ? window.saState() : null);
  const SA_TAB = { sales: 'Sales', avgprice: 'Avg Selling Price', backorder: 'Back Orders', custbalance: 'Customer Balance', ontime: 'On-Time Delivery', bydoc: 'By Document' };
  const SA_DOCS = {
    net: 'Documents: **A/R Invoices (OINV / INV1) minus A/R Credit Memos (ORIN / RIN1)** — credit memo amounts are already negative in the view, so they are simply added.',
    inv: 'Documents: **A/R Invoices (OINV / INV1)** only.',
    cm: 'Documents: **A/R Credit Memos (ORIN / RIN1)** only — the values are negative.',
    dlv: 'Documents: **Deliveries (ODLN / DLN1) minus Returns (ORDN / RDN1)**.',
    so: 'Documents: **Sales Orders (ORDR / RDR1)** — booked orders, whether delivered and invoiced or not.',
  };
  const SA_VIEW_SRC = {
    sales: 'SAP B1 analytics view **SalesAnalysisQuery** — one row per sales document line, filtered on Posting Date. Cancelled documents and their cancellation documents are left out.',
    avgprice: 'SAP B1 analytics view **AverageSellingPriceQuery** — one row per sales document line, filtered on Posting Date.',
    backorder: 'SAP B1 analytics view **BackOrderStatusQuery** — one row per sales order line (ORDR / RDR1), filtered on the order\'s Posting Date.',
    custbalance: 'SAP B1 analytics view **CustomerOpenBalanceVSCreditLimitQuery** — today\'s balances per customer (OCRD). **The From / To dates do not apply** here, and nor do the Brand / Sub-Brand / Universe filters.',
    ontime: 'SAP B1 analytics view **OnTimeDeliveryStatisticsQuery** — sales orders compared with their deliveries, filtered on Posting Date.',
    bydoc: 'SAP B1 analytics view **SalesAnalysisByDocumentQuery** — one row per sales document, filtered on Posting Date. Cancelled documents are left out.',
  };
  const SA_FILTERS = 'Filters: **Customer**, **Item** and **Sales Person** match on code or name (contains); **Brand / Sub-Brand / Universe** are the item\'s COGS distribution rules 1 / 2 / 4; **Territory** and **Branch** must match exactly.';
  // kind → popup number format: amt = money, price = money with decimals, pct, num = quantity / days, int = count.
  const SA_FMT = { amt: 'amt', price: 'price', pct: 'pct', qty: 'num', days: 'num', int: 'int' };
  const SA_RATIO = 'Worked out from the summed amounts of the whole selection (or of the table row) — percentages and averages are never added up row by row.';

  // Every measure the screen can show: tiles (SA_VIEW_META.kpis), table columns and chart series.
  // means / calc / action may be functions of the view; col = short text for the column guide.
  const SA_M = {
    NetSalesAmountLC: { kind: 'amt', label: 'Net Sales (LC)',
      means: v => (v === 'bydoc' ? 'Value of the selected sales documents in local currency, after discounts and before tax.' : 'Sales value in local currency after line discounts and before tax, for the selected sales documents.'),
      calc: ['**Net Sales = Σ Net Sales Amount (LC)** of every row that passes the filters.', 'Only one document set is summed at a time, so the same sale is never counted as order + delivery + invoice.'],
      col: 'Σ Net Sales Amount (LC) of the rows in the group — after discounts, before tax.',
      action: ['Use **By Customer / By Item / By Period** below to see what drives it; click any value for its calculation.'] },
    NetSalesAmountSC: { kind: 'amt', label: 'Net Sales (SC)', means: 'Net sales in the system currency.', calc: ['**Σ Net Sales Amount (SC)** of the filtered rows.'], col: 'Σ Net Sales Amount in system currency.' },
    GrossProfitLC: { kind: 'amt', label: 'Gross Profit',
      means: 'Profit on the goods sold: net sales minus the cost of those goods.',
      calc: ['**Gross Profit = Σ Gross Profit (LC)** of the filtered rows.', 'SAP calculates it on each line: **line net amount − gross-profit base cost** (base price × quantity — normally the item cost when the document was posted).', '**GP margin % = Gross Profit ÷ Net Sales × 100** — ' + SA_RATIO],
      source: ['Line gross-profit base price: **INV1 / RIN1 GrossBuyPr** (set by the item\'s cost or the "Gross profit base price" setting).'],
      col: 'Σ Gross Profit (LC) = line net amount − line cost.',
      action: ['Compare GP with Net Sales by customer and item — a low ratio means discounts or cost increases are eating the margin.'] },
    QuantityInInventoryUoM: { kind: 'qty', label: 'Qty (Inv UoM)', means: 'Quantity sold in the item\'s inventory unit of measure.', calc: ['**Σ Quantity (inventory UoM)** of the filtered rows.'], col: 'Σ quantity in inventory UoM.' },
    GrossProfitMarginBySalesAmount: { kind: 'pct', label: 'GP Margin %', means: 'Gross profit as a share of net sales.', calc: ['**GP Margin % = Σ Gross Profit ÷ Σ Net Sales × 100.**', SA_RATIO], col: 'Gross Profit ÷ Net Sales × 100.' },
    GrossProfitMarginByBaseAmount: { kind: 'pct', label: 'GP Margin (Base) %', means: 'Gross profit as a share of cost (mark-up on cost).', calc: ['**Σ Gross Profit ÷ Σ Gross-profit base amount (cost) × 100.**', SA_RATIO], col: 'Gross Profit ÷ cost base × 100 (mark-up).' },
    GrossProfitBaseAmountLC: { kind: 'amt', label: 'GP Base Amount', means: 'Cost of the goods sold used for gross profit.', calc: ['**Σ Gross-profit base amount (LC)** of the filtered rows.'], col: 'Σ cost base used for gross profit.' },
    SalesQuantityInInventoryUoM: { kind: 'qty', label: 'Sales Qty', means: 'Quantity sold in inventory UoM.', calc: ['**Σ Sales Quantity (inventory UoM)** of the filtered rows.'], col: 'Σ quantity sold (inventory UoM).' },
    AverageNetUnitPriceLC: { kind: 'price', label: 'Avg Unit Price',
      means: 'Average net selling price per unit (inventory UoM), after discounts.',
      calc: ['**Avg Unit Price = Σ Net Sales ÷ Σ Sales Quantity.**', SA_RATIO, 'So a customer buying many cheap units pulls the average down — compare per item for like-for-like prices.'],
      col: 'Σ Net Sales ÷ Σ Sales Qty of the group.',
      action: ['Switch the table to **By Item** to compare real selling prices with your price list.'] },
    AverageItemCostLC: { kind: 'price', label: 'Avg Item Cost', means: 'Average cost per unit sold.', calc: ['**Avg Item Cost = Σ Item Cost ÷ Σ Sales Quantity.**', SA_RATIO], col: 'Σ Item Cost ÷ Σ Sales Qty.' },
    ItemCostLC: { kind: 'amt', label: 'Item Cost', means: 'Cost of the goods sold (local currency).', calc: ['**Σ Item Cost (LC)** of the filtered rows.'], col: 'Σ item cost of the rows.' },
    GrossProfitPercentage: { kind: 'pct', label: 'GP %',
      means: 'Gross profit percentage on the units sold.',
      calc: ['**GP % = (Σ Net Sales − Σ Item Cost) ÷ Σ Net Sales × 100.**', SA_RATIO],
      col: '(Net Sales − Item Cost) ÷ Net Sales × 100.',
      action: ['Items or customers far below your usual GP % are candidates for a price review (see the **Dynamic Pricing** agent).'] },
    OrderedQuantityInInventoryUoM: { kind: 'qty', label: 'Ordered Qty', means: 'Quantity ordered by customers on the sales orders in the period.', calc: ['**Σ Ordered Quantity (inventory UoM)** of the sales order lines.'], col: 'Σ ordered quantity (inventory UoM).' },
    DeliveredQuantityInInvUoM: { kind: 'qty', label: 'Delivered Qty', means: 'Quantity of those orders already delivered.', calc: ['**Σ Delivered Quantity (inventory UoM)** of the sales order lines.'], col: 'Σ delivered quantity.' },
    OpenQuantityInInventoryUoM: { kind: 'qty', label: 'Open Qty',
      means: 'Quantity still to be delivered — the back order.',
      calc: ['**Σ Open Quantity (inventory UoM)** of the sales order lines (ordered − delivered, as SAP keeps it on each line).'],
      col: 'Σ open (not yet delivered) quantity.',
      action: ['Check stock for the items with the largest open quantity (By Item) and plan deliveries.'] },
    BackOrderPercentage: { kind: 'pct', label: 'Back Order %',
      means: 'Share of the ordered quantity that is not delivered yet.',
      calc: ['**Back Order % = Σ Open Qty ÷ Σ Ordered Qty × 100.**', SA_RATIO],
      col: 'Open Qty ÷ Ordered Qty × 100.',
      action: ['A high % on old periods means orders are stuck — close or deliver them; on recent periods it is normal pipeline.'] },
    OpenSalesOrderBalance: { kind: 'amt', label: 'Open SO Balance',
      means: 'Value of open (not yet delivered) sales orders per customer.',
      calc: ['**Σ (Document Total − Paid to Date)** of open, non-cancelled sales orders, per customer, in local currency.'],
      source: ['Sales orders (**ORDR DocTotal − PaidToDate**); ties to the customer\'s Orders balance (OCRD OrdersBal). SAP\'s credit-limit view converts foreign-currency customers twice, so its figure is replaced.'],
      col: 'Open sales-order amount (ORDR DocTotal − PaidToDate).' },
    OpenDeliveryBalance: { kind: 'amt', label: 'Open Delivery Bal', means: 'Value of deliveries not yet invoiced.', calc: ['**Σ Open Delivery Balance** over the customers.'], col: 'Deliveries not yet invoiced.' },
    AccountReceivableBalance: { kind: 'amt', label: 'AR Balance',
      means: 'What customers owe on their account (invoices minus payments and credit memos).',
      calc: ['**Σ Account (A/R) Balance** over the customers in the result.'],
      source: ['Business partner account balance (**OCRD Balance**).'],
      col: 'Customer account balance (OCRD Balance).',
      action: ['Hand the largest balances to the **Collections** agent.'] },
    CustomerBalanceTotal: { kind: 'amt', label: 'Total Balance', means: 'Total customer exposure: account balance plus open deliveries plus open sales orders.', calc: ['**Total Balance = A/R Balance + Open Delivery Balance + Open SO Balance**, summed over the customers.'], col: 'A/R + open delivery + open SO balance.' },
    CustomerCreditLimit: { kind: 'amt', label: 'Credit Limit',
      means: 'Credit limits set on the customers in the result.',
      calc: ['**Σ Credit Limit** (OCRD CreditLine) over the customers.', 'In the popup, **Exposure = A/R Balance + Open Delivery Balance + Open SO Balance** per customer, and **Utilisation = Exposure ÷ Credit Limit × 100**; customers with limit 0 have no limit set.'],
      source: ['**OCRD CreditLine**.'],
      col: 'Credit limit on the customer master (OCRD CreditLine).',
      action: ['Review customers over 100% utilisation before confirming new orders.'] },
    NumberOfSalesOrder: { kind: 'int', label: 'SO Count', means: 'Number of sales orders compared with their deliveries.', calc: ['**Σ Number of Sales Orders** of the filtered rows.'], col: 'Number of sales orders.' },
    DelayedDays: { kind: 'days', label: 'Delayed Days',
      means: 'Total days that deliveries were **later** than the promised date.',
      calc: ['**Σ Delayed Days** of the filtered rows — each row adds the days its delivery was after the due date.', 'Average delay per order = Delayed Days ÷ SO Count (shown in the popup).'],
      col: 'Σ days delivered after the due date.',
      action: ['Rank by customer or sales person to find who is affected most.'] },
    AdvanceDays: { kind: 'days', label: 'Advance Days', means: 'Total days that deliveries were **earlier** than the promised date.', calc: ['**Σ Advance Days** of the filtered rows.'], col: 'Σ days delivered before the due date.' },
    AverageDeliveryVarianceDays: { kind: 'days', label: 'Avg Variance Days',
      means: 'Average difference between actual delivery date and promised date.',
      calc: ['**Avg Variance = Σ Delivery Variance Days ÷ number of rows.**', 'Each row\'s variance comes from SAP\'s view (delivery date vs. due date).'],
      col: 'Σ delivery variance days ÷ rows in the group.' },
    AppliedNetSalesAmountLC: { kind: 'amt', label: 'Applied Net Sales', means: 'Part of the document value already settled (paid / applied).', calc: ['**Σ Applied Net Sales Amount (LC)** of the documents.'], col: 'Σ amount already applied (paid / reconciled).' },
    OpenAmountLC: { kind: 'amt', label: 'Open Amount',
      means: 'Part of the document value still open (not paid / applied).',
      calc: ['**Σ Open Amount (LC)** of the documents.'],
      col: 'Σ amount still open.',
      action: ['Large open amounts on old documents → follow up with the **Collections** agent.'] },
    customers: { kind: 'int', label: 'Customers',
      means: 'Number of different customers in the result.',
      calc: ['**Count of distinct customer codes** (BusinessPartnerCode) among the filtered rows.'],
      action: ['Use with the first tile: value ÷ customers = average per customer (shown in the popup).'] },
    rowCount: { kind: 'int', label: 'Records',
      means: 'Number of rows the SAP view returned after your filters.',
      calc: ['**Count of rows** that pass the date, Documents and other filters.', 'A row is one document line for line-level views, or one document for By Document.'],
      action: ['Context only — a very low number usually means the filters are too narrow.'] },
  };
  const saLabel = (st, k) => st?.labels?.[k] || SA_M[k]?.label || k;
  const saVal = (x, v) => (typeof x === 'function' ? x(v) : x);

  function saKpiSpec(i) {
    const st = saState();
    const m = st && st.kpis[i], M = m && SA_M[m];
    if (!M) return null;
    const v = st.view, docKey = st.data?.docSet?.key;
    const calc = [...saVal(M.calc, v)];
    if (docKey && SA_DOCS[docKey]) calc.push(SA_DOCS[docKey]);
    return {
      label: `${saLabel(st, m)} (${SA_TAB[v] || v})`,
      means: saVal(M.means, v),
      calc,
      source: [SA_VIEW_SRC[v], ...(M.source || []), v === 'custbalance' ? 'Filters: **Customer** (code or name contains) applies; the item / brand filters do not.' : SA_FILTERS],
      action: saVal(M.action, v) || ['Click any value in the table below to see its calculation for that customer, item, period or brand.'],
      current: [i === 0 ? 'The line under the value shows the number of rows and the document set.' : 'The line under the value shows the number of customers in the result.',
        'Recalculated on **Analyze**, when you switch the view tab or change **Documents**.'],
    };
  }

  const SA_GROUP = {
    customer: ['Customer', 'Customer (business partner) name; rows grouped by customer code. Top 50 by the first measure.'],
    item: ['Item', 'Item description; rows grouped by item code. Top 50 by the first measure. Empty for views without item lines.'],
    period: ['Period', 'Posting month (year-month) of the rows.'],
    brand: ['Brand', 'Item brand = COGS distribution rule 1 (CogsOcrCod); "Unassigned" when blank. Empty for Customer Balance and By Document.'],
  };
  function saCols() {
    const st = saState();
    if (!st) return {};
    const [gl, gt] = SA_GROUP[st.group] || SA_GROUP.customer;
    const cols = { [gl]: gt };
    st.kpis.filter(k => k !== 'customers' && k !== 'rowCount').forEach(k => { cols[saLabel(st, k)] = SA_M[k]?.col || ''; });
    cols.Count = 'Number of view rows in the group (document lines, or documents for By Document).';
    return cols;
  }

  // ───────────────────────────────────────────────────── FORECAST DASHBOARD
  // Tiles are filled client-side in index.html (fdRenderOverview, fdRenderSupDem,
  // fdRunForecast, fdRenderStockPlan); the rich popups read window.fdDashData().
  PANELS['forecast-dashboard-panel'] = {
    name: 'Forecast Dashboard', color: '#E9730C',
    kpis: {
      'fd-kpi-so-count': {
        label: 'Open Sales Orders',
        means: 'Open customer orders that contain the loaded item — the demand already committed by customers.',
        calc: ['**Count** of open sales orders with at least one line for the item.', '**Sub-line amount** = Σ line totals of the item\'s lines (not the whole order total).'],
        source: ['**Sales Orders (ORDR / RDR1):** DocStatus = Open, DocDate in the selected **Year**, ItemCode, Quantity, OpenQty, LineTotal.'],
        action: ['Compare open quantity with **Available** stock in the header chips — if it is larger, purchasing must cover the gap.'],
        current: ['Recalculated on **Load Item** / **Refresh** and when the **Year** changes.'],
      },
      'fd-kpi-po-count': {
        label: 'Open Purchase Orders',
        means: 'Open vendor orders for the loaded item — supply that is on its way.',
        calc: ['**Count** of open purchase orders with at least one line for the item.', '**Sub-line amount** = Σ line totals of the item\'s lines.'],
        source: ['**Purchase Orders (OPOR / POR1):** DocStatus = Open, ItemCode, Quantity, OpenQty, LineTotal, DocDueDate.'],
        action: ['Check the **Overdue Deliveries** tile and chase vendors whose POs are late.'],
        current: ['Recalculated on **Load Item** / **Refresh**.'],
      },
      'fd-kpi-lead': {
        label: 'Avg PO Lead Time',
        means: 'How many days, on average, vendors are given between ordering and delivery on the open POs.',
        calc: ['Per PO: **Lead days = Delivery date (DocDueDate) − Order date (DocDate)**.', '**Average** over open POs with a lead time of 0 days or more, rounded to whole days.'],
        source: ['**OPOR:** DocDate, DocDueDate. The item master lead time (OITM.LeadTime) is shown in the header chip for comparison.'],
        action: ['This is the **planned** lead. The popup also shows the **actual** lead from past goods receipts — the Reorder Plan uses the actual one when there are at least 3 deliveries.'],
      },
      'fd-kpi-adv-count': {
        label: 'Advance Payments',
        means: 'Open POs whose vendor has an open down-payment (advance) in SAP.',
        calc: ['A PO counts when its vendor has **open A/P down payments** (ODPO, DocStatus = Open).', 'Sub-line = Σ advance amount over those POs.', 'Note: down payments are matched **by vendor**, not to a specific PO, so one vendor\'s advance appears on each of its open POs.'],
        source: ['**A/P Down Payments (ODPO):** CardCode, DocTotal, DocStatus. **OPOR.DownPayment** marks POs that require an advance.'],
        action: ['Make sure goods arrive for vendors you have already paid in advance; follow up on POs marked “Req’d”.'],
      },
      'fd-kpi-overdue': {
        label: 'Overdue Deliveries',
        means: 'Open POs for the item whose delivery date has already passed — supply that should have arrived.',
        calc: ['Count of open POs with **Delivery date (DocDueDate) < today**.', 'Days late = today − delivery date.'],
        source: ['**OPOR:** DocDueDate, DocStatus = Open.'],
        action: ['Call these vendors for a new date; the Reorder Plan places overdue POs in the first projected month — if they will not arrive, order more.'],
      },
      'fd-sd-kpi-instock': {
        label: 'In Stock',
        means: 'Quantity physically on hand now, all warehouses — the **In Stock** figure of the SAP item master.',
        calc: ['**In Stock = OITM.OnHand** (sum of OITW.OnHand over all warehouses).', '**Free** (sub-line) = In Stock − Committed: on the shelf and not yet promised to a customer.'],
        source: ['**OITM.OnHand**, per warehouse **OITW.OnHand**.'],
        action: ['See Planning Report → By Warehouse for where the stock is.'],
      },
      'fd-sd-kpi-demand': {
        label: 'Committed (demand)',
        means: 'Customer demand already booked but not yet delivered — the **Committed** figure of the SAP item master.',
        calc: ['**Committed = OITM.IsCommited**: open sales-order quantity in stock warehouses + open inventory transfer requests out of a warehouse (+ components of open production orders).',
          'Drop-ship sales orders are not committed (they never pass through stock).'],
        source: ['**OITM.IsCommited**; breakdown from ORDR/RDR1 open lines and OWTQ/WTQ1.'],
        action: ['Committed larger than In Stock means some orders can only ship once the open POs arrive — check Available and the Purchase Plan.'],
      },
      'fd-sd-kpi-supply': {
        label: 'Ordered (supply)',
        means: 'Quantity on open purchase orders, not yet received — the **Ordered** figure of the SAP item master.',
        calc: ['**Ordered = OITM.OnOrder**: open PO quantity for stock warehouses (+ open production orders for made items).', 'Purchase requests are **not** included (they are not orders yet) — shown in the sub-line.'],
        source: ['**OITM.OnOrder**; OPOR/POR1 open lines; OPRQ/PRQ1 for purchase requests.'],
        action: ['Chase overdue POs — see Purchase Tracking.'],
      },
      'fd-sd-kpi-gap': {
        label: 'Available',
        means: 'What will be left after all customer orders are delivered and all open POs are received — the **Available** figure of the SAP item master.',
        calc: ['**Available = In Stock − Committed + Ordered** (OITM.OnHand − OITM.IsCommited + OITM.OnOrder).', 'Negative = booked demand exceeds stock plus everything on order.'],
        source: ['OITM.OnHand, OITM.IsCommited, OITM.OnOrder.'],
        action: ['Available does not look at dates — a positive Available can still mean a temporary shortage if POs arrive after the orders are due. The Running Balance and Purchase Plan show the timing.'],
      },
      'fd-sd-kpi-fcdemand': {
        label: 'Booked Demand',
        means: 'Open sales-order quantity due from the current month to the end of the outlook — demand customers have actually booked. **No forecast** (that is on the Standard Forecast tab).',
        calc: ['Σ open qty of open sales-order lines (stock warehouses) by delivery date; overdue lines count in the current month.'],
        source: ['ORDR / RDR1 open lines (RDR1.ShipDate, OpenQty).'],
        action: ['Compare with Expected Supply + In Stock.'],
      },
      'fd-sd-kpi-openpo': {
        label: 'Expected Supply',
        means: 'Supply already ordered that is expected in the outlook period.',
        calc: ['**Open PO qty** placed in the month it is **expected** to arrive (promised date + the vendor\'s usual lateness; overdue POs count in the current month).',
          '**+ open Purchase Requests** by their required date.', 'Stock warehouses only; drop-ship excluded.'],
        source: ['OPOR / POR1 open lines, OPRQ / PRQ1 open lines, vendor delivery history (OPDN).'],
        action: ['Chase overdue POs — the outlook assumes they arrive.'],
      },
      'fd-sd-kpi-planned': {
        label: 'Order Needed (booked)',
        means: 'Extra supply needed so that stock and open POs cover the **booked** sales orders — nothing forecast.',
        calc: ['Month by month: stock now + expected supply − open SO due; when it falls below the item minimum stock (OITM.MinLevel), the shortfall is an order needed, rounded up to the usual PO lot.'],
        source: ['This tab — booked orders only.'],
        action: ['For future (forecast) demand and creating purchase requests, use the Purchase Plan on the Standard Forecast tab.'],
      },
      'fd-sd-kpi-minbal': {
        label: 'Lowest Projected Stock (booked)',
        means: 'The lowest month-end stock in the outlook from booked orders only, if no new orders are placed.',
        calc: ['Running balance = stock now + expected supply − open SO due, month by month; the lowest value is shown with its month.', 'Red = stockout (< 0).'],
        source: ['Running Balance column of the table.'],
        action: ['Red means booked customer orders cannot be shipped in time — expedite POs or order now.'],
      },
      'fd-fc-kpi-model': {
        label: 'Best Model',
        means: 'The forecasting method (out of 9) that predicted this item\'s past demand most accurately.',
        calc: ['Each model is back-tested: from month 4 on, it forecasts month *t* from months 1…t−1.', '**MAPE** = average of |actual − forecast| ÷ actual (months with actual > 0).', 'The model with the **lowest MAPE** is chosen and used for the forecast and the Reorder Plan.'],
        source: ['Monthly **net invoiced quantity** of the item (A/R invoices − credit memos, cancelled documents excluded) for the selected year + previous year, limited to the History setting. Sales orders are used only if the item has no invoices in either year — never mixed.'],
        action: ['Check the Model Accuracy table — if several models are close, the forecast is robust.'],
      },
      'fd-fc-kpi-mape': {
        label: 'MAPE Accuracy',
        means: 'Average forecast error of the best model, in %. Lower is better.',
        calc: ['**MAPE = mean(|actual − forecast| ÷ actual) × 100**, one-step-ahead back-test.', 'Rule of thumb: **< 20% good · 20–50% fair · > 50% weak** (erratic demand).'],
        source: ['Monthly demand history of the item.'],
        action: ['With a high MAPE, use a higher service level / more safety stock in the Reorder Plan.'],
      },
      'fd-fc-kpi-total': {
        label: 'Forecast Total',
        means: 'Total demand the best model expects over the chosen horizon.',
        calc: ['Σ best-model forecast for each month of the **Horizon** (3, 6 or 12 months).'],
        source: ['Output of the best model on the item\'s monthly demand history.'],
        action: ['Compare with Available + On order — the difference is roughly what you still need to buy.'],
      },
      'fd-fc-kpi-trend': {
        label: 'Trend',
        means: 'Direction of demand: the second half of the history compared with the first half.',
        calc: ['Split the history in two halves and average each.', '**↑ Upward** if second-half average > first × 1.05 · **↓ Downward** if < first × 0.95 · otherwise **→ Stable**.'],
        source: ['Monthly demand history of the item.'],
        action: ['Upward: raise safety stock and order earlier. Downward: avoid over-ordering.'],
      },
      'fd-fc-kpi-growth': {
        label: 'Growth Rate',
        means: 'Percentage change in average monthly demand, second half of the history vs the first half.',
        calc: ['**Growth % = (avg of second half − avg of first half) ÷ avg of first half × 100**.'],
        source: ['Monthly demand history of the item.'],
        action: ['Above +5% the Smart Recommendation suggests increasing safety stock; below −5% to reduce orders.'],
      },
      'fd-sp-kpi-ss': {
        label: 'Safety Stock',
        means: 'Extra stock kept to absorb demand swings during the supplier lead time, and the lead time itself running longer than usual.',
        calc: ['**Safety stock = z × √(LT × σd² + d² × σLT²)**, × the what-if factor (LT and σLT in months).',
          '**z** from the service level: 90% → 1.28 · 95% → 1.65 · 98% → 2.05 · 99% → 2.33.',
          '**d / σd** = average and standard deviation of the last 12 months of demand.',
          '**σLT** = robust spread of the actual lead time on past deliveries — 1.4826 × median absolute deviation, capped at the standard deviation, so a few extreme receipts cannot blow up the buffer (preferred vendor on this item → all vendors on this item → preferred vendor on all items). Untick **Lead-time variability**, or with no delivery history, σLT = 0 and the formula becomes z × σd × √LT.',
          'The plan uses **max(safety stock, item min stock)** as the safety floor.'],
        source: ['Demand history (forecast tab). Lead time, in order: your manual input → **actual lead from past goods receipts** (preferred vendor, else all vendors, ≥ 3 deliveries) → item master (OITM.LeadTime) → planned lead on open POs → 30 days. The source is shown under the Lead time box.'],
        action: ['Raise the service level for critical items; lower it for slow, cheap items.'],
      },
      'fd-sp-kpi-rop': {
        label: 'Reorder Point',
        means: 'When the inventory position drops to this level, place a new purchase order.',
        calc: ['**Reorder point = average monthly demand × (lead time ÷ 30) + safety stock**.', 'Average = last 12 months of demand × the what-if factor.'],
        source: ['Demand history and lead time, as for Safety Stock.'],
        action: ['Compare with **Inventory Position** — below it means reorder now.'],
      },
      'fd-sp-kpi-pos': {
        label: 'Inventory Position',
        means: 'Stock you can count on: free stock now plus what is already ordered.',
        calc: ['**Inventory position = Available (OnHand − Committed) + On order**.', 'Red when it is below the reorder point.'],
        source: ['**OITM:** OnHand, IsCommited, OnOrder.'],
        action: ['Below the reorder point → place the suggested order.'],
      },
      'fd-sp-kpi-out': {
        label: 'Stockout Month',
        means: 'First month in which projected stock falls below zero.',
        calc: ['Month 1 opening = Available (OnHand − Committed) — open sales orders are already deducted here.',
          'Each month: **closing = opening + open-PO qty expected that month − net demand**.',
          '**Expected arrival** of an open PO = promised date + the vendor\'s **expected lateness** = average of max(0, receipt − promised) over past deliveries (item average when the vendor has < 3 deliveries; early deliveries do not cancel late ones). Still open after that → month 1.',
          '**Net demand** = forecast × what-if − open SO quantity due that month (booked orders are not counted twice).',
          'Stockout = first month with closing < 0.'],
        source: ['OITM (stock), OPOR/POR1 (open qty + promised date), OPDN/PDN1 (past receipts → vendor delay), ORDR/RDR1 (open SO qty + date), best-model forecast.'],
        action: ['Order before this month minus the lead time, or expedite open POs.'],
      },
      'fd-sp-kpi-order': {
        label: 'Suggested Order',
        means: 'Quantity to order so projected stock stays at or above the safety floor for the whole horizon, and the latest date to order it.',
        calc: ['Find the first month whose closing stock is below the safety floor.', '**Order qty = largest shortfall (safety floor − closing) from that month to the end of the horizon**.', '**Order-by date = first day of that month − lead time**. If already past, the order is late.'],
        source: ['Stock projection table on this card; preferred vendor from OITM.CardCode.'],
        action: ['Create the PO with the preferred vendor by the order-by date; if late, ask for expedited delivery.'],
      },
    },
    tables: [
      {
        tbody: 'fd-po-tbody', title: 'Purchase Tracking',
        summary: 'Open purchase orders containing the loaded item.',
        cols: {
          'PO #': 'Purchase order number (OPOR DocNum). Click the row for its lines.',
          'Vendor': 'Vendor name (OPOR CardName).',
          'Order Date': 'PO document date (DocDate).',
          'Delivery Date': 'Promised delivery (DocDueDate). The orange **Expected** line below = promised date + this vendor\'s expected lateness from past deliveries (item average if the vendor has fewer than 3); it is what the Reorder Plan uses.',
          'Lead Days': 'Delivery date − order date.',
          'PO Amount': 'Σ line totals of the item on this PO.',
          'Adv. Payment': 'Open A/P down payments of this vendor (matched by vendor, not by PO).',
          'Pay Code': 'Payment terms (PaymentGroupCode).',
          'Status': 'Overdue when delivery date < today, otherwise open.',
          'Lines': 'Number of PO lines for the item.',
        },
      },
      {
        tbody: 'fd-rp-month-tbody', title: 'Planning Report — Monthly',
        summary: 'One row per calendar month for the loaded item: 12 months of history (Actual), the current month and the plan months. Stock warehouses only unless "Show drop-ship" is ticked; cancelled documents excluded.',
        cols: {
          'Month': 'Calendar month. "Before …" / "After …" rows hold open lines dated outside the window.',
          'Type': 'Actual = past month · Current = this month · Plan = future month.',
          'SO Qty (Delivery Date)': 'Sales-order line quantity whose delivery date (RDR1.ShipDate) falls in the month — what customers asked to receive.',
          'Delivered': 'Delivered quantity of those sales-order lines (RDR1.DelivrdQty).',
          'SO Open': 'Still-open quantity of those lines. In past months (red) this is overdue backlog.',
          'Actual Demand': 'Net invoiced quantity posted in the month: A/R invoices − A/R credit memos (OINV/INV1 − ORIN/RIN1).',
          'Forecast': 'Best-model forecast from the Standard Forecast tab (net invoiced demand, stock warehouses).',
          'PO Qty (Due Date)': 'Purchase-order line quantity whose promised date (POR1.ShipDate, else OPOR.DocDueDate) falls in the month.',
          'PO Open': 'Still-open quantity of those PO lines. In past months (red) the vendor is late.',
          'Actual Supply': 'Net quantity received in the month: goods receipts PO − goods returns (OPDN/PDN1 − ORPD/RPD1).',
          'Expected Arrival': 'Open PO quantity placed in the month it is expected to arrive: promised date + the vendor\'s expected lateness from past deliveries.',
          'Projected Stock': 'Closing stock from the Reorder Plan (Standard Forecast tab): red = stockout, amber = below safety stock.',
          'SO Qty': 'Drop-ship sales-order quantity by delivery date (vendor ships to the customer — never in stock).',
          'PO Qty': 'Drop-ship purchase-order quantity by due date.',
          'Invoiced': 'Drop-ship net invoiced quantity.',
        },
      },
      {
        tbody: 'fd-lt-tbody', title: 'Vendor Delivery Performance',
        summary: 'Every goods receipt of the item in the last 24 months that was copied from a purchase order, compared with that PO. Several receipts of the same PO on the same day count as one delivery.',
        cols: {
          'Vendor': 'Vendor on the goods receipt. "preferred" = OITM.CardCode.',
          'Deliveries': 'Number of deliveries measured. ⚠ = fewer than 3, so the item-level average is used for this vendor.',
          'Planned Lead': 'Average of promised date − PO date (promised = PO line ShipDate, else PO DocDueDate).',
          'Actual Lead': 'Average of goods-receipt date − PO date. Used as the Reorder Plan lead time (preferred vendor first).',
          'Lead Range': 'Median and 90th percentile of the actual lead — 9 of 10 deliveries arrived within the p90.',
          'Avg Delay': 'Average of goods-receipt date − promised date (negative = early on average). The small line shows the average delay of the late deliveries only.',
          'Plan Delay': 'Expected lateness = average of max(0, delay) — early deliveries do not cancel out late ones. Added to the promised date of this vendor\'s open POs to get their expected arrival.',
          'On-Time %': 'Share of deliveries received on or before the promised date.',
          'Last Delivery': 'Most recent goods-receipt date.',
        },
      },
      {
        tbody: 'fd-sd-tbody', title: 'Monthly Supply vs Demand',
        summary: 'Per month of the selected year: invoiced demand vs received supply and open POs.',
        cols: {
          'Month': 'Calendar month of the selected year.',
          'Demand': 'Depends on **Demand based on**: sales-order qty by delivery date (default) or by order date — open lines in full, closed lines only the delivered qty — or net invoices (OINV − ORIN). Cancelled documents and drop-ship excluded.',
          'Supply (GRPO)': 'Goods receipt PO qty − goods return qty (OPDN/PDN1 − ORPD/RPD1), cancelled documents excluded.',
          'Open PO': 'Open PO quantity by **due date** (POR1.ShipDate, else OPOR.DocDueDate) in the selected year; in the current year, lines due in an earlier year count in the current month.',
          'Gap': 'Demand − Supply − Open PO.',
          'Status': 'Shortage (gap > 0) · Surplus (gap < 0) · Balanced · No data.',
        },
      },
      {
        tbody: 'fd-fc-acc-tbody', title: 'Model Accuracy',
        summary: 'One-step-ahead back-test of the 9 models, best (lowest MAPE) first.',
        cols: {
          'Model': 'SMA 3/6 = simple moving average · WMA = weighted · EWMA = exponential (α 0.3) · Linear = regression · Drift = last value + average change · Holt = trend smoothing · Seasonal = 12-month index × trend · Median.',
          'MAPE': 'Mean absolute % error (lower is better).',
          'MAE': 'Mean absolute error, in units.',
          'RMSE': 'Root mean squared error — penalises big misses.',
        },
      },
    ],
  };

  PANELS['sales-analysis-panel'] = {
    name: 'Sales Analysis', color: '#0A6ED1',
    kpis: { 'sa-kpi1-val': () => saKpiSpec(0), 'sa-kpi2-val': () => saKpiSpec(1), 'sa-kpi3-val': () => saKpiSpec(2), 'sa-kpi4-val': () => saKpiSpec(3) },
    tables: [{
      tbody: 'sa-table-body', headerClick: false,
      title: () => `${(SA_GROUP[saState()?.group] || SA_GROUP.customer)[0]} Analysis — ${SA_TAB[saState()?.view] || 'Sales'}`,
      summary: () => `The selected view (${SA_TAB[saState()?.view] || 'Sales'}) summed per ${(SA_GROUP[saState()?.group] || SA_GROUP.customer)[0].toLowerCase()}. Click a column header to sort; click any value to see how it was calculated for that row.`,
      cols: saCols,
      notes: [
        'Amounts are summed from the SAP view rows; **percentages and averages are recalculated from the group\'s summed amounts**, never added up.',
        'The Customer and Item tables show the top 50 by the first measure; Period and Brand show all groups.',
        'The search box filters on the first column only. **⬇ CSV** exports the current grouping.',
      ],
    }],
  };

  // "How is this calculated?" for one Sales Analysis table cell (index.html saRenderTable → agxAttr).
  const saNum = v => Number(v || 0);
  function saShow(v, kind) {
    const n = Number(v || 0);
    if (kind === 'pct') return `${n.toFixed(1)}%`;
    if (kind === 'amt') return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(window.APP_LOCALE || 'en-US', { maximumFractionDigits: 0 })}`;
    if (kind === 'price') return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(window.APP_LOCALE || 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (kind === 'days') return `${n.toLocaleString(window.APP_LOCALE || 'en-US', { maximumFractionDigits: 1 })} days`;
    return n.toLocaleString(window.APP_LOCALE || 'en-US', { maximumFractionDigits: 2 });
  }
  // Ratio measures: the summed parts and how they combine.
  const SA_PARTS = {
    GrossProfitMarginBySalesAmount: { parts: ['GrossProfitLC', 'NetSalesAmountLC'], f: (a, b) => (b ? a / b * 100 : 0), txt: 'Gross Profit ÷ Net Sales × 100' },
    GrossProfitMarginByBaseAmount: { parts: ['GrossProfitLC', 'GrossProfitBaseAmountLC'], f: (a, b) => (b ? a / b * 100 : 0), txt: 'Gross Profit ÷ GP Base Amount × 100' },
    AverageNetUnitPriceLC: { parts: ['NetSalesAmountLC', 'SalesQuantityInInventoryUoM'], f: (a, b) => (b ? a / b : 0), txt: 'Net Sales ÷ Sales Qty' },
    AverageItemCostLC: { parts: ['ItemCostLC', 'SalesQuantityInInventoryUoM'], f: (a, b) => (b ? a / b : 0), txt: 'Item Cost ÷ Sales Qty' },
    GrossProfitPercentage: { parts: ['NetSalesAmountLC', 'ItemCostLC'], f: (a, b) => (a ? (a - b) / a * 100 : 0), txt: '(Net Sales − Item Cost) ÷ Net Sales × 100' },
    BackOrderPercentage: { parts: ['OpenQuantityInInventoryUoM', 'OrderedQuantityInInventoryUoM'], f: (a, b) => (b ? a / b * 100 : 0), txt: 'Open Qty ÷ Ordered Qty × 100' },
  };
  function saRowExplain(view, m, r, groupLabel) {
    const M = SA_M[m];
    if (!M || !r) return null;
    const st = saState(), n = r._count || 0, grp = String(groupLabel || 'group').toLowerCase();
    const L = k => saLabel(st, k);
    const sumStep = k => ({ label: L(k), formula: `Σ ${L(k)} of the ${n.toLocaleString()} view rows in this ${grp}`, value: saShow(r[k], SA_M[k]?.kind) });
    const R = SA_PARTS[m];
    let steps, result, note;
    if (R) {
      steps = R.parts.map(sumStep);
      if (m === 'GrossProfitPercentage') steps.push({ label: 'Gross profit', formula: 'Net Sales − Item Cost', value: saShow(saNum(r.NetSalesAmountLC) - saNum(r.ItemCostLC), 'amt') });
      result = { label: `${L(m)} = ${R.txt}`, value: saShow(R.f(saNum(r[R.parts[0]]), saNum(r[R.parts[1]])), M.kind) };
      note = SA_RATIO;
    } else if (m === 'AverageDeliveryVarianceDays') {
      const avg = saNum(r[m]);
      steps = [{ label: 'Rows', formula: `View rows in this ${grp}`, value: n }, { label: 'Σ Delivery variance days', formula: 'Sum of each row\'s variance (delivery date vs. due date)', value: saShow(avg * n, 'days') }];
      result = { label: `${L(m)} = Σ variance ÷ rows`, value: saShow(avg, 'days') };
    } else {
      steps = [{ label: 'Rows', formula: `View rows in this ${grp} after your filters`, value: n }, sumStep(m)];
      if (m === 'DelayedDays' && saNum(r.NumberOfSalesOrder)) steps.push({ label: 'Average delay per order', formula: 'Delayed Days ÷ SO Count', value: saShow(saNum(r.DelayedDays) / saNum(r.NumberOfSalesOrder), 'days') });
      if (m === 'CustomerCreditLimit') {
        const exp = saNum(r.AccountReceivableBalance) + saNum(r.OpenDeliveryBalance) + saNum(r.OpenSalesOrderBalance);
        steps.push({ label: 'Exposure', formula: 'A/R Balance + Open Delivery Balance + Open SO Balance', value: saShow(exp, 'amt') });
        steps.push({ label: 'Utilisation', formula: 'Exposure ÷ Credit Limit × 100', value: saNum(r.CustomerCreditLimit) ? saShow(exp / saNum(r.CustomerCreditLimit) * 100, 'pct') : 'no limit set' });
      }
      if (m === 'NetSalesAmountLC' && r.GrossProfitLC != null) steps.push({ label: 'GP margin of this row', formula: 'Gross Profit ÷ Net Sales × 100', value: saShow(saNum(r.NetSalesAmountLC) ? saNum(r.GrossProfitLC) / saNum(r.NetSalesAmountLC) * 100 : 0, 'pct') });
      if (m === 'GrossProfitLC') steps.push({ label: 'GP margin of this row', formula: 'Gross Profit ÷ Net Sales × 100', value: saShow(saNum(r.NetSalesAmountLC) ? saNum(r.GrossProfitLC) / saNum(r.NetSalesAmountLC) * 100 : 0, 'pct') });
      result = { label: L(m), value: saShow(r[m], M.kind) };
      note = saVal(M.calc, view)[0].replace(/\*\*/g, '');
    }
    return { title: `How "${L(m)}" is calculated (${SA_TAB[view] || view})`, steps, result, note };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENGINE — decorates tiles / headers and opens the popups.
  // ══════════════════════════════════════════════════════════════════════════
  const TILE_TIP = "Click for what this means and how it's calculated";
  // "3-Month FC" / "6-Month FC" / "12-Month FC" are one column whose label follows the horizon.
  const norm = s => String(s ?? '').replace(/[✎↑↓▲▼⇅ⓘ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\b\d+-month\b/g, 'n-month');
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  // Screens whose tiles / columns change with the selected view (Sales Analysis)
  // give a function instead of a fixed spec; it is resolved on every use.
  const tval = x => (typeof x === 'function' ? x() : x);
  const kpiOf = (P, id) => (P ? tval(P.kpis[id]) : null);

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
    return valueEl.closest('.fd-kpi, .ro-tile') || valueEl.parentElement;
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
  RICH['rush-orders-panel'] = {
    data: () => window.roScanData,
    build: rushDetail,
    ai: (K, detail, value) => postJson('/api/rush-orders/chat', {
      sessionId: `kpi_${Date.now()}`,
      message: `Explain the "${K.label}" KPI (value ${value}) on the Rush Order dashboard to an operations manager. ` +
        'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming order numbers, customers and amounts), ' +
        '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only the figures in the context; amounts are in local currency, no currency symbols.',
      context: { kpi: K.label, value, formula: K.calc, stats: detail.stats, rows: (detail.table?.rows || []).slice(0, 15) },
    }).then(r => (!r.reply || /^AI not configured|^Unable to process/.test(r.reply) ? null : { text: r.reply, source: 'ai' })),
  };
  RICH['production-agent-panel'] = {
    data: () => window.prodScanData,
    build: productionDetail,
    footnote: 'Live from SAP Business One — refreshed each time you open the agent or click Refresh.',
    ai: (K, detail, value) => postJson('/api/production/chat', {
      sessionId: `kpi_${Date.now()}`,
      message: `Explain the "${K.label}" KPI (value ${value}) on the Production dashboard to a production manager. ` +
        'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming production order numbers, products, short components and quantities), ' +
        '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only the figures in the context; do not call tools; amounts are in local currency, no currency symbols.',
      context: { kpi: K.label, value, formula: K.calc, stats: detail.stats, rows: (detail.table?.rows || []).slice(0, 15).map(r => { const { components, explain, _short, ...rest } = r; return rest; }) },
    }).then(r => (!r.reply || /^AI not configured|^Unable to process|^I was unable/.test(r.reply) ? null : { text: r.reply, source: 'ai' })),
  };
  RICH['mrp-auto-po-panel'] = {
    data: () => window.mrpScanData,
    build: mrpDetail,
    footnote: 'Live from SAP Business One — refreshed each time you click Run MRP (drafts and approvals when the agent opens).',
    ai: (K, detail, value) => postJson('/api/mrp/chat', {
      sessionId: `kpi_${Date.now()}`,
      message: `Explain the "${K.label}" KPI (value ${value}) on the MRP Auto-PO dashboard to a purchasing manager. ` +
        'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming item codes, vendors, quantities and amounts), ' +
        '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only the figures in the context; do not call tools; amounts are in local currency, no currency symbols.',
      context: { kpi: K.label, value, formula: K.calc, stats: detail.stats, rows: (detail.table?.rows || []).slice(0, 15).map(r => { const { explain, ...rest } = r; return rest; }) },
    }).then(r => (!r.reply || /^AI not configured|^Unable to (process|complete)/.test(r.reply) ? null : { text: r.reply, source: 'ai' })),
  };
  RICH['forecast-dashboard-panel'] = {
    data: () => window.fdDashData && window.fdDashData(),
    build: forecastDashDetail,
    footnote: 'Live from SAP Business One — refreshed on Load Item / Refresh; forecast and reorder plan on Run Forecast.',
    ai: (K, detail, value) => postJson('/api/forecast/ai/chat', {
      message: `Explain the "${K.label}" KPI (value ${value}) on the Forecast Dashboard to a purchasing manager. KPI detail: ${JSON.stringify({ formula: K.calc, stats: detail.stats, rows: (detail.table?.rows || []).slice(0, 15) })}\n` +
        'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming months, PO/SO numbers, vendors, customers and quantities), ' +
        '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only figures from the data; amounts are in local currency, no currency symbols.',
      snapshot: window.fdBuildSnapshot ? window.fdBuildSnapshot() : null,
    }).then(r => (!r.reply || /^AI is not configured|^I could not get/.test(r.reply) ? null : { text: r.reply, source: 'ai' })),
  };
  const richCache = new WeakMap();   // scan result → { kpiId: {text, source} }

  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth-token': localStorage.getItem('hanny_token') || '' }, body: JSON.stringify(body) })
      .then(r => r.json()).then(d => { if (d.ok === false) throw new Error(d.error || 'Request failed'); return d; });
  }

  function richPopup(panelId, kpiId) {
    const P = PANELS[panelId], K = kpiOf(P, kpiId), R = RICH[panelId];
    const data = R && R.data && R.data();
    if (!K || !R || !data || !window.KpiDetail) return false;
    const built = R.build(kpiId, data);
    if (!built) return false;
    const calc = K.calc || [];
    const detail = { ...built, formula: calc[0] || K.means, steps: calc.slice(1), sources: K.source || [], actions: K.action || [] };
    const vEl = document.getElementById(kpiId), vBox = vEl && vEl.closest('.ro-tile-v');
    // S/4 tiles split number and unit into two spans — join them with a space.
    const shown = (vBox ? [...vBox.children].map(txt).filter(Boolean).join(' ') : txt(vEl)) || String(built.value ?? '—');
    if (!richCache.has(data)) richCache.set(data, {});
    window.KpiDetail.open({
      label: `${K.label} — ${P.name}`, valueHtml: escHtml(shown), tone: built.tone, hint: K.means, color: P.color,
      footnote: R.footnote || 'Live from SAP Business One — refreshed each time you click Scan.',
      detail, cache: richCache.get(data), cacheKey: kpiId,
      loadAI: R.ai ? () => R.ai(K, detail, shown) : null,
    });
    return true;
  }
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // MRP Auto-PO: one detail per KPI from the last Run MRP + saved drafts + approvals
  // (window.mrpScanData, published by mrpUpdateKPIs in index.html).
  function mrpDetail(kpiId, d) {
    const s = d.summary, items = d.items || [];
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const fq = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const sum = (l, k) => l.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const top = (l, k, c) => [...l].sort((a, z) => (Number(z[k]) || 0) - (Number(a[k]) || 0)).slice(0, c);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const n = (c, w, ws = w + 's') => `${c} ${c === 1 ? w : ws}`;
    const URG = ['critical', 'high', 'medium'];
    const TAG = { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM' };
    const COLOR = { critical: '#BB0000', high: '#E9730C', medium: '#E8A200' };
    const rows = items.map(i => ({
      ...i,
      urgTag: TAG[i.urgency] || String(i.urgency || '').toUpperCase(),
      vendorTxt: i.vendorName || i.preferredVendor || '—',
      buyTxt: `${fq(i.purchaseQty ?? i.reorderQty)} ${i.purchaseUom || i.uom || ''}`.trim(),
      status: i.draftId ? 'In draft' : 'To order',
      value: Number(i.lineTotal) || 0,
    }));
    const C = {
      item: { key: 'itemCode', label: 'Item', sub: 'itemName' },
      urg: { key: 'urgTag', label: 'Urgency', fmt: 'badge', badge: { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue' } },
      avail: { key: 'available', label: 'Available', fmt: 'num' }, onOrder: { key: 'onOrder', label: 'On order', fmt: 'num' },
      min: { key: 'minStock', label: 'Min', fmt: 'num' }, gap: { key: 'gap', label: 'Gap', fmt: 'num' },
      cov: { key: 'coveragePct', label: 'Coverage', fmt: 'pct' }, buy: { key: 'buyTxt', label: 'Order qty' },
      vendor: { key: 'vendorTxt', label: 'Vendor' }, price: { key: 'unitPrice', label: 'Unit price', fmt: 'price' },
      value: { key: 'value', label: 'Est. value', fmt: 'amt' }, lead: { key: 'leadTime', label: 'Lead (d)', fmt: 'int' },
      status: { key: 'status', label: 'Status', fmt: 'badge', badge: { 'In draft': 'blue', 'To order': 'amber' } },
    };
    const COV_BANDS = [['0% (none)', c => c <= 0], ['1–25%', c => c > 0 && c <= 25], ['26–50%', c => c > 25 && c <= 50], ['51–75%', c => c > 50 && c <= 75], ['76–99%', c => c > 75]];
    const covChart = (title, list) => ({ title, type: 'bar', stacked: true, fmt: 'int', labels: COV_BANDS.map(b => b[0]),
      series: URG.map(u => ({ name: TAG[u], color: COLOR[u], values: COV_BANDS.map(([, t]) => list.filter(i => i.urgency === u && t(i.coveragePct ?? 0)).length) })).filter(x => x.values.some(Boolean)) });
    const byVendor = list => [...list.reduce((m, i) => {
      const k = i.vendorTxt; const v = m.get(k) || { name: k, n: 0, value: 0 }; v.n++; v.value += i.value; return m.set(k, v);
    }, new Map()).values()].sort((a, z) => z.value - a.value || z.n - a.n);
    const lotNote = s && s.lotAdjusted ? `- ${n(s.lotAdjusted, 'reorder qty', 'reorder qtys')} raised by the item's minimum order qty / order multiple.\n` : '';
    const scopeNote = s && s.skippedMake ? `- ${n(s.skippedMake, 'Make item')} below minimum ${s.skippedMake === 1 ? 'is' : 'are'} excluded — plan ${s.skippedMake === 1 ? 'it' : 'them'} as production orders.\n` : '';

    if (['mrp-kpi-critical', 'mrp-kpi-high', 'mrp-kpi-medium'].includes(kpiId)) {
      if (!s) return null;
      const u = kpiId.slice(8), list = rows.filter(i => i.urgency === u).sort((a, z) => (a.coveragePct ?? 0) - (z.coveragePct ?? 0) || z.gap - a.gap);
      const inDraft = list.filter(i => i.draftId), nov = list.filter(i => !i.preferredVendor), noOrd = list.filter(i => !(i.onOrder > 0));
      const vv = byVendor(list);
      return {
        tone: list.length ? (u === 'critical' ? 'bad' : 'warn') : 'good',
        value: list.length,
        stats: [{ label: `${TAG[u][0] + TAG[u].slice(1).toLowerCase()} items`, value: list.length, fmt: 'int' }, { label: '% of MRP items', value: pct(list.length, s.total), fmt: 'pct' },
          { label: 'Nothing on order', value: noOrd.length, fmt: 'int' }, { label: 'Already in a draft PO', value: inDraft.length, fmt: 'int' },
          { label: 'No preferred vendor', value: nov.length, fmt: 'int' }, d.priced ? { label: 'Est. reorder value', value: sum(list, 'value'), fmt: 'amt' } : { label: 'Total gap (qty)', value: sum(list, 'gap'), fmt: 'num' }],
        chart: vv.length > 1 ? { title: `${TAG[u]} items by vendor (top 10)`, type: 'bar', horizontal: true, fmt: 'int', labels: vv.slice(0, 10).map(v => v.name),
          series: [{ name: 'Items', color: COLOR[u], values: vv.slice(0, 10).map(v => v.n) }] } : covChart('Items by stock coverage (projected ÷ minimum)', list),
        table: { title: `${TAG[u]} items — lowest coverage first`, columns: [C.item, C.avail, C.onOrder, C.min, C.gap, C.cov, C.buy, C.vendor, C.status], rows: list },
        insight: list.length ? `**${n(list.length, 'item')} ${list.length === 1 ? 'is' : 'are'} ${u === 'critical' ? 'out of free stock' : `below minimum with ${u} urgency`} — ${pct(list.length, s.total)}% of the ${s.total} MRP items.**\n\n` +
          `- Lowest coverage: **${list[0].itemCode}** ${list[0].itemName ? `(${String(list[0].itemName).slice(0, 40)}) ` : ''}— available ${fq(list[0].available)}, on order ${fq(list[0].onOrder)}, minimum ${fq(list[0].minStock)}.\n` +
          (noOrd.length ? `- ${n(noOrd.length, 'item')} ${noOrd.length === 1 ? 'has' : 'have'} nothing on order yet.\n` : '') +
          (vv[0] && vv[0].name !== '—' ? `- Most items with one vendor: **${vv[0].name}** (${vv[0].n}).\n` : '') +
          (nov.length ? `- ${n(nov.length, 'item')} without a preferred vendor — assign one on the Draft POs tab.\n` : '') +
          (inDraft.length ? `- ${inDraft.length} already sit in an unposted draft PO — post ${inDraft.length === 1 ? 'it' : 'them'} from the Draft POs tab.\n` : '')
          : `**No ${u} items in the last MRP run.**`,
      };
    }
    if (kpiId === 'mrp-kpi-total') {
      if (!s) return null;
      const vv = byVendor(rows);
      return {
        tone: s.critical ? 'bad' : s.total ? 'warn' : 'good',
        value: s.total,
        stats: [{ label: 'Purchase items scanned', value: s.scanned, fmt: 'int' }, { label: 'Below minimum', value: s.total, fmt: 'int' },
          { label: '% of scanned', value: pct(s.total, s.scanned), fmt: 'pct' }, { label: 'Already in draft POs', value: s.inDraft || 0, fmt: 'int' },
          { label: 'Raised by lot sizing', value: s.lotAdjusted || 0, fmt: 'int' }, { label: 'Make items excluded', value: s.skippedMake || 0, fmt: 'int' }],
        chart: covChart('MRP items by urgency and stock coverage (projected ÷ minimum)', rows),
        table: { title: 'All MRP items — most urgent first', columns: [C.item, C.urg, C.avail, C.onOrder, C.min, C.gap, C.buy, C.vendor, C.lead, C.status],
          rows: [...rows].sort((a, z) => URG.indexOf(a.urgency) - URG.indexOf(z.urgency) || (a.coveragePct ?? 0) - (z.coveragePct ?? 0)) },
        insight: s.total ? `**${s.total} of ${s.scanned ?? '—'} purchase items (${pct(s.total, s.scanned)}%) are projected below their minimum: ${s.critical} critical, ${s.high} high, ${s.medium} medium.**\n\n` +
          (vv[0] && vv[0].name !== '—' ? `- Biggest vendor in the list: **${vv[0].name}** — ${n(vv[0].n, 'item')}.\n` : '') +
          `- ${s.inDraft || 0} already in draft POs; ${s.total - (s.inDraft || 0)} still to order.\n` + lotNote + scopeNote +
          `- Data source: ${d.source || '—'}${d.scannedAt ? `, run at ${new Date(d.scannedAt).toLocaleTimeString()}` : ''}.`
          : `**All ${s.scanned ?? ''} scanned purchase items are at or above their minimum stock.**`,
      };
    }
    if (kpiId === 'mrp-kpi-value') {
      if (!s || !d.priced) return null;
      const list = rows.filter(i => i.unitPrice != null), val = sum(list, 'value'), noPrice = list.filter(i => !(i.unitPrice > 0));
      const vv = byVendor(list), t3 = top(list, 'value', 3);
      return {
        tone: noPrice.length ? 'warn' : 'info',
        value: val,
        stats: [{ label: 'Est. reorder value', value: val, fmt: 'amt' }, { label: 'Items priced', value: list.length - noPrice.length, fmt: 'int' },
          { label: 'Without a price', value: noPrice.length, fmt: 'int' }, { label: 'Vendors', value: vv.filter(v => v.name !== '—').length, fmt: 'int' },
          { label: 'Critical items value', value: sum(list.filter(i => i.urgency === 'critical'), 'value'), fmt: 'amt' }, { label: 'Top 3 share', value: pct(sum(t3, 'value'), val), fmt: 'pct' }],
        chart: vv.length ? { title: 'Reorder value by vendor (top 10)', type: 'bar', horizontal: true, labels: vv.slice(0, 10).map(v => v.name),
          series: [{ name: 'Value', color: '#0EA5E9', values: vv.slice(0, 10).map(v => Math.round(v.value)) }] } : null,
        table: { title: 'Reorder lines — highest value first', columns: [C.item, C.urg, C.buy, C.price, C.value, C.vendor], rows: top(list, 'value', 100) },
        insight: `**Ordering the suggested quantities for ${n(list.length, 'item')} costs about ${fa(val)} at last purchase prices.**\n\n` +
          (t3.length ? `- Largest: ${t3.map(i => `**${i.itemCode}** ${fa(i.value)}`).join(', ')} — ${pct(sum(t3, 'value'), val)}% of the total.\n` : '') +
          (vv[0] && vv[0].name !== '—' ? `- Biggest vendor: **${vv[0].name}** — ${fa(vv[0].value)} over ${n(vv[0].n, 'item')}.\n` : '') +
          (noPrice.length ? `- ${n(noPrice.length, 'item')} without a last purchase price count as 0, so the real value is higher.\n` : '') +
          '- Items already in draft POs are not included — see the Draft POs tab.',
      };
    }
    if (kpiId === 'mrp-kpi-novendor') {
      if (!s) return null;
      const list = rows.filter(i => !i.preferredVendor);
      return {
        tone: list.length ? 'warn' : 'good',
        value: list.length,
        stats: [{ label: 'Items without vendor', value: list.length, fmt: 'int' }, { label: '% of MRP items', value: pct(list.length, s.total), fmt: 'pct' },
          { label: 'Critical', value: list.filter(i => i.urgency === 'critical').length, fmt: 'int' }, { label: 'High', value: list.filter(i => i.urgency === 'high').length, fmt: 'int' },
          { label: 'In a draft PO', value: list.filter(i => i.draftId).length, fmt: 'int' }, { label: 'Total gap (qty)', value: sum(list, 'gap'), fmt: 'num' }],
        chart: list.length ? covChart('Items without a vendor by urgency and coverage', list) : null,
        table: { title: 'Items without a preferred vendor — most urgent first', columns: [C.item, C.urg, C.avail, C.min, C.gap, C.buy, C.status],
          rows: [...list].sort((a, z) => URG.indexOf(a.urgency) - URG.indexOf(z.urgency)) },
        insight: list.length ? `**${n(list.length, 'item')} need${list.length === 1 ? 's' : ''} reordering but ${list.length === 1 ? 'has' : 'have'} no preferred vendor in SAP.**\n\n` +
          `- ${list.filter(i => i.urgency === 'critical').length} of them are critical.\n` +
          '- They are grouped into one "Vendor not assigned" draft — pick the vendor there before posting.\n' +
          '- Set the Preferred Vendor on the item master (Purchasing Data tab) so the next MRP run assigns it automatically.'
          : '**Every item that needs reordering has a preferred vendor.**',
      };
    }
    if (kpiId === 'mrp-kpi-drafts' || kpiId === 'mrp-kpi-posted') {
      const posted = kpiId === 'mrp-kpi-posted';
      const list = (d.drafts || []).filter(x => (x.status === 'posted') === posted).map(x => ({
        ...x, vendorTxt: x.vendorName || x.vendorCode || 'Vendor not assigned', nLines: (x.lines || []).length,
        nCrit: (x.lines || []).filter(l => l.urgency === 'critical').length, total: Number(x.totalAmount) || 0,
        docTxt: x.docNum ? `#${x.docNum}` : '—', emailTxt: x.vendorEmail ? 'Yes' : 'No',
      }));
      if (!list.length && !posted && !d.drafts) return null;
      const val = sum(list, 'total');
      return {
        tone: posted ? (list.length ? 'good' : '') : list.some(x => !x.vendorCode) ? 'warn' : 'info',
        value: list.length,
        stats: posted
          ? [{ label: 'POs posted (24 h)', value: list.length, fmt: 'int' }, { label: 'Value', value: val, fmt: 'amt' },
              { label: 'Lines', value: sum(list, 'nLines'), fmt: 'int' }, { label: 'Vendors', value: new Set(list.map(x => x.vendorCode)).size, fmt: 'int' },
              { label: 'Vendor has e-mail', value: list.filter(x => x.vendorEmail).length, fmt: 'int' }, { label: 'Posted this session', value: (d.postedSession || []).length, fmt: 'int' }]
          : [{ label: 'Open drafts', value: list.length, fmt: 'int' }, { label: 'Value', value: val, fmt: 'amt' },
              { label: 'Lines', value: sum(list, 'nLines'), fmt: 'int' }, { label: 'Critical lines', value: sum(list, 'nCrit'), fmt: 'int' },
              { label: 'Vendor not assigned', value: list.filter(x => !x.vendorCode).length, fmt: 'int' }, { label: 'Vendor without e-mail', value: list.filter(x => x.vendorCode && !x.vendorEmail).length, fmt: 'int' }],
        chart: list.length > 1 ? { title: `${posted ? 'Posted' : 'Draft'} PO value by vendor`, type: 'bar', horizontal: true, labels: top(list, 'total', 10).map(x => x.vendorTxt),
          series: [{ name: 'Value', color: posted ? '#107E3E' : '#2563EB', values: top(list, 'total', 10).map(x => Math.round(x.total)) }] } : null,
        table: { title: posted ? 'Purchase orders posted in the last 24 hours' : 'Open draft POs — largest first',
          columns: [...(posted ? [{ key: 'docTxt', label: 'PO #' }] : []), { key: 'vendorTxt', label: 'Vendor', sub: 'vendorCode' }, { key: 'nLines', label: 'Lines', fmt: 'int' },
            ...(posted ? [] : [{ key: 'nCrit', label: 'Critical', fmt: 'int' }]), { key: 'deliveryDate', label: 'Delivery', fmt: 'date' }, { key: 'paymentTerms', label: 'Payment terms' },
            { key: 'emailTxt', label: 'E-mail', fmt: 'badge', badge: { Yes: 'green', No: 'red' } }, { key: 'total', label: 'Value', fmt: 'amt' }],
          rows: posted ? list : top(list, 'total', 50) },
        insight: !list.length ? (posted ? '**No PO posted from this agent in the last 24 hours.**' : '**No open draft POs.** Run MRP, select items and click Build Draft POs.')
          : posted
            ? `**${n(list.length, 'PO')} worth ${fa(val)} posted to SAP in the last 24 hours.**\n\n` +
              (list.filter(x => !x.vendorEmail).length ? `- ${list.filter(x => !x.vendorEmail).length} vendor(s) have no e-mail in SAP — send those POs another way.\n` : '- Every vendor has an e-mail address — use Email Vendor on each PO.\n') +
              '- If an approval procedure applies, the PO waits in SAP until approved — see Pending Approval.'
            : `**${n(list.length, 'draft PO')} worth ${fa(val)} ${list.length === 1 ? 'is' : 'are'} waiting to be posted (${sum(list, 'nLines')} lines, ${sum(list, 'nCrit')} critical).**\n\n` +
              (list.filter(x => !x.vendorCode).length ? '- One draft has no vendor — assign it before posting.\n' : '') +
              `- Largest: **${top(list, 'total', 1)[0].vendorTxt}** — ${fa(top(list, 'total', 1)[0].total)}.\n` +
              '- Quantities are in the purchasing unit; check them and the prices, then Post to SAP.',
      };
    }
    if (kpiId === 'mrp-kpi-approvals') {
      const a = d.approvals;
      if (!a) return null;
      const all = (a.requests || []).map(r => ({ ...r, typeTxt: r.isPurchaseOrder ? 'Purchase Order' : String(r.objectType || '—') }));
      const pos = all.filter(r => r.isPurchaseOrder);
      const today = Date.now();
      const age = r => (r.creationDate ? Math.max(0, Math.floor((today - new Date(r.creationDate).getTime()) / 86400000)) : null);
      const rowsA = pos.map(r => ({ ...r, ageDays: age(r) })).sort((x, z) => (z.ageDays ?? 0) - (x.ageDays ?? 0));
      const AGE = [['Today', x => x === 0], ['1–2 days', x => x >= 1 && x <= 2], ['3–7 days', x => x >= 3 && x <= 7], ['8+ days', x => x > 7]];
      return {
        tone: rowsA.some(r => r.ageDays > 2) ? 'warn' : pos.length ? 'info' : 'good',
        value: pos.length,
        stats: [{ label: 'POs pending approval', value: pos.length, fmt: 'int' }, { label: 'All pending requests', value: all.length, fmt: 'int' },
          { label: 'Waiting > 2 days', value: rowsA.filter(r => r.ageDays > 2).length, fmt: 'int' }, { label: 'Oldest (days)', value: rowsA[0]?.ageDays ?? 0, fmt: 'int' }],
        chart: pos.length ? { title: 'Pending PO approvals by age', type: 'bar', fmt: 'int', labels: AGE.map(x => x[0]),
          series: [{ name: 'Requests', color: '#F59E0B', values: AGE.map(([, t]) => rowsA.filter(r => r.ageDays != null && t(r.ageDays)).length) }] } : null,
        table: { title: 'Pending PO approval requests — oldest first', columns: [{ key: 'code', label: 'Request' }, { key: 'objectEntry', label: 'Doc entry' },
          { key: 'creationDate', label: 'Created', fmt: 'date' }, { key: 'ageDays', label: 'Age (d)', fmt: 'int' }, { key: 'remarks', label: 'Remarks' }], rows: rowsA },
        insight: pos.length ? `**${n(pos.length, 'purchase order')} ${pos.length === 1 ? 'is' : 'are'} waiting for approval in SAP${all.length > pos.length ? ` (${all.length} requests of all types)` : ''}.**\n\n` +
          (rowsA[0]?.ageDays != null ? `- Oldest: request **${rowsA[0].code}**, waiting ${rowsA[0].ageDays} day(s).\n` : '') +
          '- Chase the approvers — a PO is not sent to the vendor until it is approved.'
          : `**No purchase order is waiting for approval.**${all.length ? ` ${all.length} request(s) for other document types are pending.` : ''}${a.note ? `\n\n- Note: ${a.note}` : ''}`,
      };
    }
    return null;
  }

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

  // Rush Orders: one detail per KPI from the last /api/rush-orders/scan.
  function rushDetail(kpiId, d) {
    const s = d.summary || {}, all = (d.orders || []).map(o => ({
      ...o, value: Number(o.DocTotal) || 0, due: String(o.DocDueDate || '').slice(0, 10),
      daysTxt: o._daysLeft < 0 ? `${-o._daysLeft}d late` : o._daysLeft === 0 ? 'today' : `${o._daysLeft}d`,
      rec: o._aiRec?.recommendation || '', xcost: Number(o._aiRec?.expediteShippingCost) || 0,
      escalate: o._aiRec?.escalateTo || '', stock: o._aiRec?.stockStatus || '',
    }));
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sum = (l, k) => l.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const top = (l, k, n) => [...l].sort((a, z) => (Number(z[k]) || 0) - (Number(a[k]) || 0)).slice(0, n);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const TAGS = ['CRITICAL', 'URGENT', 'MONITOR', 'NORMAL'];
    const TAG_BADGE = { CRITICAL: 'red', URGENT: 'amber', MONITOR: 'blue', NORMAL: 'green' };
    const TAG_COLOR = { CRITICAL: '#BB0000', URGENT: '#E9730C', MONITOR: '#0070F2', NORMAL: '#107E3E' };
    const REC_BADGE = { APPROVE_EXPEDITE: 'green', HOLD: 'red', REVIEW: 'amber', CANCEL: 'grey' };
    const C = {
      no: { key: 'DocNum', label: 'Order #' }, cust: { key: 'CardName', label: 'Customer', sub: 'CardCode' },
      due: { key: 'due', label: 'Due', fmt: 'date' }, days: { key: 'daysTxt', label: 'Days left' },
      value: { key: 'value', label: 'Value', fmt: 'amt' }, score: { key: '_score', label: 'Score', fmt: 'score', invert: true },
      tag: { key: '_tag', label: 'Tag', fmt: 'badge', badge: TAG_BADGE }, rec: { key: 'rec', label: 'Recommendation', fmt: 'badge', badge: REC_BADGE },
      xcost: { key: 'xcost', label: 'Expedite cost', fmt: 'amt' }, esc: { key: 'escalate', label: 'Escalate to' },
    };
    const BANDS = [['Overdue', o => o._daysLeft < 0], ['Today', o => o._daysLeft === 0], ['1–3 days', o => o._daysLeft >= 1 && o._daysLeft <= 3],
      ['4–7 days', o => o._daysLeft >= 4 && o._daysLeft <= 7], ['8–14 days', o => o._daysLeft >= 8 && o._daysLeft <= 14], ['15+ days', o => o._daysLeft >= 15]];
    const dueChart = (title, list) => ({ title, type: 'bar', stacked: true, fmt: 'int', labels: BANDS.map(b => b[0]),
      series: TAGS.map(t => ({ name: t, color: TAG_COLOR[t], values: BANDS.map(([, f]) => list.filter(o => o._tag === t && f(o)).length) })).filter(x => x.values.some(Boolean)) });
    // Average points per score factor vs its maximum (from _scoreBreakdown).
    const factorChart = (title, list) => {
      const f = new Map();
      for (const o of list) for (const b of o._scoreBreakdown || []) {
        const e = f.get(b.factor) || { pts: 0, max: b.max || 0, n: 0 }; e.pts += Number(b.points) || 0; e.n++; f.set(b.factor, e);
      }
      if (!f.size) return null;
      const keys = [...f.keys()];
      return { title, type: 'bar', horizontal: true, fmt: 'num', labels: keys,
        series: [{ name: 'Avg points', values: keys.map(k => Math.round(f.get(k).pts / f.get(k).n * 10) / 10) }, { name: 'Max', color: '#94A3B8', values: keys.map(k => f.get(k).max) }] };
    };
    const byCust = list => [...list.reduce((m, o) => m.set(o.CardName || o.CardCode, (m.get(o.CardName || o.CardCode) || 0) + o.value), new Map())].sort((a, z) => z[1] - a[1]);
    const lbl = o => `#${o.DocNum} ${String(o.CardName || o.CardCode || '').slice(0, 30)}`;
    const crit = all.filter(o => o._tag === 'CRITICAL'), urg = all.filter(o => o._tag === 'URGENT'), analysed = crit.concat(urg);

    if (kpiId === 'ro-kpi-total') {
      const cs = byCust(all);
      return {
        stats: [{ label: 'Orders scanned', value: all.length, fmt: 'int' }, { label: 'Total value', value: sum(all, 'value'), fmt: 'amt' },
          { label: 'Overdue', value: all.filter(o => o._daysLeft < 0).length, fmt: 'int' }, { label: 'Due today', value: all.filter(o => o._daysLeft === 0).length, fmt: 'int' },
          { label: 'Average score', value: all.length ? sum(all, '_score') / all.length : 0, fmt: 'int' }, { label: 'Customers', value: cs.length, fmt: 'int' }],
        chart: dueChart('Orders by due date and urgency tag', all),
        table: { title: 'Highest urgency first', columns: [C.no, C.cust, C.due, C.days, C.value, C.score, C.tag], rows: all.slice(0, 25) },
        insight: `**${all.length} open orders are due within ${d.days} days, worth ${fa(sum(all, 'value'))}: ${s.critical || 0} critical, ${s.urgent || 0} urgent, ${s.monitor || 0} monitor, ${s.normal || 0} normal.**\n\n` +
          (all[0] ? `- Most urgent: **${lbl(all[0])}** — score ${all[0]._score}, due ${all[0].due} (${all[0].daysTxt}), value ${fa(all[0].value)}.\n` : '') +
          (cs[0] ? `- Largest customer in the window: **${cs[0][0]}** — ${fa(cs[0][1])}.\n` : '') +
          `- ${all.filter(o => o._daysLeft < 0).length} orders are already overdue.`,
      };
    }
    if (kpiId === 'ro-kpi-critical' || kpiId === 'ro-kpi-urgent') {
      const isC = kpiId === 'ro-kpi-critical', rows = isC ? crit : urg, name = isC ? 'critical' : 'urgent';
      const hold = rows.filter(o => o.rec === 'HOLD'), appr = rows.filter(o => o._aiRec?.autoApprove);
      return {
        tone: rows.length ? (isC ? 'bad' : 'warn') : 'good',
        stats: [{ label: `${isC ? 'Critical' : 'Urgent'} orders`, value: rows.length, fmt: 'int' }, { label: 'Value', value: sum(rows, 'value'), fmt: 'amt' },
          { label: 'Overdue', value: rows.filter(o => o._daysLeft < 0).length, fmt: 'int' }, { label: 'Average score', value: rows.length ? sum(rows, '_score') / rows.length : 0, fmt: 'int' },
          { label: 'Stock hold', value: hold.length, fmt: 'int' }, { label: 'Auto-approved', value: appr.length, fmt: 'int' }],
        chart: factorChart(`What drives the score (average points per factor, ${name} orders)`, rows) || dueChart('By due date', rows),
        table: { title: `${isC ? 'Critical' : 'Urgent'} orders — highest score first`, columns: [C.no, C.cust, C.due, C.days, C.value, C.score, C.rec, C.esc], rows },
        insight: rows.length ? `**${rows.length} ${name} orders worth ${fa(sum(rows, 'value'))}; ${hold.length} are blocked by stock and ${appr.length} are auto-approved for expediting.**\n\n` +
          `- Top order: **${lbl(rows[0])}** — score ${rows[0]._score}, ${rows[0].daysTxt}, ${fa(rows[0].value)}${rows[0].rec ? `, recommendation ${rows[0].rec}` : ''}.\n` +
          `- ${rows.filter(o => o._daysLeft < 0).length} are already overdue; ${rows.filter(o => o.escalate === 'Sales Director').length} escalate to the Sales Director (score ≥ 85).\n` +
          (hold.length ? `- Resolve stock for the ${hold.length} HOLD orders first — they cannot ship even if expedited.` : '- All are in stock — book express shipping for the approved ones.')
          : `**No ${name} orders in the current window.**`,
      };
    }
    if (kpiId === 'ro-kpi-overdue') {
      const rows = all.filter(o => o._daysLeft < 0).sort((a, z) => a._daysLeft - z._daysLeft);
      const bands = [['1–3 days', x => x <= 3], ['4–7 days', x => x >= 4 && x <= 7], ['8–30 days', x => x >= 8 && x <= 30], ['31+ days', x => x > 30]];
      return {
        tone: rows.length ? 'bad' : 'good',
        stats: [{ label: 'Overdue orders', value: rows.length, fmt: 'int' }, { label: 'Value', value: sum(rows, 'value'), fmt: 'amt' },
          { label: 'Oldest (days late)', value: rows.length ? -rows[0]._daysLeft : 0, fmt: 'int' }, { label: 'Critical', value: rows.filter(o => o._tag === 'CRITICAL').length, fmt: 'int' },
          { label: 'Stock hold', value: rows.filter(o => o.rec === 'HOLD').length, fmt: 'int' }, { label: 'Customers', value: byCust(rows).length, fmt: 'int' }],
        chart: rows.length ? { title: 'Overdue orders by days late', type: 'bar', fmt: 'int', labels: bands.map(b => b[0]),
          series: [{ name: 'Orders', color: '#BB0000', values: bands.map(([, f]) => rows.filter(o => f(-o._daysLeft)).length) }] } : null,
        table: { title: 'Overdue orders — most late first', columns: [C.no, C.cust, C.due, C.days, C.value, C.tag, C.rec], rows },
        insight: rows.length ? `**${rows.length} orders worth ${fa(sum(rows, 'value'))} are past their due date; the oldest is ${-rows[0]._daysLeft} days late.**\n\n` +
          `- Oldest: **${lbl(rows[0])}** — due ${rows[0].due}, ${fa(rows[0].value)}.\n` +
          (byCust(rows)[0] ? `- Most affected customer: **${byCust(rows)[0][0]}** — ${fa(byCust(rows)[0][1])}.\n` : '') +
          '- Give these customers a confirmed new date today; split-ship what is in stock.' : '**No scanned order is past its due date.**',
      };
    }
    if (kpiId === 'ro-kpi-hold') {
      const rows = analysed.filter(o => o.rec === 'HOLD');
      const cs = byCust(rows);
      return {
        tone: rows.length ? 'warn' : 'good',
        stats: [{ label: 'Orders on hold', value: rows.length, fmt: 'int' }, { label: 'Value blocked', value: sum(rows, 'value'), fmt: 'amt' },
          { label: '% of urgent orders', value: pct(rows.length, analysed.length), fmt: 'pct' }, { label: 'Fully out of stock', value: rows.filter(o => o.stock === 'OUT_OF_STOCK').length, fmt: 'int' },
          { label: 'Partly in stock', value: rows.filter(o => o.stock === 'PARTIAL').length, fmt: 'int' }, { label: 'Critical among them', value: rows.filter(o => o._tag === 'CRITICAL').length, fmt: 'int' }],
        chart: cs.length > 1 ? { title: 'Blocked value by customer (top 10)', type: 'bar', horizontal: true, labels: cs.slice(0, 10).map(c => c[0]), series: [{ name: 'Value', color: '#E9730C', values: cs.slice(0, 10).map(c => Math.round(c[1])) }] } : null,
        table: { title: 'Urgent orders blocked by stock', columns: [C.no, C.cust, C.due, C.days, C.value, C.tag, { key: 'stock', label: 'Stock', fmt: 'badge', badge: { OUT_OF_STOCK: 'red', PARTIAL: 'amber' } }], rows },
        insight: rows.length ? `**${rows.length} critical/urgent orders worth ${fa(sum(rows, 'value'))} cannot ship because stock is short.**\n\n` +
          `- Largest: **${lbl(top(rows, 'value', 1)[0])}** — ${fa(top(rows, 'value', 1)[0].value)}, ${top(rows, 'value', 1)[0].stock === 'OUT_OF_STOCK' ? 'nothing in stock' : 'partly in stock'}.\n` +
          `- ${rows.filter(o => o.stock === 'PARTIAL').length} could ship partially now.\n` +
          '- Check other warehouses, request emergency replenishment, and agree partial deliveries with the customers.' : '**No critical or urgent order is blocked by stock.**',
      };
    }
    if (kpiId === 'ro-kpi-approved' || kpiId === 'ro-kpi-revenue') {
      const rows = analysed.filter(o => o._aiRec?.autoApprove);
      const isRev = kpiId === 'ro-kpi-revenue';
      const cost = sum(rows, 'xcost'), rev = sum(rows, 'value'), roi = cost ? rev / cost : 0;
      const over = analysed.filter(o => o.rec !== 'HOLD' && !o._aiRec?.autoApprove && o._aiRec);
      return {
        tone: rows.length ? 'good' : '',
        stats: [{ label: 'Auto-approved orders', value: rows.length, fmt: 'int' }, { label: 'Revenue protected', value: rev, fmt: 'amt' },
          { label: 'Their expedite cost', value: cost, fmt: 'amt' }, { label: 'ROI (revenue ÷ cost)', value: Math.round(roi * 10) / 10, fmt: 'num' },
          { label: 'Over cost limit (review)', value: over.length, fmt: 'int' }, { label: 'Max auto-approve cost', value: d.maxCost, fmt: 'amt' }],
        chart: rows.length ? { title: isRev ? 'Revenue protected vs expedite cost (top 10)' : 'Expedite cost vs order value (top 10)', type: 'bar', horizontal: true,
          labels: top(rows, 'value', 10).map(lbl), series: [{ name: 'Order value', color: '#107E3E', values: top(rows, 'value', 10).map(o => o.value) }, { name: 'Expedite cost', color: '#0070F2', values: top(rows, 'value', 10).map(o => o.xcost) }] } : null,
        table: { title: 'Auto-approved orders — largest value first', columns: [C.no, C.cust, C.due, C.value, C.xcost, C.score, C.esc], rows: top(rows, 'value', 50) },
        insight: rows.length ? `**${rows.length} orders worth ${fa(rev)} are approved for expediting at a cost of ${fa(cost)} — ${roi >= 10 ? Math.round(roi) : roi.toFixed(1)}× return.**\n\n` +
          `- Largest: **${lbl(top(rows, 'value', 1)[0])}** — ${fa(top(rows, 'value', 1)[0].value)} for ${fa(top(rows, 'value', 1)[0].xcost)} expedite cost.\n` +
          (over.length ? `- ${over.length} more in-stock orders exceed the ${fa(d.maxCost)} limit and need manual review.\n` : '') +
          '- Book express carriers and confirm the ship date to these customers.' : `**No order is auto-approved.** ${over.length ? `${over.length} in-stock orders exceed the ${fa(d.maxCost)} cost limit — raise the limit or review them.` : ''}`,
      };
    }
    if (kpiId === 'ro-kpi-xcost') {
      const rows = analysed.filter(o => o.xcost > 0);
      const cost = sum(rows, 'xcost'), apprCost = sum(rows.filter(o => o._aiRec?.autoApprove), 'xcost');
      return {
        tone: 'info',
        stats: [{ label: 'Total expedite cost', value: cost, fmt: 'amt' }, { label: 'Orders', value: rows.length, fmt: 'int' },
          { label: 'Average per order', value: rows.length ? cost / rows.length : 0, fmt: 'amt' }, { label: 'Within limit (approved)', value: apprCost, fmt: 'amt' },
          { label: 'Over limit (review)', value: cost - apprCost, fmt: 'amt' }, { label: 'Cost as % of order value', value: pct(cost, sum(rows, 'value')), fmt: 'pct' }],
        chart: rows.length ? { title: 'Largest expedite costs (top 10)', type: 'bar', horizontal: true, labels: top(rows, 'xcost', 10).map(lbl),
          series: [{ name: 'Expedite cost', color: '#0070F2', values: top(rows, 'xcost', 10).map(o => o.xcost) }] } : null,
        table: { title: 'Expedite cost per order', columns: [C.no, C.cust, C.value, C.xcost, { key: 'auto', label: 'Auto-approved' }, C.esc],
          rows: top(rows, 'xcost', 50).map(o => ({ ...o, auto: o._aiRec?.autoApprove ? 'Yes' : 'No — over limit' })) },
        insight: rows.length ? `**Expediting the ${rows.length} in-stock critical/urgent orders would cost ${fa(cost)} (${pct(cost, sum(rows, 'value'))}% of their value).**\n\n` +
          `- ${fa(apprCost)} is within the ${fa(d.maxCost)} per-order limit and auto-approved; ${fa(cost - apprCost)} needs review.\n` +
          `- Biggest single cost: **${lbl(top(rows, 'xcost', 1)[0])}** — ${fa(top(rows, 'xcost', 1)[0].xcost)}.\n` +
          '- Estimate: order value × 2.5% + 150, capped at 10 × the limit — replace with real carrier quotes for the largest ones.' : '**No expedite cost — no in-stock critical or urgent orders.**',
      };
    }
    return null;
  }

  // Production Agent: one detail per KPI from the last /api/production/orders.
  function productionDetail(kpiId, d) {
    const s = d.summary || {};
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sum = (l, k) => l.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const avg = (l, k) => (l.length ? sum(l, k) / l.length : 0);
    const top = (l, k, n) => [...l].sort((a, z) => (Number(z[k]) || 0) - (Number(a[k]) || 0)).slice(0, n);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const n = (c, w, ws = w + 's') => `${c} ${c === 1 ? w : ws}`;
    const are = c => (c === 1 ? 'is' : 'are');
    const RISKS = ['CRITICAL', 'HIGH', 'MEDIUM', 'OK'];
    const RISK_BADGE = { CRITICAL: 'red', HIGH: 'amber', MEDIUM: 'blue', OK: 'green' };
    const RISK_COLOR = { CRITICAL: '#BB0000', HIGH: '#E9730C', MEDIUM: '#E8A200', OK: '#107E3E' };
    const SEV = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, OK: 3 };
    const orders = (d.orders || []).map(o => {
      const short = (o.components || []).filter(c => c.shortage > 0).sort((a, z) => (a.pctCovered ?? 100) - (z.pctCovered ?? 100));
      const w = short[0];
      return {
        ...o,
        riskTag: { critical: 'CRITICAL', high: 'HIGH', medium: 'MEDIUM', ok: 'OK' }[o.risk] || String(o.risk || '').toUpperCase(),
        donePct: o.plannedQty > 0 ? Math.round(((o.completedQty || 0) / o.plannedQty) * 1000) / 10 : 0,
        daysTxt: o.daysUntilDue == null ? '—' : o.daysUntilDue < 0 ? `${-o.daysUntilDue}d late` : o.daysUntilDue === 0 ? 'today' : `${o.daysUntilDue}d`,
        shortVal: short.reduce((t, c) => t + c.shortage * (c.unitCost || 0), 0),
        worstTxt: w ? `${w.itemCode} — ${w.pctCovered ?? 0}% covered` : '—',
        _short: short,
      };
    });
    const C = {
      no: { key: 'docNum', label: 'Order #' }, prod: { key: 'productName', label: 'Product', sub: 'itemCode' },
      due: { key: 'docDueDate', label: 'Due', fmt: 'date' }, days: { key: 'daysTxt', label: 'Days left' },
      risk: { key: 'riskTag', label: 'Risk', fmt: 'badge', badge: RISK_BADGE }, short: { key: 'shortageCount', label: 'Short comps', fmt: 'int' },
      done: { key: 'donePct', label: 'Done', fmt: 'pct' }, qty: { key: 'plannedQty', label: 'Planned qty', fmt: 'num' },
      worst: { key: 'worstTxt', label: 'Weakest component' }, sval: { key: 'shortVal', label: 'Shortage value', fmt: 'amt' },
    };
    const lbl = o => `#${o.docNum} ${String(o.productName || o.itemCode || '').slice(0, 30)}`;
    const bySoonest = l => [...l].sort((a, z) => (a.daysUntilDue ?? 9999) - (z.daysUntilDue ?? 9999));
    const byRiskThenDue = l => [...l].sort((a, z) => SEV[a.riskTag] - SEV[z.riskTag] || (a.daysUntilDue ?? 9999) - (z.daysUntilDue ?? 9999));
    const DUE_BANDS = [['Overdue', x => x != null && x < 0], ['0–7 days', x => x != null && x >= 0 && x <= 7], ['8–14 days', x => x >= 8 && x <= 14],
      ['15–30 days', x => x >= 15 && x <= 30], ['31+ days', x => x > 30], ['No due date', x => x == null]];
    const riskChart = (title, list, bands, f) => ({ title, type: 'bar', stacked: true, fmt: 'int', labels: bands.map(b => b[0]),
      series: RISKS.map(r => ({ name: r === 'OK' ? 'On track' : r, color: RISK_COLOR[r], values: bands.map(([, t]) => list.filter(o => o.riskTag === r && t(f(o))).length) }))
        .filter(x => x.values.some(Boolean)) });
    // Component view across a set of orders: shortage per order summed (as the Component Shortage tab),
    // plus the combined gap = all still-needed qty on open orders − free stock.
    const compsOf = list => {
      const m = new Map();
      for (const o of orders) for (const c of o.components || []) {
        const e = m.get(c.itemCode) || { itemCode: c.itemCode, itemName: c.itemName, available: Number(c.available) || 0, onOrder: Number(c.onOrder) || 0,
          unitCost: Number(c.unitCost) || 0, needAll: 0, totalShortage: 0, nums: [] };
        e.needAll += Number(c.needed) || 0;
        if (c.shortage > 0 && list.includes(o)) { e.totalShortage += c.shortage; e.nums.push(o.docNum); }
        m.set(c.itemCode, e);
      }
      return [...m.values()].filter(e => e.totalShortage > 0).map(e => {
        const netGap = Math.max(0, e.needAll - Math.max(0, e.available));
        return { ...e, value: e.totalShortage * e.unitCost, netGap, netGapVal: netGap * e.unitCost, nOrders: e.nums.length,
          poCover: netGap <= 0 ? 'OK' : e.onOrder >= netGap ? 'YES' : e.onOrder > 0 ? 'PARTIAL' : 'NONE',
          ordersTxt: e.nums.slice(0, 6).map(n => `#${n}`).join(', ') + (e.nums.length > 6 ? ` +${e.nums.length - 6}` : '') };
      }).sort((a, z) => z.value - a.value || z.totalShortage - a.totalShortage);
    };
    const compChart = (title, comps, color) => (comps.length ? { title, type: 'bar', horizontal: true, fmt: 'int', labels: top(comps, 'nOrders', 10).map(c => c.itemCode),
      series: [{ name: 'Orders affected', color, values: top(comps, 'nOrders', 10).map(c => c.nOrders) }] } : null);
    const total = orders.length;
    const atRisk = orders.filter(o => o.riskTag !== 'OK');

    if (kpiId === 'prod-kpi-total') {
      const ready = orders.filter(o => o.riskTag === 'OK');
      return {
        tone: 'info',
        stats: [{ label: 'Open orders', value: total, fmt: 'int' }, { label: 'Ready to produce', value: ready.length, fmt: 'int' },
          { label: 'Blocked / at risk', value: atRisk.length, fmt: 'int' }, { label: 'Due this week', value: s.dueThisWeek, fmt: 'int' },
          { label: 'Overdue', value: s.overdue, fmt: 'int' }, { label: 'Avg completion', value: avg(orders, 'donePct'), fmt: 'pct' }],
        chart: total ? riskChart('Open orders by due date and risk', orders, DUE_BANDS, o => o.daysUntilDue) : null,
        table: { title: 'Open orders — highest risk and soonest due first', columns: [C.no, C.prod, C.due, C.days, C.risk, C.short, C.done], rows: byRiskThenDue(orders).slice(0, 50) },
        insight: total ? `**${total} open production orders: ${ready.length} (${pct(ready.length, total)}%) are ready to run, ${atRisk.length} are short of material.**\n\n` +
          `- Critical ${s.critical || 0} · High ${s.high || 0} · Medium ${s.medium || 0} · On track ${ready.length}.\n` +
          `- ${s.dueThisWeek || 0} due within 7 days, ${s.overdue || 0} already overdue.\n` +
          `- Average completion across open orders is ${Math.round(avg(orders, 'donePct'))}%.\n` +
          '- Run the ready orders first and source the components for the critical ones.' : '**No open production orders.**',
      };
    }
    if (kpiId === 'prod-kpi-critical' || kpiId === 'prod-kpi-high' || kpiId === 'prod-kpi-medium') {
      const tag = kpiId === 'prod-kpi-critical' ? 'CRITICAL' : kpiId === 'prod-kpi-high' ? 'HIGH' : 'MEDIUM';
      const name = tag.toLowerCase();
      const rows = bySoonest(orders.filter(o => o.riskTag === tag));
      const comps = compsOf(rows);
      const zero = comps.filter(c => c.available <= 0);
      const soon = rows.filter(o => o.daysUntilDue != null && o.daysUntilDue <= 7);
      const first = rows.find(o => o.daysUntilDue != null);
      const mostBlocking = top(comps, 'nOrders', 1)[0];
      return {
        tone: rows.length ? (tag === 'CRITICAL' ? 'bad' : 'warn') : 'good',
        stats: [{ label: `${tag[0] + name.slice(1)} orders`, value: rows.length, fmt: 'int' }, { label: '% of open orders', value: pct(rows.length, total), fmt: 'pct' },
          { label: 'Due ≤ 7 days / overdue', value: soon.length, fmt: 'int' }, { label: 'Short components', value: comps.length, fmt: 'int' },
          tag === 'CRITICAL' ? { label: 'Components with zero stock', value: zero.length, fmt: 'int' } : { label: 'Avg weakest coverage', value: avg(rows.map(o => ({ v: o._short[0]?.pctCovered ?? 100 })), 'v'), fmt: 'pct' },
          { label: 'Shortage value', value: sum(rows, 'shortVal'), fmt: 'amt' }],
        chart: compChart(tag === 'CRITICAL' ? 'Components blocking critical orders (orders affected, top 10)' : `Short components on ${name}-risk orders (top 10)`, tag === 'CRITICAL' ? zero : comps, RISK_COLOR[tag]),
        table: { title: `${tag[0] + name.slice(1)}-risk orders — soonest due first`, columns: [C.no, C.prod, C.due, C.days, C.short, C.worst, C.sval], rows },
        insight: !rows.length ? `**No ${name}-risk production orders right now.**`
          : `**${n(rows.length, 'production order')} ${are(rows.length)} ${name} risk (${pct(rows.length, total)}% of open orders); ${soon.length} due within 7 days or overdue.**\n\n` +
            (first ? `- Due first: **${lbl(first)}** on ${first.docDueDate} (${first.daysTxt}) — weakest component ${first.worstTxt}.\n` : '') +
            (mostBlocking ? `- Component blocking the most orders: **${mostBlocking.itemCode}** ${mostBlocking.itemName ? `(${mostBlocking.itemName}) ` : ''}— ${n(mostBlocking.nOrders, 'order')}, short ${fa(mostBlocking.totalShortage)}, ${mostBlocking.onOrder ? `${fa(mostBlocking.onOrder)} on open POs` : 'nothing on order'}.\n` : '') +
            `- Material needed to unblock them: about ${fa(sum(rows, 'shortVal'))}.\n` +
            (tag === 'CRITICAL' ? '- Expedite or emergency-source the zero-stock components, or reschedule these orders and tell sales.'
              : tag === 'HIGH' ? '- Raise purchase requests now and confirm open POs arrive before the due dates.'
              : '- Run partial batches with the stock on hand and line up backup sourcing for the rest.'),
      };
    }
    if (kpiId === 'prod-kpi-dueweek') {
      const rows = bySoonest(orders.filter(o => o.daysUntilDue != null && o.daysUntilDue >= 0 && o.daysUntilDue <= 7));
      const notReady = rows.filter(o => o.riskTag !== 'OK');
      const days = Array.from({ length: 8 }, (_, i) => [i === 0 ? 'Today' : `+${i}d`, x => x === i]);
      return {
        tone: notReady.some(o => o.riskTag === 'CRITICAL') ? 'bad' : notReady.length ? 'warn' : rows.length ? 'good' : '',
        stats: [{ label: 'Due this week', value: rows.length, fmt: 'int' }, { label: 'Ready to produce', value: rows.length - notReady.length, fmt: 'int' },
          { label: 'Critical', value: rows.filter(o => o.riskTag === 'CRITICAL').length, fmt: 'int' }, { label: 'High', value: rows.filter(o => o.riskTag === 'HIGH').length, fmt: 'int' },
          { label: 'Medium', value: rows.filter(o => o.riskTag === 'MEDIUM').length, fmt: 'int' }, { label: 'Avg completion', value: avg(rows, 'donePct'), fmt: 'pct' }],
        chart: rows.length ? riskChart('Orders due per day (next 7 days) by risk', rows, days, o => o.daysUntilDue) : null,
        table: { title: 'Orders due this week — soonest first', columns: [C.no, C.prod, C.due, C.days, C.risk, C.done, C.worst], rows },
        insight: rows.length ? `**${n(rows.length, 'order')} due in the next 7 days; ${notReady.length} still short of material.**\n\n` +
          (rows[0] ? `- Due first: **${lbl(rows[0])}** — ${rows[0].daysTxt}, ${rows[0].donePct}% done, risk ${rows[0].riskTag === 'OK' ? 'on track' : rows[0].riskTag}.\n` : '') +
          (notReady.length ? `- Not ready: ${notReady.slice(0, 4).map(o => `#${o.docNum}`).join(', ')}${notReady.length > 4 ? ` +${notReady.length - 4}` : ''} — source their components today or move the dates.\n` : '- All of them have their materials covered.\n') +
          '- Confirm machine and labour capacity for this week\'s orders.' : '**No production order is due in the next 7 days.**',
      };
    }
    if (kpiId === 'prod-kpi-overdue') {
      const rows = orders.filter(o => o.daysUntilDue != null && o.daysUntilDue < 0).sort((a, z) => a.daysUntilDue - z.daysUntilDue);
      const late = o => -o.daysUntilDue;
      const bands = [['1–7d late', x => x >= 1 && x <= 7], ['8–30d late', x => x >= 8 && x <= 30], ['31–90d late', x => x >= 31 && x <= 90], ['90+d late', x => x > 90]];
      const ready = rows.filter(o => o.riskTag === 'OK');
      return {
        tone: rows.length ? 'bad' : 'good',
        stats: [{ label: 'Overdue orders', value: rows.length, fmt: 'int' }, { label: 'Oldest (days late)', value: rows.length ? late(rows[0]) : 0, fmt: 'int' },
          { label: 'Avg days late', value: rows.length ? rows.reduce((t, o) => t + late(o), 0) / rows.length : 0, fmt: 'num' }, { label: 'Still short of material', value: rows.length - ready.length, fmt: 'int' },
          { label: 'Materials OK (just finish)', value: ready.length, fmt: 'int' }, { label: 'Not started (0% done)', value: rows.filter(o => !o.completedQty).length, fmt: 'int' }],
        chart: rows.length ? riskChart('Overdue orders by days late and risk', rows, bands, late) : null,
        table: { title: 'Overdue orders — most late first', columns: [C.no, C.prod, C.due, C.days, C.risk, C.done, C.worst], rows },
        insight: rows.length ? `**${n(rows.length, 'open production order')} past the due date; the oldest is ${n(late(rows[0]), 'day')} late.**\n\n` +
          `- Oldest: **${lbl(rows[0])}** — due ${rows[0].docDueDate}, ${rows[0].donePct}% done.\n` +
          `- Materials OK (only need finishing and reporting): ${ready.length} · still waiting for components: ${rows.length - ready.length}.\n` +
          (rows.filter(o => o.donePct >= 100).length ? `- ${rows.filter(o => o.donePct >= 100).length} are 100% complete — close them in SAP.\n` : '') +
          '- Set realistic new due dates in SAP so planning and sales see the true schedule.' : '**No open production order is past its due date.**',
      };
    }
    if (kpiId === 'prod-kpi-ready') {
      const rows = bySoonest(orders.filter(o => o.riskTag === 'OK'));
      return {
        tone: rows.length ? 'good' : 'warn',
        stats: [{ label: 'Ready to produce', value: rows.length, fmt: 'int' }, { label: 'Readiness', value: pct(rows.length, total), fmt: 'pct' },
          { label: 'Due ≤ 7 days', value: rows.filter(o => o.daysUntilDue != null && o.daysUntilDue >= 0 && o.daysUntilDue <= 7).length, fmt: 'int' },
          { label: 'Overdue (finish now)', value: rows.filter(o => o.daysUntilDue != null && o.daysUntilDue < 0).length, fmt: 'int' },
          { label: 'Not started (0% done)', value: rows.filter(o => !o.completedQty).length, fmt: 'int' }, { label: 'Avg completion', value: avg(rows, 'donePct'), fmt: 'pct' }],
        chart: total ? { title: 'Ready vs short of material, by due date', type: 'bar', stacked: true, fmt: 'int', labels: DUE_BANDS.map(b => b[0]),
          series: [{ name: 'Ready', color: RISK_COLOR.OK, values: DUE_BANDS.map(([, t]) => rows.filter(o => t(o.daysUntilDue)).length) },
            { name: 'Short of material', color: RISK_COLOR.CRITICAL, values: DUE_BANDS.map(([, t]) => atRisk.filter(o => t(o.daysUntilDue)).length) }] } : null,
        table: { title: 'Orders ready to produce — soonest due first', columns: [C.no, C.prod, C.due, C.days, C.qty, C.done, { key: 'componentCount', label: 'Components', fmt: 'int' }], rows },
        insight: rows.length ? `**${rows.length} of ${total} open orders (${pct(rows.length, total)}%) have every component covered and can run now.**\n\n` +
          (rows[0] ? `- Due first: **${lbl(rows[0])}** — ${rows[0].daysTxt}, ${rows[0].donePct}% done.\n` : '') +
          `- Not started yet: ${rows.filter(o => !o.completedQty).length} — release them to the shop floor.\n` +
          '- Free stock is checked per order, so release orders that share components in due-date order.'
          : `**No open order has all its materials covered.** ${atRisk.length} orders are short — see Critical / High / Medium.`,
      };
    }
    if (kpiId === 'prod-kpi-shortval') {
      const comps = compsOf(atRisk);
      const val = sum(comps, 'value');
      const top3 = comps.slice(0, 3), top3v = sum(top3, 'value');
      const noPrice = comps.filter(c => !c.unitCost);
      return {
        tone: val > 0 ? 'bad' : comps.length ? 'warn' : 'good',
        value: val,
        stats: [{ label: 'Shortage value', value: val, fmt: 'amt' }, { label: 'Short components', value: comps.length, fmt: 'int' },
          { label: 'Combined gap value', value: sum(comps, 'netGapVal'), fmt: 'amt' }, { label: 'Fully covered by open POs', value: comps.filter(c => c.poCover === 'YES').length, fmt: 'int' },
          { label: 'Nothing on order', value: comps.filter(c => c.poCover === 'NONE').length, fmt: 'int' }, { label: 'Without a price', value: noPrice.length, fmt: 'int' }],
        chart: comps.length ? { title: 'Shortage value by component (top 10)', type: 'bar', horizontal: true, labels: comps.slice(0, 10).map(c => c.itemCode),
          series: [{ name: 'Shortage value', color: RISK_COLOR.CRITICAL, values: comps.slice(0, 10).map(c => Math.round(c.value)) }] } : null,
        table: { title: 'Short components — highest value first',
          columns: [{ key: 'itemCode', label: 'Component', sub: 'itemName' }, { key: 'totalShortage', label: 'Shortage', fmt: 'num' }, { key: 'unitCost', label: 'Avg price', fmt: 'price' },
            { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'available', label: 'Free stock', fmt: 'num' }, { key: 'netGap', label: 'Combined gap', fmt: 'num' },
            { key: 'onOrder', label: 'On open POs', fmt: 'num' }, { key: 'poCover', label: 'PO covers gap', fmt: 'badge', badge: { YES: 'green', PARTIAL: 'amber', NONE: 'red', OK: 'green' } },
            { key: 'ordersTxt', label: 'Orders' }],
          rows: comps },
        insight: comps.length ? `**${n(comps.length, 'component')} short, worth about ${fa(val)} at average price.**\n\n` +
          (top3.length ? `- Top ${top3.length}: ${top3.map(c => `**${c.itemCode}** ${fa(c.value)}`).join(', ')} — ${pct(top3v, val)}% of the value.\n` : '') +
          `- Combined gap (all open orders together vs free stock): ${fa(sum(comps, 'netGapVal'))}.\n` +
          `- Nothing on order for ${n(comps.filter(c => c.poCover === 'NONE').length, 'component')} — raise purchase requests for these first.\n` +
          (noPrice.length ? `- ${n(noPrice.length, 'component')} without a price in SAP, so the true value is higher.\n` : '')
          : '**No material is missing for open production orders.**',
      };
    }
    return null;
  }

  // ── Sales & pricing screens ────────────────────────────────────────────────
  const aiReply = r => (!r.reply || /^AI not configured|^Unable to (process|complete)|^I was unable|^Please load data first|^No data loaded/.test(r.reply) ? null : { text: r.reply, source: 'ai' });
  const AI_FORMAT = 'Reply in concise markdown: a bold one-line headline, then "**What drives it**" (2-4 bullets naming the items, customers or orders and amounts), ' +
    '"**Watch out**" (1-2 bullets) and "**Next actions**" (2-3 bullets). Use only the figures given; do not call any tools; amounts are in local currency, no currency symbols.';

  RICH['dynamic-pricing-panel'] = {
    data: () => window.dpScanData,
    build: pricingDetail,
    footnote: 'Live from SAP Business One — refreshed each time you click Analyse (12 months of sales history).',
    ai: (K, detail, value) => postJson('/api/pricing/chat', {
      sessionId: `kpi_${Date.now()}`,
      message: `Explain the "${K.label}" KPI (value ${value}) on the Dynamic Pricing dashboard to a sales / pricing manager. ${AI_FORMAT}\n\n` +
        `Formula: ${(K.calc || []).join(' ').replace(/\*\*/g, '')}\nStats: ${JSON.stringify(detail.stats)}\nTop rows: ${JSON.stringify((detail.table?.rows || []).slice(0, 15).map(r => { const { explain, factors, ...rest } = r; return rest; }))}`,
    }).then(aiReply),
  };
  RICH['sales-analysis-panel'] = {
    data: () => saState()?.data,
    build: salesDetail,
    footnote: 'Live from the SAP Business One analytics views — refreshed on Analyze, view tab or Documents change.',
    ai: (K, detail, value) => {
      const st = saState();
      const rows = (detail.table?.rows || []).slice(0, 15).map(r => `  ${r._label || r._key}: ${detail.table.columns.slice(1).map(c => `${c.label} ${r[c.key] == null ? '—' : typeof r[c.key] === 'number' ? Math.round(r[c.key] * 100) / 100 : r[c.key]}`).join(', ')}`).join('\n');
      return postJson('/api/sales-analysis/chat', {
        sessionId: `kpi_${Date.now()}`, activeView: st?.view,
        dataContext: `KPI: ${K.label} = ${value}\nFormula: ${(K.calc || []).join(' ').replace(/\*\*/g, '')}\n` +
          `Stats: ${detail.stats.map(s => `${s.label} ${typeof s.value === 'number' ? Math.round(s.value * 100) / 100 : s.value}`).join(' | ')}\n${detail.table?.title || 'Rows'}:\n${rows}`,
        message: `Explain the "${K.label}" KPI (value ${value}) on the Sales Analysis dashboard to a sales manager. ${AI_FORMAT}`,
      }).then(aiReply);
    },
  };
  RICH['soc-panel'] = {
    data: () => window.socScanData,
    build: socDetail,
    footnote: 'Live from SAP Business One — refreshed each time you click Go.',
  };

  // Dynamic Pricing: one detail per KPI from the last /api/pricing/analysis.
  function pricingDetail(kpiId, d) {
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sum = (l, f) => l.reduce((t, r) => t + (Number(f(r)) || 0), 0);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const n = (c, w) => `${c} ${c === 1 ? w : w + 's'}`;
    const mt = Number(d.marginTarget) || 30;
    const items = (d.items || []).map(it => {
      const f = it.factors || {}, dm = f.demand || {}, inv = f.inventory || {}, mg = f.margin || {};
      const cost = Number(mg.costPrice) || 0, qty = Number(dm.quantity) || 0;
      return {
        ...it, rev12: dm.revenue || 0, qty12: qty, demand: dm.signal || 'none', onHand: inv.onHand || 0, marginSignal: mg.signal,
        cost, marginNow: cost > 0 ? mg.currentPct : null,
        marginAfter: cost > 0 && it.suggestedPrice > 0 ? Math.round(((it.suggestedPrice - cost) / it.suggestedPrice) * 1000) / 10 : null,
        revImpact: qty * (it.suggestedPrice - it.currentPrice), stockVal: (inv.onHand || 0) * cost,
      };
    });
    const total = items.length;
    const REC_BADGE = { increase: 'green', decrease: 'red', hold: 'grey' };
    const C = {
      item: { key: 'itemCode', label: 'Item', sub: 'itemName' }, sc: { key: 'scenario', label: 'Rule' },
      cur: { key: 'currentPrice', label: 'Current', fmt: 'price' }, sug: { key: 'suggestedPrice', label: 'Suggested', fmt: 'price' },
      chg: { key: 'changePct', label: 'Change', fmt: 'pct' }, mNow: { key: 'marginNow', label: 'Margin now', fmt: 'pct' },
      mAft: { key: 'marginAfter', label: 'Margin after', fmt: 'pct' }, qty: { key: 'qty12', label: 'Units 12 mo', fmt: 'int' },
      imp: { key: 'revImpact', label: 'Revenue effect / yr', fmt: 'amt' }, stock: { key: 'onHand', label: 'On hand', fmt: 'num' },
      sval: { key: 'stockVal', label: 'Stock at cost', fmt: 'amt' }, rec: { key: 'recommendation', label: 'Action', fmt: 'badge', badge: REC_BADGE },
      rev: { key: 'rev12', label: 'Revenue 12 mo', fmt: 'amt' }, dem: { key: 'demand', label: 'Demand' },
    };
    const byScenario = list => [...list.reduce((m, r) => m.set(r.scenario, (m.get(r.scenario) || 0) + 1), new Map())].sort((a, z) => z[1] - a[1]);
    const scChart = (title, list, color) => (list.length ? { title, type: 'bar', horizontal: true, fmt: 'int', labels: byScenario(list).map(x => x[0]),
      series: [{ name: 'Items', color, values: byScenario(list).map(x => x[1]) }] } : null);
    const IMPACT = 'Revenue effect / yr = units sold in the last 12 months × (suggested − current price), assuming the same volume.';

    if (kpiId === 'dp-kpi-increase' || kpiId === 'dp-kpi-decrease') {
      const up = kpiId === 'dp-kpi-increase';
      const rows = items.filter(i => i.recommendation === (up ? 'increase' : 'decrease'));
      const imp = sum(rows, r => r.revImpact), sc = byScenario(rows);
      const avgChg = rows.length ? sum(rows, r => r.changePct) / rows.length : 0;
      if (up) {
        const below = rows.filter(r => r.marginNow != null && r.marginNow < mt);
        const top = [...rows].sort((a, z) => z.revImpact - a.revImpact || z.changePct - a.changePct);
        return {
          tone: rows.length ? 'good' : '',
          stats: [{ label: 'Items to increase', value: rows.length, fmt: 'int' }, { label: '% of items', value: pct(rows.length, total), fmt: 'pct' },
            { label: 'Avg increase', value: avgChg, fmt: 'pct' }, { label: 'Their revenue (12 mo)', value: sum(rows, r => r.rev12), fmt: 'amt' },
            { label: 'Est. extra revenue / yr', value: imp, fmt: 'amt' }, { label: `Margin below ${mt}% target`, value: below.length, fmt: 'int' }],
          chart: scChart('Price increases by pricing rule', rows, '#16A34A'),
          table: { title: 'Price increases — largest revenue effect first', columns: [C.item, C.sc, C.cur, C.sug, C.chg, C.mNow, C.mAft, C.qty, C.imp], rows: top },
          insight: rows.length ? `**${n(rows.length, 'item')} (${pct(rows.length, total)}% of the range) should go up by ${avgChg.toFixed(1)}% on average — about ${fa(imp)} more revenue a year at today's volumes.**\n\n` +
            `- Main reasons: ${sc.slice(0, 3).map(([s, c]) => `${s} (${c})`).join(', ')}.\n` +
            (top[0] ? `- Biggest effect: **${top[0].itemCode}** ${top[0].itemName} — ${top[0].changePct}% → about ${fa(top[0].revImpact)} a year.\n` : '') +
            `- ${n(below.length, 'item')} sit below the ${mt}% margin target today.\n- ${IMPACT}` : '**No item needs a price increase at this margin target.**',
        };
      }
      const dead = rows.filter(r => r.scenario === 'Dead Stock');
      const top = [...rows].sort((a, z) => z.stockVal - a.stockVal);
      return {
        tone: rows.length ? 'warn' : '',
        stats: [{ label: 'Items to cut', value: rows.length, fmt: 'int' }, { label: '% of items', value: pct(rows.length, total), fmt: 'pct' },
          { label: 'Avg cut', value: avgChg, fmt: 'pct' }, { label: 'Stock on hand at cost', value: sum(rows, r => r.stockVal), fmt: 'amt' },
          { label: 'Revenue effect / yr', value: imp, fmt: 'amt' }, { label: 'Dead stock (no sales)', value: dead.length, fmt: 'int' }],
        chart: scChart('Price decreases by pricing rule', rows, '#DC2626'),
        table: { title: 'Price decreases — most stock value first', columns: [C.item, C.sc, C.cur, C.sug, C.chg, C.stock, C.sval, C.qty, C.imp], rows: top },
        insight: rows.length ? `**${n(rows.length, 'item')} should be cut by ${Math.abs(avgChg).toFixed(1)}% on average to move ${fa(sum(rows, r => r.stockVal))} of stock (at cost).**\n\n` +
          `- Dead stock: ${dead.length} items with no sales in 12 months (−15%) — no revenue is given up, the aim is to release cash.\n` +
          `- Overstock clearance: ${rows.length - dead.length} items above max stock (−7%); revenue effect ${fa(imp)} a year at today's volumes.\n` +
          (top[0] ? `- Largest stock value: **${top[0].itemCode}** ${top[0].itemName} — ${fa(top[0].onHand)} units, ${fa(top[0].stockVal)} at cost.\n` : '') +
          '- Consider promotions or bundles before a list-price cut.' : '**No item needs a price cut.**',
      };
    }
    if (kpiId === 'dp-kpi-hold') {
      const rows = items.filter(i => i.recommendation === 'hold');
      const manual = rows.filter(r => r.scenario === 'Price Establishment');
      const withM = rows.filter(r => r.marginNow != null);
      const bands = [['Below target', r => r.marginSignal === 'below_target'], ['On target', r => r.marginSignal === 'on_target'], ['Above target', r => r.marginSignal === 'above_target'], ['No cost in SAP', r => !r.cost]];
      return {
        tone: 'info',
        stats: [{ label: 'Hold', value: rows.length, fmt: 'int' }, { label: '% of items', value: pct(rows.length, total), fmt: 'pct' },
          { label: 'Balanced', value: rows.length - manual.length, fmt: 'int' }, { label: 'Price to set manually', value: manual.length, fmt: 'int' },
          { label: 'Avg margin (with cost)', value: withM.length ? sum(withM, r => r.marginNow) / withM.length : null, fmt: 'pct' }, { label: 'Margin target', value: mt, fmt: 'pct' }],
        chart: rows.length ? { title: 'Held items by margin vs target', type: 'bar', fmt: 'int', labels: bands.map(b => b[0]), series: [{ name: 'Items', color: '#64748B', values: bands.map(([, t]) => rows.filter(t).length) }] } : null,
        table: { title: 'Held items — highest revenue first', columns: [C.item, C.sc, C.cur, C.mNow, C.dem, C.stock, C.rev], rows: [...rows].sort((a, z) => z.rev12 - a.rev12) },
        insight: `**${n(rows.length, 'item')} keep their price.**\n\n- ${rows.length - manual.length} are balanced: no rule fired on demand, stock or margin.\n` +
          (manual.length ? `- ${n(manual.length, 'item')} have no price, no sales and no cost in SAP — enter a cost or a price list price so the agent can suggest one.\n` : '') +
          `- ${rows.filter(r => r.marginSignal === 'above_target').length} held items earn more than ${mt + 8}% margin — room for a promotion if volume matters more.`,
      };
    }
    if (kpiId === 'dp-kpi-avg') {
      const rev = sum(items, r => r.rev12);
      const weighted = rev ? sum(items, r => r.rev12 * r.changePct) / rev : 0;
      const B = [['≤ −10%', x => x <= -10], ['−10 to −5%', x => x > -10 && x <= -5], ['−5 to 0%', x => x > -5 && x < 0], ['0%', x => x === 0],
        ['0 to 5%', x => x > 0 && x <= 5], ['5 to 10%', x => x > 5 && x <= 10], ['10 to 15%', x => x > 10 && x <= 15], ['> 15%', x => x > 15]];
      const imp = sum(items, r => r.revImpact);
      return {
        tone: weighted > 0 ? 'good' : weighted < 0 ? 'warn' : '',
        stats: [{ label: 'Simple average', value: d.summary?.avgChange, fmt: 'pct' }, { label: 'Revenue-weighted average', value: weighted, fmt: 'pct' },
          { label: 'Up', value: items.filter(i => i.changePct > 0).length, fmt: 'int' }, { label: 'Down', value: items.filter(i => i.changePct < 0).length, fmt: 'int' },
          { label: 'Unchanged', value: items.filter(i => !i.changePct).length, fmt: 'int' }, { label: 'Total revenue effect / yr', value: imp, fmt: 'amt' }],
        chart: total ? { title: 'Items by suggested change %', type: 'bar', fmt: 'int', labels: B.map(b => b[0]), series: [{ name: 'Items', values: B.map(([, t]) => items.filter(i => t(i.changePct)).length) }] } : null,
        table: { title: 'Largest suggested changes', columns: [C.item, C.rec, C.sc, C.cur, C.sug, C.chg, C.imp], rows: [...items].sort((a, z) => Math.abs(z.changePct) - Math.abs(a.changePct)).slice(0, 30) },
        insight: `**Average suggested change ${d.summary?.avgChange ?? 0}% per item, ${weighted.toFixed(1)}% when weighted by 12-month revenue.**\n\n` +
          '- The simple average counts every item equally (holds as 0%); the weighted figure shows the effect on the revenue you actually earn.\n' +
          `- Applying every suggestion would change revenue by about ${fa(imp)} a year at today's volumes.\n- ${IMPACT}`,
      };
    }
    if (kpiId === 'dp-kpi-total') {
      const SIG = ['high', 'medium', 'low', 'none'];
      const groups = [...items.reduce((m, r) => {
        const k = r.itemGroup || '—', g = m.get(k) || { group: k, items: 0, inc: 0, dec: 0, hold: 0, rev: 0, chg: 0 };
        g.items++; g[{ increase: 'inc', decrease: 'dec' }[r.recommendation] || 'hold']++; g.rev += r.rev12; g.chg += r.changePct; return m.set(k, g);
      }, new Map()).values()].map(g => ({ ...g, avgChg: g.items ? g.chg / g.items : 0 })).sort((a, z) => z.rev - a.rev);
      const listP = items.filter(i => i.listPrice > 0).length;
      return {
        tone: 'info',
        stats: [{ label: 'Items analysed', value: total, fmt: 'int' }, { label: 'Priced from price list', value: listP, fmt: 'int' },
          { label: 'Priced from avg selling price / cost', value: total - listP, fmt: 'int' }, { label: 'No sales in 12 months', value: items.filter(i => !i.qty12).length, fmt: 'int' },
          { label: 'Revenue (12 mo)', value: sum(items, r => r.rev12), fmt: 'amt' }, { label: 'Item groups', value: groups.length, fmt: 'int' }],
        chart: total ? { title: 'Recommendation by demand (units sold in 12 months)', type: 'bar', stacked: true, fmt: 'int', labels: ['High (>200)', 'Medium (>30)', 'Low (>0)', 'No sales'],
          series: [['increase', 'Increase', '#16A34A'], ['decrease', 'Decrease', '#DC2626'], ['hold', 'Hold', '#94A3B8']].map(([k, name, color]) => ({ name, color, values: SIG.map(s => items.filter(i => i.recommendation === k && i.demand === s).length) })) } : null,
        table: { title: 'By item group — highest revenue first', columns: [{ key: 'group', label: 'Item group' }, { key: 'items', label: 'Items', fmt: 'int' }, { key: 'inc', label: 'Increase', fmt: 'int' },
          { key: 'dec', label: 'Decrease', fmt: 'int' }, { key: 'hold', label: 'Hold', fmt: 'int' }, { key: 'avgChg', label: 'Avg change', fmt: 'pct' }, { key: 'rev', label: 'Revenue 12 mo', fmt: 'amt' }], rows: groups },
        insight: `**${n(total, 'item')} analysed on price list ${d.priceListNum ?? ''} against a ${mt}% margin target (sales ${d.periodFrom || ''} – ${d.periodTo || ''}).**\n\n` +
          `- ${listP} have a price on the selected price list; ${total - listP} are priced from their average selling price or cost.\n` +
          `- Increase ${d.summary?.increase ?? 0} · Decrease ${d.summary?.decrease ?? 0} · Hold ${d.summary?.hold ?? 0}.\n` +
          (groups[0] ? `- Largest group by revenue: **${groups[0].group}** — ${groups[0].items} items, ${fa(groups[0].rev)}.` : ''),
      };
    }
    return null;
  }

  // Sales Analysis: one detail per tile, for the measure the tile shows in the current view.
  function salesDetail(kpiId) {
    const st = saState(), d = st && st.data;
    const i = Number((kpiId.match(/sa-kpi(\d)/) || [])[1]) - 1;
    const m = d && st.kpis[i], M = m && SA_M[m];
    if (!M) return null;
    const t = d.totals || {}, L = k => saLabel(st, k), F = k => SA_FMT[SA_M[k]?.kind] || 'num';
    const show = (v, k) => saShow(v, SA_M[k]?.kind);
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const cust = d.byCustomer || [];
    const per = (d.byPeriod || []).filter(p => p._key && p._key !== 'Unknown');
    const m0 = st.kpis[0];
    const base = m === 'customers' || m === 'rowCount' ? m0 : m;   // measure behind the chart and table
    const R = SA_PARTS[m];
    const custCol = { key: '_label', label: 'Customer', sub: '_key' };
    const col = k => ({ key: k, label: L(k), fmt: F(k) });
    const isBal = st.view === 'custbalance';

    const stats = st.kpis.map(k => ({ label: L(k), value: t[k], fmt: F(k) }));
    if (!st.kpis.includes('rowCount')) stats.push({ label: 'Rows', value: d.rowCount, fmt: 'int' });
    stats.push({ label: isBal ? 'Balances as of' : 'Period', value: isBal ? 'today' : `${d.params?.fromDate || ''} → ${d.params?.toDate || ''}` });
    if (d.docSet?.label && stats.length < 6) stats.push({ label: 'Documents', value: d.docSet.label });

    let chart = null, table, insight;
    const trend = (k, title) => (per.length > 1 ? { title, type: R || k === 'AverageDeliveryVarianceDays' ? 'line' : 'bar', fmt: F(k) === 'price' ? 'num' : F(k),
      labels: per.map(p => p._key), series: [{ name: L(k), type: R || k === 'AverageDeliveryVarianceDays' ? 'line' : 'bar', values: per.map(p => Math.round(saNum(p[k]) * 100) / 100) }] } : null);
    const topSorted = k => [...cust].sort((a, z) => saNum(z[k]) - saNum(a[k]));
    const topChart = (k, title) => (cust.length ? { title, type: 'bar', horizontal: true, fmt: F(k) === 'price' ? 'num' : F(k),
      labels: topSorted(k).slice(0, 10).map(c => c._label || c._key), series: [{ name: L(k), values: topSorted(k).slice(0, 10).map(c => Math.round(saNum(c[k]) * 100) / 100) }] } : null);
    const lim = `among the top ${cust.length} customers by ${L(m0)}`;

    if (isBal && ['CustomerCreditLimit', 'AccountReceivableBalance', 'OpenSalesOrderBalance', 'OpenDeliveryBalance', 'CustomerBalanceTotal'].includes(base)) {
      const rows = cust.map(c => {
        const exposure = saNum(c.AccountReceivableBalance) + saNum(c.OpenDeliveryBalance) + saNum(c.OpenSalesOrderBalance), limit = saNum(c.CustomerCreditLimit);
        return { ...c, exposure, util: limit ? (exposure / limit) * 100 : null, over: !limit ? 'NOT SET' : exposure > limit ? 'OVER' : 'OK', headroom: limit ? limit - exposure : null };
      });
      const over = rows.filter(r => r.over === 'OVER');
      if (base === 'CustomerCreditLimit') stats.splice(4, 9, { label: 'Over their limit', value: over.length, fmt: 'int' }, { label: 'Exposure over limit', value: over.reduce((s, r) => s - r.headroom, 0), fmt: 'amt' });
      const sorted = base === 'CustomerCreditLimit' ? [...rows].sort((a, z) => (z.util ?? -1) - (a.util ?? -1)) : [...rows].sort((a, z) => saNum(z[base]) - saNum(a[base]));
      chart = topChart(base, `${L(base)} — top 10 customers`);
      table = { title: `${base === 'CustomerCreditLimit' ? 'Credit utilisation — highest first' : `${L(base)} — highest first`} (${lim})`,
        columns: [custCol, col('AccountReceivableBalance'), col('OpenDeliveryBalance'), col('OpenSalesOrderBalance'), { key: 'exposure', label: 'Exposure', fmt: 'amt' },
          col('CustomerCreditLimit'), { key: 'util', label: 'Utilisation', fmt: 'pct' }, { key: 'over', label: 'Limit', fmt: 'badge', badge: { OVER: 'red', OK: 'green', 'NOT SET': 'amber' } }],
        rows: sorted.slice(0, 30) };
      insight = `**${L(m)}: ${show(t[m], m)} across ${(t.customers || 0).toLocaleString()} customers.**\n\n` +
        `- Exposure = A/R balance + open deliveries + open orders; utilisation = exposure ÷ credit limit.\n` +
        `- ${over.length} of the listed customers are over their limit${over[0] ? ` — e.g. **${[...over].sort((a, z) => z.util - a.util)[0]._label}** at ${Math.round([...over].sort((a, z) => z.util - a.util)[0].util)}%` : ''}.\n` +
        `- ${rows.filter(r => r.over === 'NOT SET').length} listed customers have no credit limit set.\n- Hold new orders for over-limit customers until they pay (see **Collections**).`;
    } else if (R || m === 'AverageDeliveryVarianceDays') {
      const parts = R ? R.parts : ['NumberOfSalesOrder'];
      const valid = cust.filter(c => saNum(c[parts[R ? 1 : 0]]) !== 0 || (m === 'GrossProfitPercentage' && saNum(c.NetSalesAmountLC)));
      const worstFirst = ['BackOrderPercentage', 'AverageDeliveryVarianceDays', 'AverageItemCostLC'].includes(m) ? (a, z) => saNum(z[m]) - saNum(a[m])
        : m === 'AverageNetUnitPriceLC' ? (a, z) => saNum(z.NetSalesAmountLC) - saNum(a.NetSalesAmountLC) : (a, z) => saNum(a[m]) - saNum(z[m]);
      const sorted = [...valid].sort(worstFirst);
      chart = trend(m, `${L(m)} by month`) || topChart(m, `${L(m)} — top customers`);
      table = { title: `${L(m)} per customer — ${m === 'AverageNetUnitPriceLC' ? 'largest sales first' : 'weakest first'} (${lim})`, columns: [custCol, ...parts.map(col), col(m), { key: '_count', label: 'Rows', fmt: 'int' }], rows: sorted.slice(0, 30) };
      const hi = [...per].sort((a, z) => saNum(z[m]) - saNum(a[m]))[0], lo = [...per].sort((a, z) => saNum(a[m]) - saNum(z[m]))[0];
      insight = `**${L(m)} is ${show(t[m], m)} for the whole selection${R ? ` (${R.txt})` : ''}.**\n\n` +
        (sorted[0] ? `- ${m === 'AverageNetUnitPriceLC' ? 'Largest customer' : 'Weakest customer'}: **${sorted[0]._label || sorted[0]._key}** at ${show(sorted[0][m], m)}.\n` : '') +
        (per.length > 1 ? `- Highest month ${hi._key} (${show(hi[m], m)}), lowest ${lo._key} (${show(lo[m], m)}); latest ${per[per.length - 1]._key}: ${show(per[per.length - 1][m], m)}.\n` : '') +
        `- ${SA_RATIO}`;
    } else {
      const k = base;
      const sorted = topSorted(k).map(c => ({ ...c, _share: pct(saNum(c[k]), saNum(t[k])) }));
      const top5 = sorted.slice(0, 5).reduce((s, c) => s + saNum(c[k]), 0);
      if (m === 'customers') stats.splice(4, 9, { label: `Avg ${L(m0)} per customer`, value: t.customers ? saNum(t[m0]) / t.customers : 0, fmt: F(m0) }, { label: 'Top 5 customers\' share', value: pct(top5, saNum(t[m0])), fmt: 'pct' });
      chart = m === 'rowCount' ? (per.length > 1 ? { title: 'Rows per month', type: 'bar', fmt: 'int', labels: per.map(p => p._key), series: [{ name: 'Rows', values: per.map(p => p._count) }] } : null)
        : m === 'customers' ? topChart(k, `Top 10 customers by ${L(k)}`) : trend(k, `${L(k)} by month`) || topChart(k, `Top 10 customers by ${L(k)}`);
      table = { title: `Top customers by ${L(k)}`, columns: [custCol, col(k), { key: '_share', label: 'Share', fmt: 'pct' }, { key: '_count', label: 'Rows', fmt: 'int' }], rows: sorted.slice(0, 30) };
      const best = [...per].sort((a, z) => saNum(z[k]) - saNum(a[k]))[0], last = per[per.length - 1], prev = per[per.length - 2];
      const sp = (d.bySalesPerson || []).filter(s => s._key && s._key !== 'Unknown').sort((a, z) => saNum(z[k]) - saNum(a[k]))[0];
      insight = `**${L(m)}: ${show(t[m], m)}${m === 'customers' || m === 'rowCount' ? '' : ` from ${(d.rowCount || 0).toLocaleString()} rows and ${(t.customers || 0).toLocaleString()} customers`}.**\n\n` +
        (sorted[0] ? `- Top customer: **${sorted[0]._label || sorted[0]._key}** — ${show(sorted[0][k], k)} (${sorted[0]._share}% of the total).\n` : '') +
        (sorted.length ? `- Top 5 customers make up ${pct(top5, saNum(t[k]))}% of ${L(k)}.\n` : '') +
        (best && per.length > 1 ? `- Best month ${best._key}: ${show(best[k], k)}.${last && prev ? ` Latest ${last._key}: ${show(last[k], k)} (${saNum(prev[k]) ? `${(((saNum(last[k]) - saNum(prev[k])) / Math.abs(saNum(prev[k]))) * 100).toFixed(1)}% vs ${prev._key}` : 'no prior month'}).` : ''}\n` : '') +
        (sp ? `- Leading sales person: **${sp._label || sp._key}** — ${show(sp[k], k)}.\n` : '') +
        (d.docSet?.label ? `- Based on: ${d.docSet.label}.` : '');
    }
    return { stats: stats.slice(0, 6), chart, table, insight };
  }

  // Sales Order Confirmation: pending orders, their value and customers from the last /orders load.
  function socDetail(kpiId, d) {
    if (kpiId === 'soc-kpi-sel') return null;   // the selection lives on screen only
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
    const today = new Date().toISOString().slice(0, 10);
    const days = s => (s ? Math.round((Date.parse(s) - Date.parse(today)) / 86400000) : null);
    const orders = (d.orders || []).map(o => ({ ...o, toDue: days(o.dueDate), age: o.docDate ? -days(o.docDate) : null, statusTxt: o.confirmed ? 'Confirmed' : 'Pending' }));
    const pend = orders.filter(o => !o.confirmed);
    const value = pend.reduce((s, o) => s + o.totalLC, 0);
    const byCust = list => [...list.reduce((m, o) => {
      const c = m.get(o.cardCode) || { cardCode: o.cardCode, cardName: o.cardName, orders: 0, pending: 0, confirmed: 0, value: 0, pendValue: 0 };
      c.orders++; c[o.confirmed ? 'confirmed' : 'pending']++; c.value += o.totalLC; if (!o.confirmed) c.pendValue += o.totalLC; return m.set(o.cardCode, c);
    }, new Map()).values()];
    const C = { so: { key: 'docNum', label: 'SO #' }, cust: { key: 'cardName', label: 'Customer', sub: 'cardCode' }, post: { key: 'docDate', label: 'Posted', fmt: 'date' },
      due: { key: 'dueDate', label: 'Delivery', fmt: 'date' }, toDue: { key: 'toDue', label: 'Days to delivery', fmt: 'int' }, val: { key: 'totalLC', label: 'Total (LC)', fmt: 'amt' },
      sp: { key: 'salesPerson', label: 'Sales employee' }, st: { key: 'statusTxt', label: 'Status', fmt: 'badge', badge: { Pending: 'amber', Confirmed: 'green' } } };
    const note = d.status === 'confirmed' ? '\n- The list is filtered to **Confirmed** orders, so nothing is pending in it.' : d.truncated ? '\n- Only the first 1,000 orders were loaded — narrow the filters for exact figures.' : '';
    const late = pend.filter(o => o.toDue != null && o.toDue < 0), soon = pend.filter(o => o.toDue != null && o.toDue >= 0 && o.toDue <= 7);

    if (kpiId === 'soc-kpi-pending') {
      const B = [['Delivery date passed', x => x != null && x < 0], ['0–7 days', x => x != null && x >= 0 && x <= 7], ['8–30 days', x => x > 7 && x <= 30], ['31+ days', x => x > 30], ['No date', x => x == null]];
      const oldest = [...pend].sort((a, z) => (z.age ?? 0) - (a.age ?? 0))[0];
      return {
        tone: late.length ? 'bad' : pend.length ? 'warn' : 'good',
        stats: [{ label: 'Pending orders', value: pend.length, fmt: 'int' }, { label: 'Pending value (LC)', value: value, fmt: 'amt' },
          { label: 'Delivery date passed', value: late.length, fmt: 'int' }, { label: 'Delivery within 7 days', value: soon.length, fmt: 'int' },
          { label: 'Oldest (days since posting)', value: oldest ? oldest.age : 0, fmt: 'int' }, { label: 'Customers waiting', value: byCust(pend).length, fmt: 'int' }],
        chart: pend.length ? { title: 'Pending orders by delivery date', type: 'bar', fmt: 'int', labels: B.map(b => b[0]), series: [{ name: 'Orders', color: '#E9730C', values: B.map(([, t]) => pend.filter(o => t(o.toDue)).length) }] } : null,
        table: { title: 'Pending orders — earliest delivery date first', columns: [C.so, C.cust, C.post, C.due, C.toDue, C.val, C.sp], rows: [...pend].sort((a, z) => (a.toDue ?? 9999) - (z.toDue ?? 9999)) },
        insight: pend.length ? `**${pend.length} orders worth ${fa(value)} wait for confirmation; ${late.length} are already past their delivery date.**\n\n` +
          `- ${soon.length} more are due for delivery within 7 days — confirm these first so the warehouse can pick them.\n` +
          (oldest ? `- Oldest: **SO ${oldest.docNum}** for ${oldest.cardName}, posted ${oldest.age} days ago.\n` : '') + `- Check each customer's credit in the order detail before confirming.${note}`
          : `**No order is waiting for confirmation.**${note}`,
      };
    }
    if (kpiId === 'soc-kpi-value') {
      const cs = byCust(pend).sort((a, z) => z.pendValue - a.pendValue).map(c => ({ ...c, share: pct(c.pendValue, value) }));
      const big = [...pend].sort((a, z) => z.totalLC - a.totalLC)[0];
      return {
        tone: pend.length ? 'warn' : 'good',
        stats: [{ label: 'Pending value (LC)', value: value, fmt: 'amt' }, { label: 'Pending orders', value: pend.length, fmt: 'int' },
          { label: 'Average order', value: pend.length ? value / pend.length : 0, fmt: 'amt' }, { label: 'Largest order', value: big ? big.totalLC : 0, fmt: 'amt' },
          { label: 'Top customer share', value: cs[0]?.share || 0, fmt: 'pct' }, { label: 'Foreign-currency orders', value: pend.filter(o => o.total !== o.totalLC).length, fmt: 'int' }],
        chart: cs.length ? { title: 'Pending value by customer (top 10)', type: 'bar', horizontal: true, labels: cs.slice(0, 10).map(c => c.cardName || c.cardCode), series: [{ name: 'Value (LC)', color: '#107E3E', values: cs.slice(0, 10).map(c => Math.round(c.pendValue)) }] } : null,
        table: { title: 'Pending value per customer', columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'pending', label: 'Pending orders', fmt: 'int' }, { key: 'pendValue', label: 'Value (LC)', fmt: 'amt' }, { key: 'share', label: 'Share', fmt: 'pct' }], rows: cs },
        insight: pend.length ? `**${fa(value)} of sales is waiting for confirmation (Σ document totals in local currency, incl. tax).**\n\n` +
          (cs[0] ? `- Largest customer: **${cs[0].cardName}** — ${cs[0].pending} orders, ${fa(cs[0].pendValue)} (${cs[0].share}%).\n` : '') +
          (big ? `- Largest single order: **SO ${big.docNum}** — ${fa(big.totalLC)}.\n` : '') + `- Confirming the top 5 customers clears ${pct(cs.slice(0, 5).reduce((s, c) => s + c.pendValue, 0), value)}% of the value.${note}`
          : `**Nothing is pending.**${note}`,
      };
    }
    if (kpiId === 'soc-kpi-cust') {
      const cs = byCust(orders).sort((a, z) => z.orders - a.orders || z.value - a.value);
      return {
        tone: 'info',
        stats: [{ label: 'Customers', value: cs.length, fmt: 'int' }, { label: 'Orders listed', value: orders.length, fmt: 'int' },
          { label: 'With pending orders', value: cs.filter(c => c.pending).length, fmt: 'int' }, { label: 'Fully confirmed', value: cs.filter(c => !c.pending).length, fmt: 'int' },
          { label: 'Orders per customer', value: cs.length ? orders.length / cs.length : 0, fmt: 'num' }, { label: 'Value listed (LC)', value: orders.reduce((s, o) => s + o.totalLC, 0), fmt: 'amt' }],
        chart: cs.length ? { title: 'Orders per customer (top 10)', type: 'bar', horizontal: true, stacked: true, fmt: 'int', labels: cs.slice(0, 10).map(c => c.cardName || c.cardCode),
          series: [{ name: 'Pending', color: '#E9730C', values: cs.slice(0, 10).map(c => c.pending) }, { name: 'Confirmed', color: '#107E3E', values: cs.slice(0, 10).map(c => c.confirmed) }] } : null,
        table: { title: 'Customers in the list', columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'orders', label: 'Orders', fmt: 'int' }, { key: 'pending', label: 'Pending', fmt: 'int' },
          { key: 'confirmed', label: 'Confirmed', fmt: 'int' }, { key: 'value', label: 'Value (LC)', fmt: 'amt' }], rows: cs },
        insight: cs.length ? `**${cs.length} customers have ${orders.length} open orders in this list; ${cs.filter(c => c.pending).length} of them still have orders to confirm.**\n\n` +
          `- Most orders: **${cs[0].cardName}** — ${cs[0].orders} (${cs[0].pending} pending).${note}` : `**No orders in the list.**${note}`,
      };
    }
    return null;
  }

  // Forecast Dashboard: one detail per KPI from window.fdDashData() (index.html).
  function forecastDashDetail(kpiId, d) {
    const fa = v => Number(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const sum = (l, k) => l.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const top = (l, k, n) => [...l].sort((a, z) => (Number(z[k]) || 0) - (Number(a[k]) || 0)).slice(0, n);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    const daysLate = s => (s && new Date(s) < t0 ? Math.round((t0 - new Date(s)) / 86400000) : 0);
    const uom = d.item.uom || '';
    const pos = (d.pos || []).map(p => ({ ...p, vendor: p.vendorName || p.vendorCode, late: daysLate(p.deliveryDate) }));
    const sos = (d.sos || []).map(s => ({ ...s, customer: s.customerName || s.customerCode }));
    const byMonth = (list, k) => MONTHS.map((_, i) => list.filter(x => x.month === i).reduce((t, x) => t + (Number(x[k]) || 0), 0));
    const group = (list, key, val) => [...list.reduce((m, x) => m.set(x[key], (m.get(x[key]) || 0) + (Number(x[val]) || 0)), new Map())].sort((a, z) => z[1] - a[1]);
    const C = {
      po: { key: 'docNum', label: 'PO #' }, so: { key: 'docNum', label: 'SO #' },
      vendor: { key: 'vendor', label: 'Vendor', sub: 'vendorCode' }, customer: { key: 'customer', label: 'Customer', sub: 'customerCode' },
      date: { key: 'docDate', label: 'Order date', fmt: 'date' }, due: { key: 'deliveryDate', label: 'Delivery', fmt: 'date' },
      lead: { key: 'leadDays', label: 'Lead days', fmt: 'int' }, qty: { key: 'quantity', label: 'Qty', fmt: 'int' }, open: { key: 'openQty', label: 'Open qty', fmt: 'int' },
      amt: { key: 'docTotal', label: 'Amount', fmt: 'amt' }, late: { key: 'late', label: 'Days late', fmt: 'int' },
      adv: { key: 'advanceStatus', label: 'Advance', fmt: 'badge', badge: { paid: 'green', required: 'amber', none: 'grey' } },
    };
    const item = `${d.item.code}${d.item.name ? ` (${d.item.name})` : ''}`;   // plain: used inside bold headlines

    if (kpiId === 'fd-kpi-so-count') {
      const cs = group(sos, 'customer', 'docTotal');
      return {
        tone: sos.length ? 'info' : '',
        stats: [{ label: 'Open sales orders', value: sos.length, fmt: 'int' }, { label: 'Amount (item lines)', value: sum(sos, 'docTotal'), fmt: 'amt' },
          { label: `Ordered qty ${uom}`, value: sum(sos, 'quantity'), fmt: 'int' }, { label: `Open qty ${uom}`, value: sum(sos, 'openQty'), fmt: 'int' },
          { label: 'Available stock', value: d.item.available, fmt: 'int' }, { label: 'Customers', value: cs.length, fmt: 'int' }],
        chart: sos.length ? { title: `Open SO amount by order month (${d.year})`, type: 'bar', labels: MONTHS, series: [{ name: 'SO amount', color: '#0070F2', values: byMonth(sos, 'docTotal') }] } : null,
        table: { title: 'Open sales orders — largest amount first', columns: [C.so, C.customer, C.date, C.due, C.qty, C.open, C.amt], rows: top(sos, 'docTotal', 50) },
        insight: sos.length ? `**${sos.length} open sales orders for ${item} still need ${fa(sum(sos, 'openQty'))} ${uom}; available stock is ${fa(d.item.available)}.**\n\n` +
          (cs[0] ? `- Largest customer: **${cs[0][0]}** — ${fa(cs[0][1])}.\n` : '') +
          (sum(sos, 'openQty') > d.item.available ? `- Open demand exceeds available stock by **${fa(sum(sos, 'openQty') - d.item.available)} ${uom}** — cover it with open POs or a new order.` : '- Available stock covers the open orders.')
          : `**No open sales orders for ${item}.**`,
      };
    }
    if (kpiId === 'fd-kpi-po-count') {
      const vs = group(pos, 'vendor', 'docTotal');
      return {
        tone: 'info',
        stats: [{ label: 'Open purchase orders', value: pos.length, fmt: 'int' }, { label: 'Amount (item lines)', value: sum(pos, 'docTotal'), fmt: 'amt' },
          { label: `Ordered qty ${uom}`, value: sum(pos, 'quantity'), fmt: 'int' }, { label: `Still to receive ${uom}`, value: sum(pos, 'openQty'), fmt: 'int' },
          { label: 'Overdue', value: pos.filter(p => p.late > 0).length, fmt: 'int' }, { label: 'Vendors', value: vs.length, fmt: 'int' }],
        chart: vs.length > 1 ? { title: 'Open PO amount by vendor (top 10)', type: 'bar', horizontal: true, labels: vs.slice(0, 10).map(v => String(v[0]).slice(0, 30)), series: [{ name: 'Amount', color: '#107E3E', values: vs.slice(0, 10).map(v => Math.round(v[1])) }] }
          : pos.length ? { title: `Open PO amount by order month (${d.year})`, type: 'bar', labels: MONTHS, series: [{ name: 'PO amount', color: '#107E3E', values: byMonth(pos, 'docTotal') }] } : null,
        table: { title: 'Open purchase orders — earliest delivery first', columns: [C.po, C.vendor, C.date, C.due, C.open, C.amt, C.late], rows: [...pos].sort((a, z) => String(a.deliveryDate || '').localeCompare(String(z.deliveryDate || ''))) },
        insight: pos.length ? `**${pos.length} open POs will bring ${fa(sum(pos, 'openQty'))} ${uom} of ${item}, worth ${fa(sum(pos, 'docTotal'))}.**\n\n` +
          (vs[0] ? `- Main vendor: **${vs[0][0]}** — ${fa(vs[0][1])}.\n` : '') +
          `- ${pos.filter(p => p.late > 0).length} are past their delivery date.` : `**No open purchase orders for ${item}.**`,
      };
    }
    if (kpiId === 'fd-kpi-lead') {
      const w = pos.filter(p => p.leadDays != null && p.leadDays >= 0);
      if (!w.length) return null;
      const L = w.map(p => p.leadDays).sort((a, z) => a - z);
      const avg = Math.round(L.reduce((t, v) => t + v, 0) / L.length);
      const lo = d.lt && d.lt.overall;
      if (lo) {
        const vs = d.lt.vendors || [];
        return {
          tone: lo.onTimePct >= 90 ? 'good' : lo.onTimePct >= 70 ? 'warn' : 'bad',
          stats: [{ label: 'Planned lead, open POs (days)', value: avg, fmt: 'int' }, { label: 'Actual lead, past deliveries', value: lo.avgLeadDays, fmt: 'num' },
            { label: 'Avg delay vs promised', value: lo.avgDelayDays, fmt: 'num' }, { label: 'On-time %', value: lo.onTimePct, fmt: 'pct' },
            { label: 'Actual lead p90', value: lo.p90LeadDays, fmt: 'int' }, { label: 'Item master lead', value: Number(d.item.leadTime) || null, fmt: 'int' },
            { label: 'Deliveries measured', value: lo.receipts, fmt: 'int' }],
          chart: vs.length ? { title: 'Planned vs actual lead time by vendor (days)', type: 'bar', horizontal: true, fmt: 'num', labels: vs.slice(0, 10).map(v => String(v.vendorName || v.vendorCode).slice(0, 28)),
            series: [{ name: 'Planned', color: '#94A3B8', values: vs.slice(0, 10).map(v => v.avgPlannedLeadDays) }, { name: 'Actual', color: '#E9730C', values: vs.slice(0, 10).map(v => v.avgLeadDays) }] } : null,
          table: { title: `Vendor delivery performance — last ${d.lt.months} months`, columns: [{ key: 'vendorName', label: 'Vendor', sub: 'vendorCode' }, { key: 'receipts', label: 'Deliveries', fmt: 'int' },
            { key: 'avgPlannedLeadDays', label: 'Planned lead', fmt: 'num' }, { key: 'avgLeadDays', label: 'Actual lead', fmt: 'num' }, { key: 'avgDelayDays', label: 'Avg delay', fmt: 'num' }, { key: 'onTimePct', label: 'On-time', fmt: 'pct' }], rows: vs },
          insight: `**Open POs plan ${avg} days, but past deliveries of ${item} actually took ${lo.avgLeadDays} days on average — ${lo.onTimePct}% on time.**\n\n` +
            `- Average delay vs promised date: ${lo.avgDelayDays > 0 ? '+' : ''}${lo.avgDelayDays} days${lo.avgLateDaysWhenLate ? ` (${lo.avgLateDaysWhenLate} days when late)` : ''}.\n` +
            (vs[0] ? `- Main vendor **${vs[0].vendorName || vs[0].vendorCode}**: ${vs[0].avgLeadDays} days actual, ${vs[0].onTimePct}% on time.\n` : '') +
            `- Item master lead time: ${d.item.leadTime ? `${d.item.leadTime} days` : 'not set'}${Math.abs((Number(d.item.leadTime) || 0) - lo.avgLeadDays) > 7 ? ` — consider updating OITM.LeadTime to about ${Math.round(lo.avgLeadDays)}.` : '.'}`,
        };
      }
      const bands = [['0–7', v => v <= 7], ['8–14', v => v > 7 && v <= 14], ['15–30', v => v > 14 && v <= 30], ['31–60', v => v > 30 && v <= 60], ['61+', v => v > 60]];
      return {
        tone: 'info',
        stats: [{ label: 'Average lead (days)', value: avg, fmt: 'int' }, { label: 'Median', value: L[Math.floor(L.length / 2)], fmt: 'int' },
          { label: 'Shortest', value: L[0], fmt: 'int' }, { label: 'Longest', value: L[L.length - 1], fmt: 'int' },
          { label: 'Item master lead', value: Number(d.item.leadTime) || null, fmt: 'int' }, { label: 'POs measured', value: L.length, fmt: 'int' }],
        chart: { title: 'POs by lead time (days)', type: 'bar', fmt: 'int', labels: bands.map(b => b[0]), series: [{ name: 'POs', color: '#E9730C', values: bands.map(([, f]) => L.filter(f).length) }] },
        table: { title: 'Open POs — longest lead first', columns: [C.po, C.vendor, C.date, C.due, C.lead, C.open], rows: top(w, 'leadDays', 50) },
        insight: `**Vendors are given ${avg} days on average (range ${L[0]}–${L[L.length - 1]}) to deliver ${item}.**\n\n` +
          `- Item master lead time: ${d.item.leadTime ? `${d.item.leadTime} days` : 'not set'}${d.item.leadTime && Math.abs(d.item.leadTime - avg) > 7 ? ' — differs from actual POs; consider updating OITM.LeadTime.' : '.'}\n` +
          `- Longest: PO **${top(w, 'leadDays', 1)[0].docNum}** (${top(w, 'leadDays', 1)[0].vendor}) — ${top(w, 'leadDays', 1)[0].leadDays} days.`,
      };
    }
    if (kpiId === 'fd-kpi-adv-count') {
      const paid = pos.filter(p => p.advanceStatus === 'paid'), req = pos.filter(p => p.advanceStatus === 'required');
      return {
        tone: req.length ? 'warn' : 'info',
        stats: [{ label: 'POs with advance paid', value: paid.length, fmt: 'int' }, { label: 'Advance amount', value: sum(paid, 'advanceAmount'), fmt: 'amt' },
          { label: 'Advance required', value: req.length, fmt: 'int' }, { label: 'No advance', value: pos.length - paid.length - req.length, fmt: 'int' }],
        chart: pos.length ? { title: 'Open POs by advance status', type: 'bar', fmt: 'int', labels: ['Paid', 'Required', 'None'],
          series: [{ name: 'POs', color: '#8B5CF6', values: [paid.length, req.length, pos.length - paid.length - req.length] }] } : null,
        table: { title: 'Open POs with an advance', columns: [C.po, C.vendor, C.due, C.amt, { key: 'advanceAmount', label: 'Vendor advance', fmt: 'amt' }, C.adv, C.late], rows: paid.concat(req) },
        insight: paid.length || req.length ? `**${paid.length} open POs belong to vendors with open advances (${fa(sum(paid, 'advanceAmount'))}); ${req.length} more require one.**\n\n` +
          `- ${paid.filter(p => p.late > 0).length} of the advance-paid POs are already overdue — money is out but goods are not in.\n- Advances are matched by vendor, so check the down payment documents before chasing.`
          : '**No open PO for this item involves an advance payment.**',
      };
    }
    if (kpiId === 'fd-kpi-overdue') {
      const rows = pos.filter(p => p.late > 0).sort((a, z) => z.late - a.late);
      const bands = [['1–7 days', v => v <= 7], ['8–30 days', v => v > 7 && v <= 30], ['31–90 days', v => v > 30 && v <= 90], ['90+ days', v => v > 90]];
      return {
        tone: rows.length ? 'bad' : 'good',
        stats: [{ label: 'Overdue POs', value: rows.length, fmt: 'int' }, { label: `Qty not received ${uom}`, value: sum(rows, 'openQty'), fmt: 'int' },
          { label: 'Amount', value: sum(rows, 'docTotal'), fmt: 'amt' }, { label: 'Oldest (days late)', value: rows[0]?.late || 0, fmt: 'int' },
          { label: 'Vendors', value: group(rows, 'vendor', 'docTotal').length, fmt: 'int' }],
        chart: rows.length ? { title: 'Overdue POs by days late', type: 'bar', fmt: 'int', labels: bands.map(b => b[0]), series: [{ name: 'POs', color: '#BB0000', values: bands.map(([, f]) => rows.filter(p => f(p.late)).length) }] } : null,
        table: { title: 'Overdue POs — most late first', columns: [C.po, C.vendor, C.due, C.late, C.open, C.amt, C.adv], rows },
        insight: rows.length ? `**${rows.length} POs for ${item} are overdue — ${fa(sum(rows, 'openQty'))} ${uom} has not arrived.**\n\n` +
          `- Oldest: PO **${rows[0].docNum}** from **${rows[0].vendor}**, due ${rows[0].deliveryDate} (${rows[0].late} days late).\n` +
          '- Get confirmed dates from these vendors; if they cannot deliver, the Reorder Plan understates the shortage.' : `**No overdue PO for ${item}.**`,
      };
    }

    if (['fd-sd-kpi-fcdemand', 'fd-sd-kpi-openpo', 'fd-sd-kpi-planned', 'fd-sd-kpi-minbal'].includes(kpiId)) {
      const pp = d.pp;
      if (!pp) return null;
      const ym = k => { const [y, m] = k.split('-'); return `${MONTHS[Number(m) - 1]} ${y}`; };
      const rows = pp.months.map(m => ({ month: ym(m.key), booked: m.booked, fc: m.fc == null ? null : Math.round(m.fc), demand: Math.round(m.demand), poExp: m.poExp, pr: m.pr,
        planned: m.planned, balance: Math.round(m.balance), status: m.balance < 0 ? 'Stockout' : m.balance < pp.floor ? 'Below safety' : 'OK' }));
      const cols = [{ key: 'month', label: 'Month' }, { key: 'booked', label: 'Open SO', fmt: 'int' },
        { key: 'poExp', label: 'PO expected', fmt: 'int' }, { key: 'pr', label: 'Open PR', fmt: 'int' }, { key: 'planned', label: 'New orders', fmt: 'int' }, { key: 'balance', label: 'Balance', fmt: 'int' },
        { key: 'status', label: 'Status', fmt: 'badge', badge: { Stockout: 'red', 'Below safety': 'amber', OK: 'green' } }];
      const S = k => rows.reduce((t2, r) => t2 + (Number(r[k]) || 0), 0);
      const low = rows.reduce((a, r) => (r.balance < a.balance ? r : a), rows[0]);
      const stats = [{ label: 'Stock now', value: pp.startStock, fmt: 'int' }, { label: 'Booked demand', value: S('demand'), fmt: 'int' }, { label: 'Expected supply', value: S('poExp') + S('pr'), fmt: 'int' },
        { label: 'Order needed (booked)', value: S('planned'), fmt: 'int' }, { label: `Lowest stock (${low.month})`, value: low.balance, fmt: 'int' }, { label: 'Minimum stock', value: pp.floor, fmt: 'int' }];
      const chart = { title: `Plan ${rows[0].month} – ${rows[rows.length - 1].month} (qty)`, type: 'bar', fmt: 'int', labels: rows.map(r => r.month), series: [
        { name: 'Booked demand', color: '#E9730C', values: rows.map(r => r.demand) }, { name: 'Expected supply', color: '#8B5CF6', values: rows.map(r => r.poExp + r.pr) },
        { name: 'New orders', color: '#B45309', values: rows.map(r => r.planned) }, { name: 'Balance (no new orders)', type: 'line', color: '#111827', values: rows.map(r => r.balance) }] };
      const first = pp.orders[0];
      return {
        tone: low.balance < 0 ? 'bad' : low.balance < pp.floor ? 'warn' : 'good', stats, chart, table: { title: 'Plan month by month', columns: cols, rows },
        insight: `**From ${rows[0].month} to ${rows[rows.length - 1].month} (booked orders only, no forecast): booked demand ${fa(S('demand'))}, expected supply ${fa(S('poExp') + S('pr'))} on top of ${fa(pp.startStock)} in stock — lowest point ${fa(low.balance)} in ${low.month}.**\n\n` +
          (pp.orders.length ? `- ${pp.orders.length} new order(s), ${fa(S('planned'))} in total; the first must be placed by **${first.orderBy}** (need by ${first.needBy}).\n` : '- No new orders needed in this horizon.\n') +
          `- Lead time ${pp.lead} d + vendor lateness ${pp.late} d; safety floor ${fa(pp.floor)}.`,
      };
    }
    if (['fd-sd-kpi-instock', 'fd-sd-kpi-demand', 'fd-sd-kpi-supply', 'fd-sd-kpi-gap'].includes(kpiId)) {
      const it2 = d.item, rp = d.rp;
      const onHand = Number(it2.onHand) || 0, com = Number(it2.committed) || 0, ord = Number(it2.onOrder) || 0, avail = onHand - com + ord;
      const whs = (rp?.warehouses || []).filter(w => !w.dropShip && (w.onHand || w.committed || w.onOrder))
        .map(w => ({ whs: w.whs, name: w.name, onHand: w.onHand, committed: w.committed, onOrder: w.onOrder, available: w.onHand - w.committed + w.onOrder }));
      const stats = [{ label: 'In Stock', value: onHand, fmt: 'int' }, { label: 'Committed', value: com, fmt: 'int' }, { label: 'Ordered', value: ord, fmt: 'int' }, { label: 'Available', value: avail, fmt: 'int' }];
      const whsTable = { title: 'Per warehouse (OITW)', columns: [{ key: 'whs', label: 'Warehouse', sub: 'name' }, { key: 'onHand', label: 'In Stock', fmt: 'int' }, { key: 'committed', label: 'Committed', fmt: 'int' },
        { key: 'onOrder', label: 'Ordered', fmt: 'int' }, { key: 'available', label: 'Available', fmt: 'int' }], rows: whs };
      const ym = s2 => (s2 || '').slice(0, 7);
      if (kpiId === 'fd-sd-kpi-demand' && rp) {
        const lines = rp.soLines.filter(l => !l.dropShip && l.open > 0).sort((a2, z) => String(a2.dueDate).localeCompare(String(z.dueDate)));
        const tr = (rp.transferRequests || []).reduce((t2, x) => t2 + x.open, 0);
        const byM = {}; lines.forEach(l => { byM[ym(l.dueDate)] = (byM[ym(l.dueDate)] || 0) + l.open; });
        const keys = Object.keys(byM).sort();
        return { tone: com > onHand ? 'warn' : 'info', stats: [...stats, { label: 'Open sales orders', value: lines.reduce((t2, l) => t2 + l.open, 0), fmt: 'int' }, { label: 'Transfer requests', value: tr, fmt: 'int' }],
          chart: keys.length ? { title: 'Committed by delivery month (qty)', type: 'bar', fmt: 'int', labels: keys, series: [{ name: 'Open SO qty', color: '#BB0000', values: keys.map(k2 => byM[k2]) }] } : null,
          table: { title: 'Open sales-order lines (what makes up Committed)', columns: [{ key: 'dueDate', label: 'Delivery date', fmt: 'date' }, { key: 'docNum', label: 'SO #' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'whs', label: 'Warehouse' }, { key: 'open', label: 'Open qty', fmt: 'int' }], rows: lines },
          insight: `**Committed ${fa(com)} ${uom}: ${fa(lines.reduce((t2, l) => t2 + l.open, 0))} on open sales orders${tr ? ` + ${fa(tr)} on transfer requests` : ''}.**\n\n` +
            (keys.length ? `- Largest month: ${keys.reduce((a2, k2) => byM[k2] > byM[a2] ? k2 : a2, keys[0])} (${fa(Math.max(...keys.map(k2 => byM[k2])))}).\n` : '') +
            (com > onHand ? `- Committed exceeds In Stock by ${fa(com - onHand)} — those orders depend on open POs arriving in time.` : '- In Stock covers all committed orders.') };
      }
      if (kpiId === 'fd-sd-kpi-supply' && rp) {
        const lines = rp.poLines.filter(l => !l.dropShip && l.open > 0).sort((a2, z) => String(a2.dueDate).localeCompare(String(z.dueDate)));
        const prs = (rp.purchaseRequests || []).filter(r => !r.dropShip && r.open > 0);
        return { tone: 'info', stats: [...stats, { label: 'Open PO lines', value: lines.length, fmt: 'int' }, { label: 'On purchase requests (not ordered)', value: prs.reduce((t2, r) => t2 + r.open, 0), fmt: 'int' }],
          chart: null,
          table: { title: 'Open purchase-order lines (what makes up Ordered)', columns: [{ key: 'dueDate', label: 'Promised date', fmt: 'date' }, { key: 'docNum', label: 'PO #' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'whs', label: 'Warehouse' }, { key: 'open', label: 'Open qty', fmt: 'int' }], rows: lines },
          insight: `**Ordered ${fa(ord)} ${uom} on ${lines.length} open PO line(s)${prs.length ? `; another ${fa(prs.reduce((t2, r) => t2 + r.open, 0))} is on purchase requests not yet turned into POs` : ''}.**\n\n- Late lines are listed first by promised date — see Purchase Tracking for expected arrivals.` };
      }
      return { tone: avail < 0 ? 'bad' : 'good', stats, chart: null, table: whsTable,
        insight: kpiId === 'fd-sd-kpi-gap'
          ? `**Available ${fa(avail)} ${uom} = In Stock ${fa(onHand)} − Committed ${fa(com)} + Ordered ${fa(ord)} — same as the SAP item master.**\n\n- ${avail < 0 ? 'Booked orders exceed stock plus everything on order — order more now.' : 'Stock plus open POs cover all booked orders.'}\n- Available ignores dates: check the Running Balance for timing.`
          : `**In Stock ${fa(onHand)} ${uom}${whs.length ? ` in ${whs.filter(w => w.onHand).length} warehouse(s)` : ''}; free after committed orders: ${fa(onHand - com)}.**` };
    }
    if (kpiId.startsWith('fd-sd-kpi-')) {
      const sd = d.sd;
      if (!sd) return null;
      return null;
    }

    if (kpiId.startsWith('fd-fc-kpi-')) {
      const fc = d.fc;
      if (!fc) return null;
      const acc = (fc.accuracy || []).filter(a => a.mape != null);
      const rel = fc.mape < 20 ? 'good' : fc.mape < 50 ? 'fair' : 'weak';
      const n = fc.history.length, h = Math.floor(n / 2);
      const a1 = fc.history.slice(0, h).reduce((t, v) => t + v, 0) / (h || 1), a2 = fc.history.slice(h).reduce((t, v) => t + v, 0) / ((n - h) || 1);
      const fRows = fc.forecast.map((v, i) => ({ month: fc.forecastLabels[i], qty: v }));
      const accTable = { title: 'Model accuracy (back-test) — best first', columns: [{ key: 'model', label: 'Model' }, { key: 'mape', label: 'MAPE', fmt: 'pct' }, { key: 'mae', label: 'MAE', fmt: 'num' }], rows: fc.accuracy || [] };
      const histChart = (title, withFc) => ({ title, type: 'bar', fmt: 'int', labels: fc.historyLabels.concat(withFc ? fc.forecastLabels : []),
        series: [{ name: 'Actual', color: '#475569', values: fc.history.concat(withFc ? fc.forecast.map(() => null) : []) }]
          .concat(withFc ? [{ name: `Forecast (${fc.model})`, color: '#E9730C', values: fc.history.map(() => null).concat(fc.forecast.map(v => Math.round(v))) }] : []) });
      if (kpiId === 'fd-fc-kpi-model' || kpiId === 'fd-fc-kpi-mape') {
        return {
          tone: rel === 'good' ? 'good' : rel === 'fair' ? 'warn' : 'bad',
          stats: [{ label: 'Best model', value: fc.model }, { label: 'MAPE', value: fc.mape < 999 ? fc.mape : null, fmt: 'pct' }, { label: 'Reliability', value: rel },
            { label: 'Months of history', value: n, fmt: 'int' }, { label: 'Runner-up', value: acc[1] ? `${acc[1].model} (${acc[1].mape}%)` : '—' }],
          chart: acc.length ? { title: 'MAPE by model (lower is better)', type: 'bar', horizontal: true, fmt: 'pct', labels: acc.map(a => a.model), series: [{ name: 'MAPE %', color: '#E9730C', values: acc.map(a => a.mape) }] } : null,
          table: accTable,
          insight: `**${fc.model} fits ${item} best with a ${fc.mape < 999 ? fc.mape.toFixed(1) + '%' : 'n/a'} average error — ${rel} reliability.**\n\n` +
            (acc[1] ? `- Runner-up: ${acc[1].model} at ${acc[1].mape}%${Math.abs(acc[1].mape - fc.mape) < 5 ? ' — close, so the forecast is fairly robust.' : '.'}\n` : '') +
            (rel === 'weak' ? '- Demand is erratic: plan with a higher service level and review monthly.' : `- Based on ${n} months of history.`),
        };
      }
      if (kpiId === 'fd-fc-kpi-total') {
        return {
          tone: 'info',
          stats: [{ label: `Forecast total ${uom}`, value: fc.total, fmt: 'int' }, { label: 'Horizon (months)', value: fc.horizon, fmt: 'int' },
            { label: 'Next month', value: fc.next, fmt: 'int' }, { label: 'Average per month', value: fc.total / (fc.horizon || 1), fmt: 'int' },
            { label: 'Available + on order', value: (Number(d.item.available) || 0) + (Number(d.item.onOrder) || 0), fmt: 'int' }],
          chart: histChart('Actual demand and forecast (qty)', true),
          table: { title: `Forecast by month (${fc.model})`, columns: [{ key: 'month', label: 'Month' }, { key: 'qty', label: `Forecast ${uom}`, fmt: 'int' }], rows: fRows },
          insight: `**${fc.model} expects ${fa(fc.total)} ${uom} of ${item} over the next ${fc.horizon} months (${fa(fc.next)} next month).**\n\n` +
            `- Available + on order today: ${fa((Number(d.item.available) || 0) + (Number(d.item.onOrder) || 0))} — ${((Number(d.item.available) || 0) + (Number(d.item.onOrder) || 0)) < fc.total ? `**${fa(fc.total - (Number(d.item.available) || 0) - (Number(d.item.onOrder) || 0))} short** of the horizon demand.` : 'enough for the horizon.'}\n` +
            '- See the Reorder Plan for when to order.',
        };
      }
      return {
        tone: fc.growth > 5 ? 'good' : fc.growth < -5 ? 'warn' : 'info',
        stats: [{ label: 'Trend', value: fc.trend }, { label: 'Growth', value: fc.growth, fmt: 'pct' },
          { label: 'Avg first half', value: a1, fmt: 'int' }, { label: 'Avg second half', value: a2, fmt: 'int' }, { label: 'Months of history', value: n, fmt: 'int' }],
        chart: histChart('Monthly demand history (qty)', false),
        table: { title: 'Demand history', columns: [{ key: 'month', label: 'Month' }, { key: 'qty', label: `Demand ${uom}`, fmt: 'int' }], rows: fc.history.map((v, i) => ({ month: fc.historyLabels[i], qty: v })) },
        insight: `**Demand for ${item} is ${String(fc.trend).replace(/^[^A-Za-z]+/, '').toLowerCase()}: ${fa(a1)} → ${fa(a2)} per month (${fc.growth > 0 ? '+' : ''}${fc.growth}%).**\n\n` +
          (fc.growth > 5 ? '- Increase safety stock and place POs earlier.' : fc.growth < -5 ? '- Reduce order quantities to avoid excess stock.' : '- Keep the current inventory strategy and monitor.'),
      };
    }

    if (kpiId.startsWith('fd-sp-kpi-')) {
      const sp = d.sp;
      if (!sp) return null;
      const stClr = { OK: 'green', 'Below safety': 'amber', Stockout: 'red' };
      const table = { title: 'Month-by-month stock projection', columns: [{ key: 'month', label: 'Month' }, { key: 'opening', label: 'Opening', fmt: 'int' },
        { key: 'incomingPO', label: '+ Open PO (expected)', fmt: 'int' }, { key: 'grossForecast', label: 'Forecast', fmt: 'int' }, { key: 'bookedOnOpenSO', label: 'Booked SO', fmt: 'int' },
        { key: 'forecastDemand', label: '− Net demand', fmt: 'int' }, { key: 'closing', label: 'Closing', fmt: 'int' },
        { key: 'status', label: 'Status', fmt: 'badge', badge: stClr }], rows: sp.months };
      const floor = Math.max(sp.safetyStock, sp.minStockItemMaster || 0);
      const chart = { title: 'Projected closing stock vs safety floor and reorder point (qty)', type: 'bar', fmt: 'int', labels: sp.months.map(m => m.month), series: [
        { name: 'Closing stock', color: '#475569', values: sp.months.map(m => m.closing) },
        { name: 'Safety floor', type: 'line', color: '#E9730C', values: sp.months.map(() => floor) },
        { name: 'Reorder point', type: 'line', color: '#8B5CF6', values: sp.months.map(() => sp.reorderPoint) }] };
      const stats = [{ label: 'Safety stock', value: sp.safetyStock, fmt: 'int' }, { label: 'Reorder point', value: sp.reorderPoint, fmt: 'int' },
        { label: 'Inventory position', value: sp.inventoryPosition, fmt: 'int' }, { label: 'Avg monthly demand', value: sp.avgMonthlyDemand, fmt: 'int' },
        { label: 'Demand σ', value: sp.demandStdDev, fmt: 'int' }, { label: 'Lead time (days)', value: sp.leadTimeDays, fmt: 'int' },
        { label: 'Lead time source', value: sp.leadTimeSource || '—' }, { label: 'PO qty arriving later than promised', value: sp.openPoQtyDelayedByVendorHistory || 0, fmt: 'int' },
        { label: 'Lead time σ (days)', value: sp.leadTimeStdDevDays || 0, fmt: 'num' }, { label: 'Safety stock, demand only', value: sp.safetyStockDemandOnly, fmt: 'int' },
        { label: 'Service level', value: sp.serviceLevelPct, fmt: 'pct' }, { label: 'What-if demand', value: sp.whatIfDemandPct, fmt: 'pct' }];
      const bad = sp.firstStockoutMonth || sp.firstBelowSafetyMonth;
      return {
        tone: sp.firstStockoutMonth ? 'bad' : sp.firstBelowSafetyMonth || sp.belowReorderPointNow ? 'warn' : 'good',
        stats, chart, table,
        insight: bad
          ? `**${sp.firstStockoutMonth ? `Stockout projected in ${sp.firstStockoutMonth}` : `Stock drops below the safety floor in ${sp.firstBelowSafetyMonth}`} — order ${fa(sp.suggestedOrderQty)} ${uom} of ${item} by ${sp.orderByDate}.**\n\n` +
            `- Needed by ${sp.needByDate}; lead time ${sp.leadTimeDays} days${sp.preferredVendor ? `; preferred vendor ${sp.preferredVendor}` : ''}.\n` +
            (sp.orderIsLateByDays ? `- The order-by date passed ${sp.orderIsLateByDays} days ago — order now and ask for expedited delivery.\n` : '') +
            `- Safety stock ${fa(sp.safetyStock)} = z × σ ${fa(sp.demandStdDev)} × √(${sp.leadTimeDays}/30) at ${sp.serviceLevelPct}% service level.`
          : `**Stock of ${item} stays above the safety floor (${fa(floor)}) for the whole horizon.**\n\n` +
            `- Inventory position ${fa(sp.inventoryPosition)} vs reorder point ${fa(sp.reorderPoint)}${sp.belowReorderPointNow ? ' — already below, so plan the next order.' : '.'}`,
      };
    }
    return null;
  }

  function kpiPopup(panelId, kpiId) {
    if (richPopup(panelId, kpiId)) return;
    const P = PANELS[panelId], K = kpiOf(P, kpiId);
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
    const cols = tval(T.cols), notes = tval(T.notes);
    const items = Object.keys(cols).map(k => {
      const label = T.labels && T.labels[k] || k;
      return { k, line: `**${label}** — ${cols[k]}` };
    });
    // Put the clicked column first so the user sees it immediately.
    if (focusKey) items.sort((a, b) => (b.k === focusKey) - (a.k === focusKey));
    const sections = [{ title: 'Columns (left to right)', items: items.map(i => i.line) }];
    if (notes && notes.length) sections.push({ title: 'Good to know', items: notes });
    window.AgentAbout.open(`Column guide — ${tval(T.title)}`, { summary: tval(T.summary), sections }, P.color, { prefix: false });
  }

  function decorate(panel) {
    const pid = panel.id, P = PANELS[pid];
    if (!P) return;
    // KPI tiles
    Object.keys(P.kpis).forEach(id => {
      const v = document.getElementById(id);
      if (!v || !panel.contains(v)) return;
      const tile = tileFor(v);
      // Some screens rewrite the tile's className on every load — re-add ours.
      if (!tile || (tile.dataset.akhKpi === id && tile.classList.contains('akh-tile'))) return;
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
        i.setAttribute('aria-label', `What does ${kpiOf(P, id)?.label || 'this KPI'} mean?`);
        i.title = TILE_TIP;
        tile.appendChild(i);
      }
    });
    // Table headers + column-guide control
    P.tables.forEach((T, tIdx) => {
      const body = document.getElementById(T.tbody);
      const table = body && body.closest('table');
      if (!table || !panel.contains(table)) return;
      const keys = {}, cols = tval(T.cols);
      Object.keys(cols).forEach(k => { keys[norm(k)] = k; });
      table.querySelectorAll('thead th').forEach(th => {
        const k = keys[norm(th.textContent)];
        if (!k || th.dataset.akhCol) return;
        th.dataset.akhCol = k;
        th.dataset.akhTable = String(tIdx);
        th.classList.add('akh-th');
        // headerClick: false — the header already sorts the table; the Column guide link opens the guide.
        th.title = `${(T.labels && T.labels[k]) || k}: ${cols[k].replace(/\*\*/g, '')}\n(${T.headerClick === false ? 'click to sort · ⓘ Column guide for all columns' : 'click for the full column guide'})`;
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
    if (th && !t.closest('input,button,select,a,label') && PANELS[pid].tables[+th.dataset.akhTable]?.headerClick !== false) {
      columnPopup(pid, +th.dataset.akhTable, th.dataset.akhCol); return;
    }
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
    saRowExplain,   // Sales Analysis table cells (index.html saRenderTable)
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
