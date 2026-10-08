/**
 * Inventory Optimization Agent — mounted at /api/inventory-optimization-agent
 *
 * From weekly net sales demand (OINM) and lead time, computes per item:
 *   safety stock  SS  = z(service level) × σ(weekly demand) × √(lead time weeks)
 *   reorder point ROP = daily demand × lead time + SS            (→ recommended Min)
 *   order-up-to   MAX = ROP + daily demand × review period       (→ recommended Max)
 * then flags items to reorder now, stock-out risks, excess stock, and SAP
 * Min/Max settings that are missing or out of line, with ABC/XYZ classes.
 */
import { createInsightRouter, ctxTable, daysBetween, num, round, clamp, stddev, fmtAmt } from '../lib/insight-kit.mjs';
import { loadItems, loadWarehouseStock, loadDemandMovements, since } from '../lib/insight-data.mjs';

const Z = [[80, 0.84], [85, 1.04], [90, 1.28], [95, 1.645], [97.5, 1.96], [98, 2.05], [99, 2.33], [99.5, 2.58]];
const zFor = sl => Z.reduce((best, cur) => (Math.abs(cur[0] - sl) < Math.abs(best[0] - sl) ? cur : best))[1];
// Decision table for the explain popup; `hit` only on the rule whose result applied (keeps JSON small).
// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oinm: 'OINM — inventory transactions: quantities delivered, invoiced, issued to production and returned, by date',
  oitm: 'OITM — item master: in stock / committed / on order, lead time, Min/Max, average & last purchase price, preferred vendor',
  oitw: 'OITW — stock per warehouse: in stock, committed, on order, Min/Max, average price (when a warehouse is selected)',
  oitb: 'OITB — item groups',
};
const rulesHit = (list, applied) => list.map(([rule, result]) => (result === applied ? { rule, result, hit: true } : { rule, result }));
// Rows are shared by several tabs: give each tab a copy carrying only the explanations for its own columns
// ('col:source' shows explain[source] on column col).
const withExplain = (list, keys) => list.map(r => {
  const { explain, ...rest } = r, ex = {};
  for (const spec of keys) { const [key, src = key] = spec.split(':'); if (explain?.[src]) ex[key] = explain[src]; }
  return Object.keys(ex).length ? { ...rest, explain: ex } : rest;
});

