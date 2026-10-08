/**
 * Profitability Agent — mounted at /api/profitability-agent
 *
 * Gross profit by customer, item, item group, sales employee, warehouse,
 * branch and document for a date range, from A/R invoice lines net of A/R
 * credit memos. Revenue = line total (local currency) after header discount;
 * cost = gross-profit base price (or item cost at posting) × quantity.
 */
import { createInsightRouter, ctxTable, addDays, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import { loadSalesLines, loadItems, groupProfit } from '../lib/insight-data.mjs';

const byGp = (a, z) => z.gp - a.gp;

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oinv: 'OINV — A/R invoice headers (not cancelled): document date, customer, sales employee, header discount, branch',
  inv1: 'INV1 — A/R invoice lines: quantity, line total, gross-profit base price (GrossBuyPr), item cost (StockPrice), warehouse',
  orin: 'ORIN + RIN1 — A/R credit memos and lines (deducted from revenue and cost)',
  oitm: 'OITM + OITB — item master and item groups',
  oslp: 'OSLP — sales employees',
  obpl: 'OBPL — branches (when enabled)',
};

async function run(k, p) {
  const to = p.asOf;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(p.fromDate || '') ? p.fromDate : addDays(to, -(clamp(num(p.days) || 90, 1, 1095) - 1));
  const lines = await loadSalesLines(k, from, to, { withCreditMemos: p.includeCreditMemos !== 'no' });
  const items = await loadItems(k).catch(() => new Map());
  for (const l of lines) l.group = items.get(l.itemCode)?.group || '(no group)';

  const dims = {
    customer: groupProfit(lines, l => l.cardCode, l => ({ cardCode: l.cardCode, cardName: l.cardName })),
    item: groupProfit(lines, l => l.itemCode, l => ({ itemCode: l.itemCode, itemName: l.itemName, group: l.group })),
    group: groupProfit(lines, l => l.group, l => ({ group: l.group })),
    salesperson: groupProfit(lines, l => l.salesperson, l => ({ salesperson: l.salesperson })),
    warehouse: groupProfit(lines, l => l.whsCode, l => ({ whsCode: l.whsCode || '(none)' })),
    branch: groupProfit(lines, l => l.branch || '(single branch)', l => ({ branch: l.branch || '(single branch)' })),
    document: groupProfit(lines, l => `${l.docType}:${l.docNum}`, l => ({ docType: l.docType, docNum: l.docNum, date: l.date, cardCode: l.cardCode, cardName: l.cardName, salesperson: l.salesperson })),
  };
  const month = groupProfit(lines, l => l.date.slice(0, 7), l => ({ month: l.date.slice(0, 7) })).sort((a, z) => a.month.localeCompare(z.month));

  const revenue = lines.reduce((s, l) => s + l.revenue, 0);
  const cost = lines.reduce((s, l) => s + l.cost, 0);
  const gp = revenue - cost;
  const margin = revenue ? (gp / revenue) * 100 : 0;
  const lossDocs = dims.document.filter(d => d.gp < 0 && d.docType === 'Invoice');
  const lossLines = lines.filter(l => l.sign > 0 && l.gp < 0).sort((a, z) => a.gp - z.gp)
    .map(l => ({ ...l, revenue: round(l.revenue), cost: round(l.cost), gp: round(l.gp), unitPriceLc: round(l.unitPriceLc, 2), unitCost: round(l.unitCost, 2), marginPct: l.revenue ? round((l.gp / l.revenue) * 100, 1) : null }));
  const noCost = lines.filter(l => l.sign > 0 && l.qty > 0 && l.unitCost <= 0);
  const cm = lines.filter(l => l.sign < 0).reduce((s, l) => s + l.revenue, 0);
  const top = dims.customer[0];
  const topShare = top && gp ? (top.gp / gp) * 100 : 0;
  // Customers whose revenue is large but margin is below the company average.
  const avgMargin = margin;
  const dilutive = dims.customer.filter(c => c.revenue > revenue * 0.02 && c.marginPct != null && c.marginPct < avgMargin - 5).sort((a, z) => z.revenue - a.revenue);

  const insight = lines.length
    ? `**Gross profit ${fmtAmt(gp)} on revenue ${fmtAmt(revenue)} (${round(margin, 1)}% margin), ${from} → ${to}.**\n\n` +
      (top ? `- Most profitable customer: **${top.cardName}** — ${fmtAmt(top.gp)} GP (${round(topShare, 1)}% of total) at ${top.marginPct}% margin.\n` : '') +
      (dims.item[0] ? `- Most profitable item: **${dims.item[0].itemCode}** ${dims.item[0].itemName} — ${fmtAmt(dims.item[0].gp)} GP.\n` : '') +
      (dims.salesperson[0] ? `- Top sales employee by GP: **${dims.salesperson[0].salesperson}** (${fmtAmt(dims.salesperson[0].gp)}, ${dims.salesperson[0].marginPct}%).\n` : '') +
      (lossDocs.length ? `- **${lossDocs.length} invoices were sold at a loss** (${fmtAmt(lossDocs.reduce((s, d) => s + d.gp, 0))}).\n` : '') +
      (dilutive.length ? `- ${dilutive.length} significant customers run 5+ points below the average margin, led by ${dilutive[0].cardName} (${dilutive[0].marginPct}%).\n` : '') +
      (noCost.length ? `- ${noCost.length} invoice lines carry no cost, which overstates their profit — check item costing.\n` : '') +
      (cm ? `- Credit memos reduced revenue by ${fmtAmt(-cm)}.\n` : '')
    : `**No A/R invoices between ${from} and ${to}.**`;

  const aiContext = `PROFITABILITY ${from} to ${to}. Revenue ${fmtAmt(revenue)}, cost ${fmtAmt(cost)}, GP ${fmtAmt(gp)} (${round(margin, 1)}%). Credit memos ${fmtAmt(cm)}. Loss-making invoices ${lossDocs.length}. Lines without cost ${noCost.length}.
BY CUSTOMER:
${ctxTable(dims.customer, [['cardName', 'Customer'], ['revenue', 'Revenue'], ['gp', 'GP'], ['marginPct', 'GM%']], 15)}
BY ITEM:
${ctxTable(dims.item, [['itemCode', 'Item'], ['itemName', 'Name'], ['qty', 'Qty'], ['revenue', 'Revenue'], ['gp', 'GP'], ['marginPct', 'GM%']], 15)}
BY SALES EMPLOYEE:
${ctxTable(dims.salesperson, [['salesperson', 'Slp'], ['revenue', 'Revenue'], ['gp', 'GP'], ['marginPct', 'GM%'], ['customers', 'Cust']], 12)}
BY WAREHOUSE: ${dims.warehouse.slice(0, 10).map(w => `${w.whsCode} ${fmtAmt(w.gp)} (${w.marginPct}%)`).join('; ')}
BY BRANCH: ${dims.branch.slice(0, 10).map(b => `${b.branch} ${fmtAmt(b.gp)} (${b.marginPct}%)`).join('; ')}
BY MONTH: ${month.map(m => `${m.month} rev ${fmtAmt(m.revenue)} gp ${fmtAmt(m.gp)} (${m.marginPct}%)`).join('; ')}
LOSS LINES:
${ctxTable(lossLines, [['docNum', 'Inv'], ['cardName', 'Customer'], ['itemCode', 'Item'], ['unitPriceLc', 'Price'], ['unitCost', 'Cost'], ['gp', 'GP']], 12)}`;

  const money = [{ key: 'revenue', label: 'Revenue', fmt: 'amt', hint: 'Invoiced sales in local currency after line and header discounts, less credit memos; freight excluded.' },
    { key: 'cost', label: 'Cost', fmt: 'amt', hint: 'Cost of sales = unit cost (gross-profit base price, else item cost at posting) × quantity.' },
    { key: 'gp', label: 'Gross profit', fmt: 'amt', strong: true, hint: 'Gross profit = revenue − cost.' },
    { key: 'marginPct', label: 'Margin', fmt: 'pct', hint: 'Gross margin % = gross profit ÷ revenue × 100.' }];
  const share = rows => rows.map(r => ({ ...r, gpShare: gp ? round((r.gp / gp) * 100, 1) : null }));
  const shareCol = { key: 'gpShare', label: '% of GP', fmt: 'pct', hint: 'Share of the company’s total gross profit = row gross profit ÷ total gross profit × 100.' };
  const custCol = { key: 'cardName', label: 'Customer', sub: 'cardCode', hint: 'Customer name with its business-partner code.' };
  const docsCol = { key: 'docs', label: 'Docs', fmt: 'int', hint: 'Number of invoices and credit memos in the period.' };
  const custCountCol = { key: 'customers', label: 'Customers', fmt: 'int', hint: 'Number of different customers who bought.' };
  const slpCol = { key: 'salesperson', label: 'Sales employee', hint: 'Sales employee on the document header.' };
  const invoices = dims.document.filter(d => d.docType === 'Invoice');
  const cmDocs = dims.document.filter(d => d.docType === 'Credit memo');
  const base = [SRC.oinv, SRC.inv1, ...(p.includeCreditMemos !== 'no' ? [SRC.orin] : [])];
  const revFormula = `Σ line total in local currency × (1 − header discount %)${p.includeCreditMemos !== 'no' ? ' − the same for A/R credit memos' : ''}, posted ${from} → ${to}.`;
  const costFormula = 'Σ unit cost × quantity, where unit cost = gross-profit base price on the line, else the item cost at posting.';

  return {
    kpis: [
      { label: 'Revenue', value: revenue, fmt: 'amt', hint: 'Net invoiced sales in the period (after discounts and credit memos)',
        calc: { formula: `Revenue = ${revFormula}`,
          steps: ['Line totals are already net of line discounts; the document header discount is then applied.', 'Cancelled documents are ignored; credit memos count negative.', 'Freight and other document-level charges are not included.'],
          sources: base, tab: 'customer', sortBy: 'revenue',
          stats: [{ label: 'Invoiced revenue', value: round(revenue - cm), fmt: 'amt' }, { label: 'Credit memos', value: round(cm), fmt: 'amt' },
            { label: 'Invoices', value: invoices.length, fmt: 'int' }, { label: 'Top customer revenue', value: dims.customer.reduce((m, c) => Math.max(m, c.revenue), 0), fmt: 'amt' }] } },
      { label: 'Cost of sales', value: cost, fmt: 'amt', hint: 'What the goods sold cost the company',
        calc: { formula: `Cost of sales = ${costFormula}`,
          steps: ['Gross-profit base price is the cost SAP stored on the invoice line for the gross-profit report.', 'If it is missing, the item cost at posting (stock price) is used.', 'Lines with no cost at all add zero cost and overstate profit.'],
          sources: [SRC.inv1, ...(p.includeCreditMemos !== 'no' ? [SRC.orin] : [])], tab: 'item', sortBy: 'cost',
          stats: [{ label: 'Cost / revenue', value: revenue ? round((cost / revenue) * 100, 1) : 0, fmt: 'pct' }, { label: 'Items sold', value: dims.item.length, fmt: 'int' },
            { label: 'Lines without cost', value: noCost.length, fmt: 'int' }] } },
      { label: 'Gross profit', value: gp, fmt: 'amt', tone: gp >= 0 ? 'good' : 'bad', hint: 'Revenue − cost of sales',
        calc: { formula: 'Gross profit = revenue − cost of sales.', steps: [`Revenue: ${revFormula}`, `Cost: ${costFormula}`],
          sources: base, tab: 'customer', sortBy: 'gp',
          stats: [{ label: 'Revenue', value: round(revenue), fmt: 'amt' }, { label: 'Cost of sales', value: round(cost), fmt: 'amt' },
            { label: 'Top customer GP', value: top ? top.gp : 0, fmt: 'amt' }, { label: 'Top customer share', value: round(topShare, 1), fmt: 'pct' },
            { label: 'Loss on loss-making invoices', value: round(lossDocs.reduce((s, d) => s + d.gp, 0)), fmt: 'amt' }] } },
      { label: 'Gross margin', value: margin, fmt: 'pct', tone: margin >= 15 ? 'good' : margin >= 5 ? 'warn' : 'bad', hint: 'Gross profit as % of revenue',
        calc: { formula: 'Gross margin % = gross profit ÷ revenue × 100.', steps: ['Tile colour: green ≥ 15%, amber 5–15%, red < 5%.', 'Customers listed below are significant (> 2% of revenue) and run 5+ points below the average margin.'],
          sources: base, rows: dilutive, columns: [custCol, ...money], sortBy: 'revenue',
          stats: [{ label: 'Gross profit', value: round(gp), fmt: 'amt' }, { label: 'Revenue', value: round(revenue), fmt: 'amt' },
            { label: 'Margin-dilutive customers', value: dilutive.length, fmt: 'int' }, { label: 'Months covered', value: month.length, fmt: 'int' }] } },
      { label: 'Customers', value: dims.customer.length, fmt: 'int', hint: 'Distinct customers invoiced (or credited) in the period',
        calc: { formula: 'Count of distinct customer codes on invoices and credit memos in the period.', sources: base, tab: 'customer', sortBy: 'gp',
          stats: [{ label: 'Profitable customers', value: dims.customer.filter(c => c.gp > 0).length, fmt: 'int' }, { label: 'Loss-making customers', value: dims.customer.filter(c => c.gp < 0).length, fmt: 'int' },
            { label: 'Top customer share of GP', value: round(topShare, 1), fmt: 'pct' }, { label: 'Margin-dilutive customers', value: dilutive.length, fmt: 'int' }] } },
      { label: 'Invoices', value: invoices.length, fmt: 'int', hint: 'A/R invoices posted in the period',
        calc: { formula: `Count of non-cancelled A/R invoices dated ${from} → ${to}.`, sources: [SRC.oinv], tab: 'document', filter: d => d.docType === 'Invoice', sortBy: 'revenue',
          stats: [{ label: 'Invoices', value: invoices.length, fmt: 'int' }, { label: 'Credit memos', value: cmDocs.length, fmt: 'int' },
            { label: 'Average invoice revenue', value: invoices.length ? round(invoices.reduce((s, d) => s + d.revenue, 0) / invoices.length) : 0, fmt: 'amt' },
            { label: 'Loss-making invoices', value: lossDocs.length, fmt: 'int' }] } },
      { label: 'Loss-making invoices', value: lossDocs.length, fmt: 'int', tone: lossDocs.length ? 'bad' : 'good', hint: 'Invoices whose cost exceeds their revenue',
        calc: { formula: 'Count of A/R invoices whose total gross profit (revenue − cost over all lines) is below zero.',
          steps: ['A single loss-making line does not make the invoice loss-making if other lines cover it.', 'See the "Loss-making lines" tab for line-level detail.'],
          sources: [SRC.oinv, SRC.inv1], tab: 'document', filter: d => d.docType === 'Invoice' && d.gp < 0, sortBy: 'gp',
          stats: [{ label: 'Total loss', value: round(lossDocs.reduce((s, d) => s + d.gp, 0)), fmt: 'amt' }, { label: 'Revenue on these invoices', value: round(lossDocs.reduce((s, d) => s + d.revenue, 0)), fmt: 'amt' },
            { label: 'Loss-making lines', value: lossLines.length, fmt: 'int' }, { label: 'Customers affected', value: new Set(lossDocs.map(d => d.cardCode)).size, fmt: 'int' }] } },
      { label: 'Lines without cost', value: noCost.length, fmt: 'int', tone: noCost.length ? 'warn' : 'good', hint: 'Profit on these lines is overstated',
        calc: { formula: 'Count of invoice lines with quantity > 0 but no unit cost (no gross-profit base price and no item cost).',
          steps: ['These lines count their full revenue as gross profit.', 'Typical causes: service/non-stock items, items never received into stock, missing item cost.'],
          sources: [SRC.inv1, SRC.oitm],
          rows: noCost.map(l => ({ ...l, revenue: round(l.revenue) })),
          columns: [{ key: 'docNum', label: 'Invoice #' }, { key: 'date', label: 'Date', fmt: 'date' }, custCol, { key: 'itemCode', label: 'Item', sub: 'itemName' },
            { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'revenue', label: 'Revenue (no cost)', fmt: 'amt' }],
          sortBy: 'revenue', chart: null,
          stats: [{ label: 'Revenue without cost', value: round(noCost.reduce((s, l) => s + l.revenue, 0)), fmt: 'amt' }, { label: 'Items affected', value: new Set(noCost.map(l => l.itemCode)).size, fmt: 'int' },
            { label: 'Invoices affected', value: new Set(noCost.map(l => l.docNum)).size, fmt: 'int' }] } },
    ],
    chart: { title: 'Revenue and gross profit by month', type: 'bar', labels: month.map(m => m.month),
      desc: 'Grey bars show net revenue and coloured bars gross profit per month; a widening gap means margin is shrinking.',
      series: [{ name: 'Revenue', values: month.map(m => m.revenue), color: '#94A3B8' }, { name: 'Gross profit', values: month.map(m => m.gp) }] },
    tabs: [
      { key: 'customer', label: `By customer (${dims.customer.length})`, rows: share(dims.customer),
        desc: 'Revenue, cost and gross profit per customer, most profitable first — look for big customers with low margins.',
        columns: [custCol, ...money, shareCol, docsCol] },
      { key: 'item', label: `By item (${dims.item.length})`, rows: share(dims.item),
        desc: 'Profit per item sold, most profitable first — spot items sold at thin or negative margins.',
        columns: [{ key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'Item code with its description.' }, { key: 'group', label: 'Group', hint: 'Item group from the item master.' },
          { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Net quantity sold (invoiced − credited).' }, ...money, shareCol, custCountCol] },
      { key: 'salesperson', label: `By sales employee (${dims.salesperson.length})`, rows: share(dims.salesperson),
        desc: 'Profit generated by each sales employee — compare margins, not just revenue.',
        columns: [slpCol, ...money, shareCol, custCountCol, docsCol] },
      { key: 'warehouse', label: `By warehouse (${dims.warehouse.length})`, rows: share(dims.warehouse),
        desc: 'Profit by the warehouse the goods shipped from.',
        columns: [{ key: 'whsCode', label: 'Warehouse', hint: 'Warehouse code on the invoice line.' }, ...money, shareCol, { key: 'lines', label: 'Lines', fmt: 'int', hint: 'Number of invoice/credit-memo lines.' }] },
      { key: 'branch', label: `By branch (${dims.branch.length})`, rows: share(dims.branch),
        desc: 'Profit by company branch (one total when branches are not used).',
        columns: [{ key: 'branch', label: 'Branch', hint: 'Branch on the document header.' }, ...money, shareCol, custCountCol] },
      { key: 'group', label: `By item group (${dims.group.length})`, rows: share(dims.group),
        desc: 'Profit by item group — shows which product families carry the business.',
        columns: [{ key: 'group', label: 'Item group', hint: 'Item group from the item master.' }, ...money, shareCol] },
      { key: 'document', label: `By document (${dims.document.length})`, rows: dims.document.sort(byGp),
        desc: 'Every invoice and credit memo with its profit, most profitable first — scroll to the bottom for loss makers.',
        columns: [{ key: 'docType', label: 'Type', fmt: 'badge', badge: { Invoice: 'blue', 'Credit memo': 'amber' }, hint: 'A/R invoice or A/R credit memo (credit memos reduce revenue and cost).' },
          { key: 'docNum', label: 'Doc #', hint: 'SAP document number.' },
          { key: 'date', label: 'Date', fmt: 'date', hint: 'Posting date of the document.' }, custCol, slpCol, ...money] },
      { key: 'loss', label: `Loss-making lines (${lossLines.length})`, rows: lossLines,
        desc: 'Invoice lines sold below cost, biggest loss first — check pricing, discounts or item cost.',
        columns: [{ key: 'docNum', label: 'Invoice #', hint: 'SAP invoice number.' }, { key: 'date', label: 'Date', fmt: 'date', hint: 'Invoice posting date.' }, custCol,
          { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'Item code with its description.' }, { key: 'qty', label: 'Qty', fmt: 'num', hint: 'Quantity invoiced.' },
          { key: 'unitPriceLc', label: 'Unit price', fmt: 'price', hint: 'Net selling price per unit in local currency = line total ÷ quantity.' },
          { key: 'unitCost', label: 'Unit cost', fmt: 'price', hint: 'Cost per unit: gross-profit base price, else item cost at posting.' },
          { key: 'gp', label: 'Loss', fmt: 'amt', strong: true, hint: 'Gross profit of the line = revenue − cost (negative = loss).' },
          { key: 'marginPct', label: 'Margin', fmt: 'pct', hint: 'Line margin % = gross profit ÷ revenue × 100.' },
          slpCol] },
    ],
    notes: [
      `Period ${from} → ${to}. Revenue = A/R invoice line totals in local currency after header discount${p.includeCreditMemos !== 'no' ? ', less A/R credit memos' : ''}. Cost = gross-profit base price, else item cost at posting, × quantity.`,
      'Freight and other document-level expenses are excluded from revenue (see the Margin Leakage agent for freight).',
      dims.branch.length === 1 && dims.branch[0].branch === '(single branch)' ? 'Branches are not enabled on this company, so the branch view shows one total.' : '',
    ].filter(Boolean),
    insight, aiContext,
  };
}

export function createProfitabilityAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'profitability', title: 'Profitability Agent',
    defaults: { days: 90 },
    persona: 'You are a financial controller analysing gross profitability in SAP Business One.',
    aiTask: 'Analyse this profitability data. Identify where profit is made and lost by customer, item, sales employee, warehouse and branch, which accounts dilute margin, and concrete actions to improve gross profit.',
    run,
  });
}
