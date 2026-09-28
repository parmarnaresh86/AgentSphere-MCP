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

  const money = [{ key: 'revenue', label: 'Revenue', fmt: 'amt' }, { key: 'cost', label: 'Cost', fmt: 'amt' },
    { key: 'gp', label: 'Gross profit', fmt: 'amt', strong: true }, { key: 'marginPct', label: 'Margin', fmt: 'pct' }];
  const share = rows => rows.map(r => ({ ...r, gpShare: gp ? round((r.gp / gp) * 100, 1) : null }));
  const shareCol = { key: 'gpShare', label: '% of GP', fmt: 'pct' };

  return {
    kpis: [
      { label: 'Revenue', value: revenue, fmt: 'amt' },
      { label: 'Cost of sales', value: cost, fmt: 'amt' },
      { label: 'Gross profit', value: gp, fmt: 'amt', tone: gp >= 0 ? 'good' : 'bad' },
      { label: 'Gross margin', value: margin, fmt: 'pct', tone: margin >= 15 ? 'good' : margin >= 5 ? 'warn' : 'bad' },
      { label: 'Customers', value: dims.customer.length, fmt: 'int' },
      { label: 'Invoices', value: dims.document.filter(d => d.docType === 'Invoice').length, fmt: 'int' },
      { label: 'Loss-making invoices', value: lossDocs.length, fmt: 'int', tone: lossDocs.length ? 'bad' : 'good' },
      { label: 'Lines without cost', value: noCost.length, fmt: 'int', tone: noCost.length ? 'warn' : 'good', hint: 'Profit on these lines is overstated' },
    ],
    chart: { title: 'Revenue and gross profit by month', type: 'bar', labels: month.map(m => m.month),
      series: [{ name: 'Revenue', values: month.map(m => m.revenue), color: '#94A3B8' }, { name: 'Gross profit', values: month.map(m => m.gp) }] },
    tabs: [
      { key: 'customer', label: `By customer (${dims.customer.length})`, rows: share(dims.customer),
        columns: [{ key: 'cardName', label: 'Customer', sub: 'cardCode' }, ...money, shareCol, { key: 'docs', label: 'Docs', fmt: 'int' }] },
      { key: 'item', label: `By item (${dims.item.length})`, rows: share(dims.item),
        columns: [{ key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'group', label: 'Group' }, { key: 'qty', label: 'Qty', fmt: 'num' }, ...money, shareCol, { key: 'customers', label: 'Customers', fmt: 'int' }] },
      { key: 'salesperson', label: `By sales employee (${dims.salesperson.length})`, rows: share(dims.salesperson),
        columns: [{ key: 'salesperson', label: 'Sales employee' }, ...money, shareCol, { key: 'customers', label: 'Customers', fmt: 'int' }, { key: 'docs', label: 'Docs', fmt: 'int' }] },
      { key: 'warehouse', label: `By warehouse (${dims.warehouse.length})`, rows: share(dims.warehouse),
        columns: [{ key: 'whsCode', label: 'Warehouse' }, ...money, shareCol, { key: 'lines', label: 'Lines', fmt: 'int' }] },
      { key: 'branch', label: `By branch (${dims.branch.length})`, rows: share(dims.branch),
        columns: [{ key: 'branch', label: 'Branch' }, ...money, shareCol, { key: 'customers', label: 'Customers', fmt: 'int' }] },
      { key: 'group', label: `By item group (${dims.group.length})`, rows: share(dims.group),
        columns: [{ key: 'group', label: 'Item group' }, ...money, shareCol] },
      { key: 'document', label: `By document (${dims.document.length})`, rows: dims.document.sort(byGp),
        columns: [{ key: 'docType', label: 'Type', fmt: 'badge', badge: { Invoice: 'blue', 'Credit memo': 'amber' } }, { key: 'docNum', label: 'Doc #' },
          { key: 'date', label: 'Date', fmt: 'date' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' }, { key: 'salesperson', label: 'Sales employee' }, ...money] },
      { key: 'loss', label: `Loss-making lines (${lossLines.length})`, rows: lossLines,
        columns: [{ key: 'docNum', label: 'Invoice #' }, { key: 'date', label: 'Date', fmt: 'date' }, { key: 'cardName', label: 'Customer', sub: 'cardCode' },
          { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'qty', label: 'Qty', fmt: 'num' }, { key: 'unitPriceLc', label: 'Unit price', fmt: 'price' },
          { key: 'unitCost', label: 'Unit cost', fmt: 'price' }, { key: 'gp', label: 'Loss', fmt: 'amt', strong: true }, { key: 'marginPct', label: 'Margin', fmt: 'pct' },
          { key: 'salesperson', label: 'Sales employee' }] },
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