async function run(k, p) {
  const asOf = p.asOf;
  const lookback = clamp(Math.round(num(p.lookbackDays) || 180), 28, 730);
  const serviceLevel = clamp(num(p.serviceLevel) || 95, 80, 99.5);
  const z = zFor(serviceLevel);
  const reviewDays = clamp(num(p.reviewDays) || 14, 1, 90);
  const defaultLT = clamp(num(p.defaultLeadTime) || 14, 1, 365);
  const warehouse = String(p.warehouse || '').trim();
  const from = since(asOf, lookback);

  const items = await loadItems(k);
  const whsStock = warehouse ? new Map((await loadWarehouseStock(k, { warehouse })).map(r => [r.itemCode, r])) : null;
  const moves = await loadDemandMovements(k, from, { warehouse, until: asOf });

  const W = Math.ceil(lookback / 7);
  const series = new Map();
  for (const m of moves) {
    if (!series.has(m.itemCode)) series.set(m.itemCode, new Array(W).fill(0));
    const idx = clamp(Math.floor(daysBetween(from, m.date) / 7), 0, W - 1);
    series.get(m.itemCode)[idx] += m.qty;
  }

  const rows = [];
  const detailedRows = new Set();   // rows shown in Reorder / Excess / Min-Max tabs get the full explanations
  for (const it of items.values()) {
    const s = warehouse ? whsStock.get(it.itemCode) : null;
    if (warehouse && !s) continue;
    const onHand = s ? s.onHand : it.onHand, committed = s ? s.committed : it.committed, onOrder = s ? s.onOrder : it.onOrder;
    const curMin = s ? s.minStock : it.minLevel, curMax = s ? s.maxStock : it.maxLevel;
    const weeks = (series.get(it.itemCode) || new Array(W).fill(0)).map(x => Math.max(0, x));
    const total = weeks.reduce((a, b) => a + b, 0);
    if (total <= 0 && onHand <= 0) continue;

    const d = total / lookback;
    const muW = total / W, sigW = stddev(weeks);
    const lt = it.leadTime > 0 ? it.leadTime : defaultLT;
    const ss = z * sigW * Math.sqrt(lt / 7);
    const rop = d * lt + ss;
    const max = rop + d * reviewDays;
    const projected = onHand - committed + onOrder;
    const cost = (s?.avgPrice ?? null) || it.avgPrice || it.lastPurPrice;
    const coverDays = d > 0 ? onHand / d : null;
    const activeWeeks = weeks.filter(x => x > 0).length;

    let status = 'OK', action = 'Within recommended range', suggestQty = 0, excessQty = 0;
    if (total <= 0) { status = 'NO DEMAND'; action = `No sales or consumption in ${lookback} days — review in the Dead Stock agent`; }
    else if (projected <= 0) { status = 'STOCKOUT RISK'; suggestQty = max - projected; action = `Projected stock ${round(projected, 2)} after commitments — order ${round(suggestQty, 2)} now`; }
    else if (projected <= rop) { status = 'REORDER'; suggestQty = max - projected; action = `At/below reorder point — order ${round(suggestQty, 2)} to reach ${round(max, 2)}`; }
    else if (onHand > max * 1.5 && onHand - max > d * 30) { status = 'EXCESS'; excessQty = onHand - max; action = `${Math.round(coverDays)} days of cover — pause purchasing; ${round(excessQty, 2)} above max`; }

    if (d > 0 && committed > d * 90 && suggestQty > 0) action += ` (committed qty = ${Math.round(committed / d)} days of normal demand — verify the open sales orders first)`;

    const gapOf = (cur, rec) => (!cur ? 'NOT SET' : rec > 0 && Math.abs(cur - rec) / rec > 0.25 ? 'ADJUST' : 'OK');
    const minGap = total > 0 ? gapOf(curMin, rop) : 'OK';
    const maxGap = total > 0 ? gapOf(curMax, max) : 'OK';
    const paramStatus = minGap === 'OK' && maxGap === 'OK' ? 'OK' : minGap === 'NOT SET' || maxGap === 'NOT SET' ? 'NOT SET' : 'ADJUST';

    // "How is this calculated?" popups (click the cell) — built from the values above.
    // Kept compact (rows appear in several tabs); each step shows only its own inputs.
    const n2 = v => round(v, 2), d3 = round(d, 3);
    const explain = {
      status: { rules: rulesHit([
        [`No sales or consumption in ${lookback} days`, 'NO DEMAND'],
        ['Projected stock ≤ 0', 'STOCKOUT RISK'],
        ['Projected stock ≤ reorder point', 'REORDER'],
        ['On hand > 1.5 × order-up-to and surplus > 30 days of demand', 'EXCESS'],
        ['Otherwise', 'OK'],
      ], status), note: total > 0 ? `Projected ${n2(projected)}, reorder point ${n2(rop)}, order-up-to ${n2(max)}, on hand ${n2(onHand)}.` : undefined },
    };
    const detailed = (status !== 'OK' && status !== 'NO DEMAND') || paramStatus !== 'OK';
    if (total > 0) {
      const ssStep = { label: 'Safety stock', formula: 'service factor z × weekly σ × √(lead time in weeks)', value: n2(ss), detail: `${z} (${serviceLevel}% service) × ${n2(sigW)} × √(${lt}/7)` };
      const ropStep = { label: 'Reorder point', formula: 'daily demand × lead time + safety stock', value: n2(rop), detail: `${d3} × ${lt} d${it.leadTime > 0 ? '' : ' (default)'} + ${n2(ss)}` };
      const maxStep = { label: 'Order-up-to', formula: 'reorder point + daily demand × review period', value: n2(max), detail: `${n2(rop)} + ${d3} × ${reviewDays} d` };
      const dStep = { label: 'Daily demand', formula: `demand ÷ ${lookback} days`, value: d3, detail: `${n2(total)} units` };
      const sigStep = { label: 'Weekly σ', formula: 'variation of weekly demand (std. dev.)', value: n2(sigW), detail: `${W} weeks, avg ${n2(muW)}/week` };
      explain.reorderPoint = { steps: [dStep, ropStep] };   // short form for the All-items tab
      if (detailed) {
        explain.safetyStock = { steps: [sigStep, ssStep] };
        explain.recMin = { steps: [dStep, sigStep, ssStep, ropStep] };
        explain.recMax = { steps: [maxStep] };
        const projStep = { label: 'Projected stock', formula: 'on hand − committed + on order', value: n2(projected), detail: `${n2(onHand)} − ${n2(committed)} + ${n2(onOrder)}` };
        explain.projected = { steps: [projStep] };
        if (suggestQty > 0) {
          explain.suggestQty = { steps: [projStep,
            { label: 'Order qty', formula: 'order-up-to − projected stock', value: n2(suggestQty), detail: `${n2(max)} − ${projected < 0 ? `(${n2(projected)})` : n2(projected)}` }] };
          explain.orderValue = { steps: [{ label: 'Order value', formula: 'order qty × unit cost', value: round(suggestQty * cost), detail: `${n2(suggestQty)} × ${n2(cost)}` }] };
        }
        if (excessQty > 0) {
          explain.excessQty = { steps: [{ label: 'Excess qty', formula: 'on hand − order-up-to', value: n2(excessQty), detail: `${n2(onHand)} − ${n2(max)}` }] };
          explain.excessValue = { steps: [{ label: 'Excess value', formula: 'excess qty × unit cost', value: round(excessQty * cost), detail: `${n2(excessQty)} × ${n2(cost)}` }] };
          explain.coverDays = { steps: [{ label: 'Cover', formula: 'on hand ÷ daily demand', value: Math.round(coverDays), detail: `${n2(onHand)} ÷ ${d3}` }] };
        }
        if (paramStatus !== 'OK') explain.paramStatus = { rules: rulesHit([
          ['SAP min or max not set', 'NOT SET'],
          ['SAP min or max more than 25% off the recommendation', 'ADJUST'],
          ['Both within 25%', 'OK'],
        ], paramStatus), note: `Min: SAP ${n2(curMin)} vs rec. ${n2(rop)} (${minGap}). Max: SAP ${n2(curMax)} vs rec. ${n2(max)} (${maxGap}).` };
      }
    }

    rows.push({
      itemCode: it.itemCode, itemName: it.itemName, group: it.group, status, action,
      onHand: round(onHand, 2), committed: round(committed, 2), onOrder: round(onOrder, 2), projected: round(projected, 2),
      avgDaily: round(d, 3), avgWeekly: round(muW, 2), weeklyStd: round(sigW, 2), activeWeeks,
      cv: muW > 0 ? round(sigW / muW, 2) : null, leadTime: lt, leadTimeSource: it.leadTime > 0 ? 'item' : 'default',
      safetyStock: round(ss, 2), reorderPoint: round(rop, 2), recMin: round(rop, 2), recMax: round(max, 2),
      curMin: round(curMin, 2), curMax: round(curMax, 2), minGap, maxGap,
      paramStatus,
      suggestQty: round(suggestQty, 2), orderValue: round(suggestQty * cost), excessQty: round(excessQty, 2),
      excessValue: round(excessQty * cost), unitCost: round(cost, 2), stockValue: round(onHand * cost),
      annualValue: d * 365 * cost, coverDays: coverDays != null ? Math.round(coverDays) : null, vendor: it.prefVendor,
      explain,
    });
    if (detailed) detailedRows.add(rows[rows.length - 1]);
  }

  // ABC by annual consumption value, XYZ by demand variability.
  const withDemand = rows.filter(r => r.avgDaily > 0).sort((a, z2) => z2.annualValue - a.annualValue);
  const totalAnnual = withDemand.reduce((s, r) => s + r.annualValue, 0) || 1;
  let cum = 0;
  for (const r of withDemand) {
    cum += r.annualValue; r.abc = cum / totalAnnual <= 0.8 ? 'A' : cum / totalAnnual <= 0.95 ? 'B' : 'C';
    if (detailedRows.has(r)) r.explain.abc = {
      steps: [{ label: 'Annual usage value', formula: 'daily demand × 365 × unit cost', value: round(r.annualValue), detail: `${r.avgDaily} × 365 × ${r.unitCost}` },
        { label: 'Cumulative share', formula: 'running total, largest items first ÷ total', value: `${round((cum / totalAnnual) * 100, 1)}%`, detail: `of ${fmtAmt(totalAnnual)}` }],
      rules: rulesHit([['Cumulative share ≤ 80%', 'A'], ['Cumulative share ≤ 95%', 'B'], ['Remaining 5%', 'C']], r.abc) };
  }
  for (const r of rows) {
    r.abc = r.abc || '—';
    r.xyz = r.cv == null ? '—' : r.cv < 0.5 ? 'X' : r.cv < 1 ? 'Y' : 'Z';
    r.annualValue = round(r.annualValue);
    if (detailedRows.has(r) && r.cv != null) r.explain.xyz = {
      steps: [{ label: 'Variation (CV)', formula: 'weekly σ ÷ average weekly demand', value: r.cv, detail: `${r.weeklyStd} ÷ ${r.avgWeekly}` }],
      rules: rulesHit([['CV < 0.5 (steady)', 'X'], ['CV 0.5 – 1 (variable)', 'Y'], ['CV ≥ 1 (erratic)', 'Z']], r.xyz) };
  }

  const reorder = rows.filter(r => r.status === 'REORDER' || r.status === 'STOCKOUT RISK')
    .sort((a, z2) => (a.status === 'STOCKOUT RISK' ? 0 : 1) - (z2.status === 'STOCKOUT RISK' ? 0 : 1) || 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(z2.abc) || z2.orderValue - a.orderValue);
  const excess = rows.filter(r => r.status === 'EXCESS').sort((a, z2) => z2.excessValue - a.excessValue);
  const params = rows.filter(r => r.paramStatus !== 'OK').sort((a, z2) => 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(z2.abc) || z2.annualValue - a.annualValue);
  const stockValue = rows.reduce((s, r) => s + r.stockValue, 0);
  const excessValue = excess.reduce((s, r) => s + r.excessValue, 0);
  const orderValue = reorder.reduce((s, r) => s + r.orderValue, 0);
  const stockouts = reorder.filter(r => r.status === 'STOCKOUT RISK');
  const defaultLtCount = rows.filter(r => r.leadTimeSource === 'default' && r.avgDaily > 0).length;

  const byStatus = ['STOCKOUT RISK', 'REORDER', 'OK', 'EXCESS', 'NO DEMAND'].map(st => {
    const r = rows.filter(x => x.status === st);
    return { status: st, items: r.length, stockValue: round(r.reduce((s, x) => s + x.stockValue, 0)) };
  });

  const insight = `**${reorder.length} items need ordering now (${stockouts.length} at stock-out risk, ~${fmtAmt(orderValue)}); ${excess.length} items carry ${fmtAmt(excessValue)} of excess stock.**\n\n` +
    (stockouts[0] ? `- Most urgent: **${stockouts[0].itemCode}** ${stockouts[0].itemName} (class ${stockouts[0].abc}) — projected ${stockouts[0].projected}, order ${stockouts[0].suggestQty}.\n` : '') +
    (excess[0] ? `- Largest excess: **${excess[0].itemCode}** — ${excess[0].coverDays} days of cover, ${fmtAmt(excess[0].excessValue)} above max.\n` : '') +
    `- ${params.length} items have SAP Min/Max settings missing or more than 25% off the recommendation.\n` +
    (defaultLtCount ? `- ${defaultLtCount} items have no lead time on the item master; ${defaultLT} days was assumed. Set OITM lead times for sharper results.\n` : '');

  const aiContext = `INVENTORY OPTIMISATION as of ${asOf}${warehouse ? `, warehouse ${warehouse}` : ', all warehouses'}. Demand lookback ${lookback}d, service level ${serviceLevel}% (z=${z}), review period ${reviewDays}d, default lead time ${defaultLT}d.
Items ${rows.length}, stock value ${fmtAmt(stockValue)}, reorder ${reorder.length} (${fmtAmt(orderValue)}), stock-out risk ${stockouts.length}, excess ${excess.length} (${fmtAmt(excessValue)}), parameter changes ${params.length}.
REORDER:
${ctxTable(reorder, [['itemCode', 'Item'], ['abc', 'ABC'], ['xyz', 'XYZ'], ['projected', 'Projected'], ['reorderPoint', 'ROP'], ['recMax', 'Max'], ['suggestQty', 'OrderQty'], ['leadTime', 'LT'], ['vendor', 'Vendor']], 20)}
EXCESS:
${ctxTable(excess, [['itemCode', 'Item'], ['onHand', 'OnHand'], ['recMax', 'Max'], ['coverDays', 'CoverDays'], ['excessValue', 'ExcessValue']], 15)}
PARAMETER CHANGES:
${ctxTable(params, [['itemCode', 'Item'], ['abc', 'ABC'], ['curMin', 'CurMin'], ['recMin', 'RecMin'], ['curMax', 'CurMax'], ['recMax', 'RecMax']], 15)}`;

  const idCols = [{ key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'SAP item code and description' },
    { key: 'abc', label: 'ABC', fmt: 'badge', badge: { A: 'purple', B: 'blue', C: 'grey' }, hint: 'Value class by annual usage value: A = items making up the first 80% of value, B = next 15%, C = last 5%' },
    { key: 'xyz', label: 'XYZ', fmt: 'badge', badge: { X: 'green', Y: 'amber', Z: 'red' }, hint: 'Demand steadiness: X = steady (variation < 0.5), Y = variable (0.5–1), Z = erratic (≥ 1)' }];
  const H = {
    status: 'Stock situation: STOCKOUT RISK (projected ≤ 0), REORDER (projected ≤ reorder point), EXCESS (well above order-up-to), NO DEMAND or OK',
    onHand: 'Quantity physically in stock now (SAP "In Stock")',
    committed: 'Quantity reserved for open sales orders (SAP "Committed")',
    onOrder: 'Quantity on open purchase / production orders not yet received (SAP "Ordered")',
    projected: 'Stock you will have once orders are settled = on hand − committed + on order',
    reorderPoint: `Reorder point = daily demand × lead time + safety stock; order when projected stock falls to this level`,
    recMax: `Order-up-to level = reorder point + daily demand × ${reviewDays}-day review period`,
    suggestQty: 'Quantity to order now = order-up-to level − projected stock',
    orderValue: 'Order quantity × unit cost (average cost, else last purchase price)',
    leadTime: `Days from ordering to receipt, from the item master; ${defaultLT} days assumed when not set`,
    vendor: 'Preferred vendor on the item master',
    avgDaily: `Average daily demand = net quantity sold/consumed in the last ${lookback} days ÷ ${lookback}`,
    coverDays: 'Days the current stock lasts at the average daily demand = on hand ÷ daily demand',
    excessQty: 'Stock above the order-up-to level = on hand − order-up-to',
    excessValue: 'Excess quantity × unit cost — cash tied up in surplus stock',
    action: 'Recommended next step for this item',
    paramStatus: 'SAP Min/Max check: NOT SET (missing), ADJUST (more than 25% off the recommendation) or OK',
    curMin: 'Minimum stock currently set in SAP',
    recMin: 'Recommended minimum = the reorder point (daily demand × lead time + safety stock)',
    curMax: 'Maximum stock currently set in SAP',
    safetyStock: `Buffer for demand swings = z ${z} (${serviceLevel}% service) × weekly σ × √(lead time in weeks)`,
    avgWeekly: `Average weekly demand over the last ${W} weeks`,
    weeklyStd: 'Standard deviation of weekly demand — how much demand swings week to week',
    group: 'Item group (SAP)',
    annualValue: 'Expected yearly consumption value = daily demand × 365 × unit cost (basis for ABC)',
    stockValue: 'Value of stock on hand = on hand × unit cost',
  };
  const hinted = cols => cols.map(c => (c.hint || !H[c.key] ? c : { ...c, hint: H[c.key] }));
  const valOf = list => round(list.reduce((s, r) => s + r.stockValue, 0));
  const methodSteps = [
    `Demand = deliveries + direct A/R invoices + goods issues + production issues − A/R credit memos and returns, posted since ${from} (${lookback}-day lookback to ${asOf})${warehouse ? ` in warehouse ${warehouse}` : ''}, bucketed weekly; daily demand = total ÷ ${lookback}.`,
    'Projected stock = on hand − committed + on order (current SAP quantities); order qty = order-up-to − projected.',
    `Safety stock = z ${z} (${serviceLevel}% service) × weekly σ × √(lead time ÷ 7); reorder point = daily demand × lead time + safety stock.`,
    `Lead time from the item master, else ${defaultLT} days (${defaultLtCount} items with demand use the default).`,
  ];
  // ── KPI drill-through helpers (popup charts / tables / insights) ──
  const sumOf = (list, f) => list.reduce((s, r) => s + (typeof f === 'function' ? f(r) : num(r[f])), 0);
  const topBy = (list, by, n = 20) => [...list].sort((a, z2) => num(z2[by]) - num(a[by])).slice(0, n);
  const pctOf = (a, b) => (b ? round((a / b) * 100, 1) : 0);
  const nm = r => `**${r.itemCode}** ${r.itemName || ''}`.trim();
  const q2 = v => round(v, 2);
  const aggBy = (list, keyFn, valFn) => {
    const m = new Map();
    for (const r of list) { const kk = keyFn(r) || '—'; m.set(kk, (m.get(kk) || 0) + valFn(r)); }
    return [...m.entries()].sort((a, z2) => z2[1] - a[1]);
  };
  const vendLabel = v => (v === '—' ? '(no preferred vendor)' : v);
  const STATUS_COLORS = [['STOCKOUT RISK', '#DC2626'], ['REORDER', '#F59E0B'], ['OK', '#16A34A'], ['EXCESS', '#7C3AED'], ['NO DEMAND', '#94A3B8']];
  const ABC_KEYS = [['A', '#7C3AED'], ['B', '#2563EB'], ['C', '#94A3B8'], ['—', '#CBD5E1']];
  const abcLabel = c => (c === '—' ? 'Unclassified' : `Class ${c}`);
  const C = {
    item: idCols[0], abc: idCols[1], xyz: idCols[2], status: { key: 'status', label: 'Status', fmt: 'badge' },
    onHand: { key: 'onHand', label: 'On hand', fmt: 'num' }, committed: { key: 'committed', label: 'Committed', fmt: 'num' },
    onOrder: { key: 'onOrder', label: 'On order', fmt: 'num' }, projected: { key: 'projected', label: 'Projected', fmt: 'num', strong: true },
    rop: { key: 'reorderPoint', label: 'Reorder pt', fmt: 'num' }, qty: { key: 'suggestQty', label: 'Order qty', fmt: 'num', strong: true },
    orderValue: { key: 'orderValue', label: 'Order value', fmt: 'amt' }, unitCost: { key: 'unitCost', label: 'Unit cost', fmt: 'num', hint: 'Average cost, else last purchase price' },
    lead: { key: 'leadTime', label: 'Lead (d)', fmt: 'int' }, vendor: { key: 'vendor', label: 'Pref. vendor' },
    cover: { key: 'coverDays', label: 'Cover (d)', fmt: 'int' }, stockValue: { key: 'stockValue', label: 'Stock value', fmt: 'amt', strong: true },
    annual: { key: 'annualValue', label: 'Annual usage value', fmt: 'amt' }, recMax: { key: 'recMax', label: 'Order-up-to', fmt: 'num' },
    excessValue: { key: 'excessValue', label: 'Excess value', fmt: 'amt', strong: true },
    paramStatus: { key: 'paramStatus', label: 'Setting', fmt: 'badge' }, curMin: { key: 'curMin', label: 'SAP min', fmt: 'num' },
    recMin: { key: 'recMin', label: 'Rec. min (ROP)', fmt: 'num', strong: true }, curMax: { key: 'curMax', label: 'SAP max', fmt: 'num' },
    recMaxS: { key: 'recMax', label: 'Rec. max', fmt: 'num', strong: true },
    ss: { key: 'safetyStock', label: 'Safety stock', fmt: 'num' }, ssValue: { key: 'ssValue', label: 'Safety stock value', fmt: 'amt', strong: true, hint: 'Safety stock × unit cost' },
    sigma: { key: 'weeklyStd', label: 'Weekly σ', fmt: 'num' },
  };
  const srcAll = [SRC.oinm, SRC.oitm, ...(warehouse ? [SRC.oitw] : [])];

  // Items analysed
  const noDemand = rows.filter(r => r.status === 'NO DEMAND');
  const classA = rows.filter(r => r.abc === 'A');
  const zItems = rows.filter(r => r.xyz === 'Z');
  const statusCount = STATUS_COLORS.map(([st]) => [st, rows.filter(r => r.status === st).length]).filter(e => e[1]);
  const topAnnual = topBy(withDemand, 'annualValue', 1)[0];

  // Stock value
  const withStock = rows.filter(r => r.onHand > 0);
  const negStock = rows.filter(r => r.onHand < 0);
  const top10Stock = sumOf(topBy(rows, 'stockValue', 10), 'stockValue');
  const tiedUp = sumOf(rows.filter(r => r.status === 'EXCESS' || r.status === 'NO DEMAND'), 'stockValue');
  const grpStockAll = aggBy(rows, r => r.group, r => r.stockValue);
  const grpStock = grpStockAll.slice(0, 10).map(e => e[0]);
  const topStock = topBy(rows, 'stockValue', 1)[0];
  const noDemandValue = sumOf(noDemand, 'stockValue');

  // Reorder / stock-out / order value
  const reorderOnly = reorder.filter(r => r.status === 'REORDER');
  const bigCommit = reorder.filter(r => r.avgDaily > 0 && r.committed > r.avgDaily * 90);
  const reorderOnOrder = reorder.filter(r => r.onOrder > 0);
  const vendAgg = aggBy(reorder, r => r.vendor, r => r.orderValue);
  const vendTop = vendAgg.slice(0, 10).map(e => e[0]);
  const vendLines = v => reorder.filter(r => (r.vendor || '—') === v).length;
  const worstOut = [...stockouts].sort((a, z2) => a.projected - z2.projected);
  const shortSum = sumOf(stockouts, 'projected');
  const outNoPO = stockouts.filter(r => r.onOrder <= 0);
  const outValue = sumOf(stockouts, 'orderValue');
  const reorderValue = sumOf(reorderOnly, 'orderValue');
  const aOrderValue = sumOf(reorder.filter(r => r.abc === 'A'), 'orderValue');
  const top10Order = sumOf(topBy(reorder, 'orderValue', 10), 'orderValue');
  const noVendor = reorder.filter(r => !r.vendor);
  const topOrder = topBy(reorder, 'orderValue', 1)[0];

  // Excess
  const excessOnOrder = excess.filter(r => r.onOrder > 0);
  const excessOnOrderValue = sumOf(excessOnOrder, r => r.onOrder * r.unitCost);
  const grpExcess = aggBy(excess, r => r.group, r => r.excessValue);
  const coverSorted = excess.map(r => r.coverDays).filter(v => v != null).sort((a, z2) => a - z2);
  const medianCover = coverSorted.length ? coverSorted[Math.floor(coverSorted.length / 2)] : 0;

  // Min/Max
  const notSet = params.filter(r => r.paramStatus === 'NOT SET');
  const adjust = params.filter(r => r.paramStatus === 'ADJUST');
  const minNotSet = params.filter(r => r.minGap === 'NOT SET').length, maxNotSet = params.filter(r => r.maxGap === 'NOT SET').length;
  const minTooLow = params.filter(r => r.minGap === 'ADJUST' && r.curMin < r.recMin);
  const minTooHigh = params.filter(r => r.minGap === 'ADJUST' && r.curMin > r.recMin);
  const paramA = params.filter(r => r.abc === 'A');
  const lowRisk = [...minTooLow].sort((a, z2) => 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(z2.abc) || z2.annualValue - a.annualValue)[0];

  // Service level
  const ssRows = rows.filter(r => r.avgDaily > 0).map(r => ({ ...r, ssValue: round(r.safetyStock * r.unitCost) }));
  const ssValue = sumOf(ssRows, 'ssValue');
  const ssAt = zz => round(ssValue * (zz / (z || 1)));
  const z99 = Z.find(e => e[0] === 99)[1], z90 = Z.find(e => e[0] === 90)[1];
  const ssZ = sumOf(ssRows.filter(r => r.xyz === 'Z'), 'ssValue');
  const topSS = topBy(ssRows, 'ssValue', 1)[0];

  return {
    kpis: [
      { label: 'Items analysed', value: rows.length, fmt: 'int', hint: `Stock items with demand or stock${warehouse ? ` in ${warehouse}` : ''}`,
        calc: { formula: `Count of inventory items (OITM InvntItem = Y${warehouse ? `, with a row in OITW for warehouse ${warehouse}` : ''}) that had positive net demand in at least one week since ${from} (${lookback}-day lookback to ${asOf}) or have stock on hand > 0.`,
          steps: ['Only items flagged as inventory items in SAP are loaded.', 'Demand = deliveries + direct A/R invoices + goods issues + production issues − A/R credit memos and returns, netted per week; weeks with net returns count as 0.',
            'Items with neither demand nor positive stock are skipped.', 'ABC = cumulative share of annual usage value (daily demand × 365 × unit cost): A ≤ 80%, B ≤ 95%, C the rest; XYZ = weekly CV < 0.5 / < 1 / ≥ 1.'],
          sources: [SRC.oitm, SRC.oinm, SRC.oitb, ...(warehouse ? [SRC.oitw] : [])],
          rows: topBy(withDemand.length ? withDemand : rows, 'annualValue', 20), sortBy: 'annualValue',
          title: 'Most important items by annual usage value',
          columns: hinted([C.item, C.abc, C.xyz, C.status, C.annual, C.cover]),
          stats: [{ label: 'With demand', value: withDemand.length, fmt: 'int' }, { label: 'No demand (stock only)', value: noDemand.length, fmt: 'int' },
            { label: 'Class A items', value: classA.length, fmt: 'int' }, { label: 'Erratic demand (Z)', value: zItems.length, fmt: 'int' },
            { label: 'Using default lead time', value: defaultLtCount, fmt: 'int' }, { label: 'Annual usage value', value: round(withDemand.length ? totalAnnual : 0), fmt: 'amt' }],
          chart: { title: 'Items by ABC class and stock status', type: 'bar', stacked: true, fmt: 'int', labels: ABC_KEYS.map(([c]) => abcLabel(c)),
            series: STATUS_COLORS.map(([st, color]) => ({ name: st, color, values: ABC_KEYS.map(([c]) => rows.filter(r => r.abc === c && r.status === st).length) })) },
          insight: `**${rows.length} items analysed: ${withDemand.length} moved in the last ${lookback} days, ${noDemand.length} hold stock with no demand.**\n\n` +
            (classA.length ? `- ${classA.length} class A items (${pctOf(classA.length, rows.length)}% of items) carry ~80% of the ${fmtAmt(totalAnnual)} annual usage value${topAnnual ? `; the largest is ${nm(topAnnual)} at ${fmtAmt(topAnnual.annualValue)}/year` : ''}.\n` : '') +
            (statusCount.length ? `- Status mix: ${statusCount.map(([st, n]) => `${st} ${n}`).join(', ')}.\n` : '') +
            (zItems.length ? `- ${zItems.length} items have erratic demand (Z, CV ≥ 1) — their safety stock is the least reliable; review them with sales before relying on the reorder points.\n` : '') +
            (defaultLtCount ? `- ${defaultLtCount} items with demand have no lead time in OITM (${defaultLT} days assumed) — fill in OITM lead times first, as every reorder point depends on it.` : '') } },

      { label: 'Stock value', value: stockValue, fmt: 'amt', hint: 'On hand × unit cost',
        calc: { formula: `Σ on-hand quantity × unit cost over all analysed items; unit cost = ${warehouse ? `warehouse ${warehouse} average price (OITW), else ` : ''}item average price, else last purchase price.`,
          steps: [warehouse ? `On-hand quantities of warehouse ${warehouse} (OITW).` : 'On-hand quantities across all warehouses (OITM).', 'Quantities are the current SAP figures, not a snapshot at the as-of date.',
            'Negative on-hand (allowed in some setups) reduces the total.', 'The chart splits the value by item group and ABC class.'],
          sources: [SRC.oitm, SRC.oitb, ...(warehouse ? [SRC.oitw] : [])],
          rows: topBy(rows, 'stockValue', 20), sortBy: 'stockValue', title: 'Largest stock holdings',
          columns: hinted([C.item, C.status, C.onHand, C.unitCost, C.stockValue, C.cover]),
          stats: [{ label: 'Items with stock', value: withStock.length, fmt: 'int' }, { label: 'Top-10 items share', value: pctOf(top10Stock, stockValue), fmt: 'pct' },
            { label: 'In EXCESS / NO DEMAND items', value: round(tiedUp), fmt: 'amt' }, { label: 'Class A items', value: round(sumOf(classA, 'stockValue')), fmt: 'amt' },
            { label: 'In REORDER / STOCKOUT items', value: round(sumOf(reorder, 'stockValue')), fmt: 'amt' }, { label: 'Items with negative stock', value: negStock.length, fmt: 'int' }],
          chart: grpStock.length ? { title: 'Stock value by item group (top 10), split by ABC class', type: 'bar', horizontal: true, stacked: true, fmt: 'amt', labels: grpStock,
            series: ABC_KEYS.map(([c, color]) => ({ name: abcLabel(c), color, values: grpStock.map(g => round(sumOf(rows.filter(r => (r.group || '—') === g && r.abc === c), 'stockValue'))) })) } : null,
          insight: `**Stock on hand is worth ${fmtAmt(stockValue)}; ${pctOf(tiedUp, stockValue)}% (${fmtAmt(tiedUp)}) sits in items with excess or no demand.**\n\n` +
            (topStock ? `- Largest holding: ${nm(topStock)} — ${fmtAmt(topStock.stockValue)} (${topStock.status}${topStock.coverDays != null ? `, ${topStock.coverDays} days of cover` : ''}); the top 10 items hold ${pctOf(top10Stock, stockValue)}%.\n` : '') +
            (grpStockAll[0] ? `- Largest group: **${grpStockAll[0][0]}** at ${fmtAmt(grpStockAll[0][1])} (${pctOf(grpStockAll[0][1], stockValue)}%).\n` : '') +
            (noDemandValue ? `- ${noDemand.length} items with no demand in ${lookback} days hold ${fmtAmt(noDemandValue)} — move them to the Dead Stock agent for liquidation or write-down.\n` : '') +
            (negStock.length ? `- ${negStock.length} items show negative stock — post the missing receipts so values and reorder points are correct.` : '') } },

      { label: 'Reorder now', value: reorder.length, fmt: 'int', tone: reorder.length ? 'warn' : 'good', hint: 'Projected stock at or below the reorder point',
        calc: { formula: `Count of items with demand whose projected stock (on hand − committed + on order) is at or below the reorder point (daily demand × lead time + safety stock at ${serviceLevel}% service); includes the stock-out risk items (projected ≤ 0).`,
          steps: methodSteps, sources: srcAll, tab: 'reorder', sortBy: 'orderValue', title: 'Items to order now — largest order value first',
          columns: hinted([C.item, C.status, C.projected, C.rop, C.qty, C.orderValue]),
          stats: [{ label: 'Stock-out risk', value: stockouts.length, fmt: 'int' }, { label: 'At/below reorder point', value: reorderOnly.length, fmt: 'int' },
            { label: 'Class A items', value: reorder.filter(r => r.abc === 'A').length, fmt: 'int' }, { label: 'Already partly on order', value: reorderOnOrder.length, fmt: 'int' },
            { label: 'Committed > 90 days of demand', value: bigCommit.length, fmt: 'int' }, { label: 'Order value', value: round(orderValue), fmt: 'amt' }],
          chart: reorder.length ? { title: 'Items to reorder by ABC class', type: 'bar', stacked: true, fmt: 'int', labels: ABC_KEYS.map(([c]) => abcLabel(c)),
            series: [{ name: 'Stock-out risk', color: '#DC2626', values: ABC_KEYS.map(([c]) => stockouts.filter(r => r.abc === c).length) },
              { name: 'At/below reorder point', color: '#F59E0B', values: ABC_KEYS.map(([c]) => reorderOnly.filter(r => r.abc === c).length) }] } : null,
          insight: reorder.length
            ? `**${reorder.length} items are at or below their reorder point (${stockouts.length} already short after commitments); ordering ~${fmtAmt(orderValue)} restores the order-up-to levels.**\n\n` +
              `- Most urgent: ${nm(reorder[0])} (class ${reorder[0].abc}, ${reorder[0].status}) — projected ${reorder[0].projected} vs reorder point ${reorder[0].reorderPoint}; order ${reorder[0].suggestQty}${reorder[0].vendor ? ` from ${reorder[0].vendor}` : ''}.\n` +
              `- ${reorder.filter(r => r.abc === 'A').length} are class A items worth ${fmtAmt(aOrderValue)} of the proposal — release these purchase orders first.\n` +
              (vendAgg[0] ? `- Largest supplier: **${vendLabel(vendAgg[0][0])}** — ${vendLines(vendAgg[0][0])} lines, ${fmtAmt(vendAgg[0][1])}; consolidate into one PO.\n` : '') +
              (bigCommit.length ? `- ${bigCommit.length} items have committed quantities above 90 days of normal demand (e.g. ${nm(bigCommit[0])}) — verify those sales orders before buying.` : '')
            : `**No item is at or below its reorder point — current stock plus open orders covers lead-time demand at ${serviceLevel}% service.**` } },

      { label: 'Stock-out risk', value: stockouts.length, fmt: 'int', tone: stockouts.length ? 'bad' : 'good', hint: 'Projected stock ≤ 0 after commitments',
        calc: { formula: 'Count of items with demand whose projected stock (on hand − committed + on order) is zero or negative.',
          steps: ['Projected = on hand − committed (open sales orders) + on order (open purchase / production orders).', 'These items cannot cover their open sales orders even after open purchase orders arrive.',
            'Order qty = order-up-to − projected, so it covers the shortfall plus the reorder point and review period.', 'Check large committed quantities — they may be old or duplicate sales orders.'],
          sources: srcAll, tab: 'reorder', filter: r => r.status === 'STOCKOUT RISK', sortBy: 'projected', title: 'Items short after commitments — largest shortfall first',
          columns: hinted([C.item, C.abc, C.onHand, C.committed, C.onOrder, C.projected]),
          stats: [{ label: 'Items', value: stockouts.length, fmt: 'int' }, { label: 'Class A items', value: stockouts.filter(r => r.abc === 'A').length, fmt: 'int' },
            { label: 'Shortfall qty (Σ projected)', value: q2(shortSum), fmt: 'num' }, { label: 'Nothing on order', value: outNoPO.length, fmt: 'int' },
            { label: 'Avg lead time (days)', value: stockouts.length ? round(sumOf(stockouts, 'leadTime') / stockouts.length, 1) : 0, fmt: 'num' },
            { label: 'Order value to fix', value: round(outValue), fmt: 'amt' }],
          chart: worstOut.length ? { title: 'Supply vs commitments — 10 largest shortfalls', type: 'bar', horizontal: true, fmt: 'num', labels: worstOut.slice(0, 10).map(r => r.itemCode),
            series: [{ name: 'On hand', color: '#16A34A', values: worstOut.slice(0, 10).map(r => r.onHand) }, { name: 'On order', color: '#2563EB', values: worstOut.slice(0, 10).map(r => r.onOrder) },
              { name: 'Committed', color: '#DC2626', values: worstOut.slice(0, 10).map(r => r.committed) }] } : null,
          insight: stockouts.length
            ? `**${stockouts.length} items will run short: commitments exceed on hand + on order by ${q2(-shortSum)} units in total; ~${fmtAmt(outValue)} of purchases fixes them.**\n\n` +
              `- Largest shortfall: ${nm(worstOut[0])} (class ${worstOut[0].abc}) — on hand ${worstOut[0].onHand}, on order ${worstOut[0].onOrder}, committed ${worstOut[0].committed} → projected ${worstOut[0].projected}; order ${worstOut[0].suggestQty}${worstOut[0].vendor ? ` from ${worstOut[0].vendor}` : ''}.\n` +
              (outNoPO.length ? `- ${outNoPO.length} of them have nothing on order at all — raise purchase / production orders today (avg lead time ${round(sumOf(outNoPO, 'leadTime') / outNoPO.length, 1)} days).\n` : '- All of them already have something on order — expedite those orders.\n') +
              `- ${stockouts.filter(r => r.abc === 'A').length} are class A items; tell sales which open orders will ship late.`
            : '**No item is projected to run out — on hand plus open orders covers every open commitment.**' } },

      { label: 'Suggested order value', value: orderValue, fmt: 'amt', hint: 'Value of the order quantities proposed now',
        calc: { formula: `Σ (order-up-to − projected stock) × unit cost over the items to reorder; order-up-to = reorder point + daily demand × ${reviewDays} review days; unit cost = average cost, else last purchase price.`,
          steps: methodSteps, sources: srcAll, tab: 'reorder', sortBy: 'orderValue', title: 'Purchase proposal — largest order values',
          columns: hinted([C.item, C.vendor, C.qty, C.unitCost, C.orderValue, C.lead]),
          stats: [{ label: 'For stock-out risk items', value: round(outValue), fmt: 'amt' }, { label: 'For reorder items', value: round(reorderValue), fmt: 'amt' },
            { label: 'Class A share', value: pctOf(aOrderValue, orderValue), fmt: 'pct' }, { label: 'Lines', value: reorder.length, fmt: 'int' },
            { label: 'Vendors', value: vendAgg.filter(e => e[0] !== '—').length, fmt: 'int' }, { label: 'Lines without pref. vendor', value: noVendor.length, fmt: 'int' }],
          chart: vendTop.length ? { title: 'Proposed order value by preferred vendor (top 10)', type: 'bar', horizontal: true, stacked: true, fmt: 'amt', labels: vendTop.map(vendLabel),
            series: [['STOCKOUT RISK', 'Stock-out risk', '#DC2626'], ['REORDER', 'Reorder', '#F59E0B']].map(([st, name, color]) => ({ name, color,
              values: vendTop.map(v => round(sumOf(reorder.filter(r => (r.vendor || '—') === v && r.status === st), 'orderValue'))) })) } : null,
          insight: reorder.length
            ? `**Proposed purchases total ${fmtAmt(orderValue)} across ${reorder.length} lines; ${pctOf(outValue, orderValue)}% is for items already at stock-out risk.**\n\n` +
              (topOrder ? `- Largest line: ${nm(topOrder)} — ${topOrder.suggestQty} × ${topOrder.unitCost} = ${fmtAmt(topOrder.orderValue)}${topOrder.vendor ? ` (${topOrder.vendor})` : ''}; the top 10 lines are ${pctOf(top10Order, orderValue)}% of the value.\n` : '') +
              (vendAgg[0] ? `- By vendor: ${vendAgg.slice(0, 3).map(([v, val]) => `**${vendLabel(v)}** ${fmtAmt(val)}`).join(', ')}.\n` : '') +
              (noVendor.length ? `- ${noVendor.length} lines have no preferred vendor in OITM — assign one so the proposal can be turned into purchase orders.` : `- Convert the proposal into purchase orders per vendor, class A and stock-out lines first.`)
            : '**Nothing to order now — no item is at or below its reorder point.**' } },

      { label: 'Excess stock value', value: excessValue, fmt: 'amt', tone: excessValue ? 'warn' : 'good', hint: 'Value of stock above the order-up-to level',
        calc: { formula: 'Σ (on hand − order-up-to) × unit cost for items with demand whose projected stock is above the reorder point, on hand > 1.5 × order-up-to and the surplus (on hand − order-up-to) exceeds 30 days of demand.',
          steps: ['Items with no demand at all are excluded here (see the Dead Stock agent).', 'Cover = on hand ÷ daily demand.', 'Pause purchasing of these items until stock returns to the order-up-to level.'],
          sources: srcAll, tab: 'excess', sortBy: 'excessValue', title: 'Largest excess positions',
          columns: hinted([C.item, C.onHand, C.recMax, C.cover, C.excessValue, C.onOrder]),
          stats: [{ label: 'Items in excess', value: excess.length, fmt: 'int' }, { label: 'Their total stock value', value: valOf(excess), fmt: 'amt' },
            { label: 'Share of stock value', value: pctOf(excessValue, stockValue), fmt: 'pct' }, { label: 'Median cover (days)', value: medianCover, fmt: 'int' },
            { label: 'Still on order for them', value: excessOnOrder.length, fmt: 'int' }, { label: 'Value still on order', value: round(excessOnOrderValue), fmt: 'amt' }],
          chart: grpExcess.length ? { title: 'Excess value by item group (top 10)', type: 'bar', horizontal: true, fmt: 'amt', labels: grpExcess.slice(0, 10).map(e => e[0]),
            series: [{ name: 'Excess value', color: '#7C3AED', values: grpExcess.slice(0, 10).map(e => round(e[1])) }] } : null,
          insight: excess.length
            ? `**${fmtAmt(excessValue)} (${pctOf(excessValue, stockValue)}% of stock value) is tied up above order-up-to levels in ${excess.length} items; median cover is ${medianCover} days.**\n\n` +
              `- Largest: ${nm(excess[0])} — ${excess[0].onHand} on hand vs order-up-to ${excess[0].recMax}, ${excess[0].coverDays} days of cover, ${fmtAmt(excess[0].excessValue)} excess.\n` +
              (grpExcess[0] ? `- Concentrated in group **${grpExcess[0][0]}** (${fmtAmt(grpExcess[0][1])}, ${pctOf(grpExcess[0][1], excessValue)}% of the excess).\n` : '') +
              (excessOnOrder.length ? `- ${excessOnOrder.length} of these items still have ${fmtAmt(excessOnOrderValue)} on open orders (e.g. ${nm(excessOnOrder[0])}) — cancel or postpone those POs.` : '- None of them has open purchase orders — stop new buying and push sales or transfers to use the surplus.')
            : '**No item holds excess stock — on hand is within 1.5 × order-up-to (or within 30 days of demand) for every item with demand.**' } },

      { label: 'Min/Max to update', value: params.length, fmt: 'int', tone: params.length ? 'warn' : 'good', hint: 'SAP Min/Max missing or > 25% off',
        calc: { formula: `Count of items with demand whose SAP minimum or maximum stock (${warehouse ? `OITW MinStock/MaxStock for ${warehouse}` : 'OITM MinLevel/MaxLevel'}) is not set (0), or differs by more than 25% from the recommended reorder point / order-up-to level.`,
          steps: ['Recommended min = reorder point; recommended max = order-up-to level.', 'NOT SET wins over ADJUST when one value is missing and the other is off.',
            `Update ${warehouse ? 'OITW' : 'OITM'} Min and Max so SAP MRP and alerts use realistic levels.`],
          sources: [SRC.oitm, SRC.oinm, ...(warehouse ? [SRC.oitw] : [])], tab: 'params', sortBy: 'annualValue', title: 'Settings to change — most valuable items first',
          columns: hinted([C.item, C.paramStatus, C.curMin, C.recMin, C.curMax, C.recMaxS]),
          stats: [{ label: 'Not set', value: notSet.length, fmt: 'int' }, { label: 'Adjust', value: adjust.length, fmt: 'int' },
            { label: 'Class A items', value: paramA.length, fmt: 'int' }, { label: 'Min not set', value: minNotSet, fmt: 'int' },
            { label: 'Max not set', value: maxNotSet, fmt: 'int' }, { label: 'SAP min too low (> 25%)', value: minTooLow.length, fmt: 'int' }],
          chart: params.length ? { title: 'Min/Max issues by ABC class', type: 'bar', stacked: true, fmt: 'int', labels: ABC_KEYS.map(([c]) => abcLabel(c)),
            series: [{ name: 'NOT SET', color: '#DC2626', values: ABC_KEYS.map(([c]) => notSet.filter(r => r.abc === c).length) },
              { name: 'ADJUST', color: '#F59E0B', values: ABC_KEYS.map(([c]) => adjust.filter(r => r.abc === c).length) }] } : null,
          insight: params.length
            ? `**${params.length} items need new Min/Max settings in SAP: ${notSet.length} not set, ${adjust.length} more than 25% off the recommendation.**\n\n` +
              `- Most valuable: ${nm(params[0])} (class ${params[0].abc}) — SAP min ${params[0].curMin} vs recommended ${params[0].recMin}, SAP max ${params[0].curMax} vs ${params[0].recMax}.\n` +
              (minTooLow.length ? `- ${minTooLow.length} items have SAP min too low — MRP will trigger too late${lowRisk ? ` (e.g. ${nm(lowRisk)}: ${lowRisk.curMin} vs ${lowRisk.recMin})` : ''}; ${minTooHigh.length} have it too high and tie up stock.\n` : (minTooHigh.length ? `- ${minTooHigh.length} items have SAP min too high and tie up stock.\n` : '')) +
              `- Start with the ${paramA.length} class A items; update ${warehouse ? 'OITW' : 'OITM'} Min/Max from the Rec. columns.`
            : '**All SAP Min/Max settings are within 25% of the recommended levels.**' } },

      { label: 'Service level', value: serviceLevel, fmt: 'pct', hint: `Target chance of no stock-out (z = ${z})`,
        calc: { formula: `Target service level ${serviceLevel}% → safety factor z = ${z} (nearest level in the z table); safety stock = z × weekly σ × √(lead time in days ÷ 7).`,
          steps: ['Weekly σ = standard deviation of the weekly net demand over the lookback (weeks with net returns count as 0).', 'Safety stock value = safety stock × unit cost; it scales linearly with z.',
            'A higher service level means more safety stock and fewer stock-outs, but more capital tied up.', 'Change it in the options above and re-run.'],
          sources: [SRC.oinm, SRC.oitm], rows: topBy(ssRows, 'ssValue', 20), sortBy: 'ssValue', title: 'Largest safety stock buffers',
          columns: hinted([C.item, C.xyz, C.sigma, C.lead, C.ss, C.ssValue]),
          stats: [{ label: 'z factor', value: z, fmt: 'num' }, { label: 'Safety stock value', value: round(ssValue), fmt: 'amt' },
            { label: 'Share of stock value', value: pctOf(ssValue, stockValue), fmt: 'pct' }, { label: 'Lookback days', value: lookback, fmt: 'int' },
            { label: 'Review period (days)', value: reviewDays, fmt: 'int' }, { label: 'Of which erratic (Z) items', value: round(ssZ), fmt: 'amt' }],
          chart: ssValue ? { title: 'Safety stock value at other service levels', type: 'bar', fmt: 'amt', labels: Z.map(([sl]) => `${sl}%`),
            series: [{ name: 'Safety stock value', values: Z.map(([, zz]) => ssAt(zz)) }] } : null,
          insight: ssValue
            ? `**At ${serviceLevel}% service (z = ${z}) safety stock is worth ${fmtAmt(ssValue)}, ${pctOf(ssValue, stockValue)}% of stock value.**\n\n` +
              `- Raising to 99% (z = ${z99}) would need ${fmtAmt(ssAt(z99))} (${ssAt(z99) >= ssValue ? '+' : ''}${fmtAmt(ssAt(z99) - ssValue)}); lowering to 90% (z = ${z90}) needs ${fmtAmt(ssAt(z90))}.\n` +
              (topSS ? `- Largest buffer: ${nm(topSS)} — ${topSS.safetyStock} units (${fmtAmt(topSS.ssValue)}), weekly σ ${topSS.weeklyStd}, lead time ${topSS.leadTime} days.\n` : '') +
              (ssZ ? `- ${pctOf(ssZ, ssValue)}% of the buffer sits in erratic (Z) items — consider a lower service level or make-to-order for those instead of more stock.` : '')
            : `**Service level ${serviceLevel}% (z = ${z}); no safety stock is needed because no item shows demand variation.**` } },
    ],
    chart: { title: 'Stock value by status', type: 'bar', labels: byStatus.map(b => b.status),
      desc: 'Each bar is the value of stock on hand for items in that status — big EXCESS / NO DEMAND bars mean capital tied up, STOCKOUT RISK / REORDER bars show items running low.',
      series: [{ name: 'Stock value', values: byStatus.map(b => b.stockValue) }] },
    tabs: [
      { key: 'reorder', label: `Reorder now (${reorder.length})`, rows: withExplain(reorder, ['status', 'projected', 'reorderPoint:recMin', 'recMax', 'suggestQty', 'orderValue', 'abc', 'xyz']),
        desc: 'Items to order now — stock-out risks first, then by ABC class and order value; use Order qty as the purchase proposal.',
        columns: hinted([{ key: 'status', label: 'Status', fmt: 'badge' }, ...idCols,
          { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'committed', label: 'Committed', fmt: 'num' }, { key: 'onOrder', label: 'On order', fmt: 'num' },
          { key: 'projected', label: 'Projected', fmt: 'num' }, { key: 'reorderPoint', label: 'Reorder pt', fmt: 'num' }, { key: 'recMax', label: 'Order-up-to', fmt: 'num' },
          { key: 'suggestQty', label: 'Order qty', fmt: 'num', strong: true }, { key: 'orderValue', label: 'Value', fmt: 'amt' },
          { key: 'leadTime', label: 'Lead (d)', fmt: 'int' }, { key: 'vendor', label: 'Pref. vendor' }]) },
      { key: 'excess', label: `Excess (${excess.length})`, rows: withExplain(excess, ['coverDays', 'recMax', 'excessQty', 'excessValue']),
        desc: 'Items holding far more stock than needed, largest excess value first — pause purchasing or push sales of these.',
        columns: hinted([...idCols, { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'avgDaily', label: 'Daily demand', fmt: 'num' },
          { key: 'coverDays', label: 'Cover (days)', fmt: 'int' }, { key: 'recMax', label: 'Rec. max', fmt: 'num' },
          { key: 'excessQty', label: 'Excess qty', fmt: 'num' }, { key: 'excessValue', label: 'Excess value', fmt: 'amt', strong: true },
          { key: 'onOrder', label: 'On order', fmt: 'num' }, { key: 'action', label: 'Action', wrap: true }]) },
      { key: 'params', label: `Min/Max changes (${params.length})`, rows: withExplain(params, ['paramStatus', 'recMin', 'recMax', 'safetyStock']),
        desc: 'Items whose SAP Min/Max stock settings are missing or more than 25% off the recommendation — update them in the item master.',
        columns: hinted([...idCols, { key: 'paramStatus', label: 'Setting', fmt: 'badge' },
          { key: 'curMin', label: 'SAP min', fmt: 'num' }, { key: 'recMin', label: 'Rec. min (ROP)', fmt: 'num', strong: true },
          { key: 'curMax', label: 'SAP max', fmt: 'num' }, { key: 'recMax', label: 'Rec. max', fmt: 'num', strong: true },
          { key: 'safetyStock', label: 'Safety stock', fmt: 'num' }, { key: 'avgWeekly', label: 'Avg weekly', fmt: 'num' },
          { key: 'weeklyStd', label: 'Weekly σ', fmt: 'num' }, { key: 'leadTime', label: 'Lead (d)', fmt: 'int', sub: 'leadTimeSource', hint: `${H.leadTime}; the sub-line says whether it came from the item or the default` }]) },
      { key: 'all', label: `All items (${rows.length})`, rows: withExplain([...rows].sort((a, z2) => z2.annualValue - a.annualValue), ['status', 'reorderPoint']),
        desc: 'Every analysed item with its status and recommended levels, sorted by annual usage value (most important first).',
        columns: hinted([{ key: 'status', label: 'Status', fmt: 'badge' }, ...idCols, { key: 'group', label: 'Group' },
          { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'avgDaily', label: 'Daily demand', fmt: 'num' }, { key: 'coverDays', label: 'Cover (d)', fmt: 'int' },
          { key: 'safetyStock', label: 'SS', fmt: 'num' }, { key: 'reorderPoint', label: 'ROP', fmt: 'num' }, { key: 'recMax', label: 'Max', fmt: 'num' },
          { key: 'annualValue', label: 'Annual usage value', fmt: 'amt' }, { key: 'stockValue', label: 'Stock value', fmt: 'amt' }]) },
    ],
    notes: [
      `Demand = deliveries + direct A/R invoices + goods issues (incl. production consumption) − returns/credit memos, over ${lookback} days${warehouse ? ` in ${warehouse}` : ''}, bucketed weekly. z = ${z} for ${serviceLevel}% service.`,
      `Projected = on hand − committed + on order. Lead time from the item master, else ${defaultLT} days. ABC by annual usage value (80/15/5%), XYZ by weekly coefficient of variation (<0.5 / <1 / ≥1).`,
    ],
    insight, aiContext,
  };
}

export function createInventoryOptimizationAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'invopt', title: 'Inventory Optimization Agent',
    defaults: { lookbackDays: 180, serviceLevel: 95, reviewDays: 14, defaultLeadTime: 14 },
    persona: 'You are an inventory planner optimising stock levels in SAP Business One.',
    aiTask: 'Review this inventory optimisation. Prioritise what to order now, where capital is tied up in excess, and which Min/Max/safety stock settings to change in SAP, with item codes and quantities.',
    run,
  });
}
