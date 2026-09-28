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
  const moves = await loadDemandMovements(k, from, { warehouse });

  const W = Math.ceil(lookback / 7);
  const series = new Map();
  for (const m of moves) {
    if (!series.has(m.itemCode)) series.set(m.itemCode, new Array(W).fill(0));
    const idx = clamp(Math.floor(daysBetween(from, m.date) / 7), 0, W - 1);
    series.get(m.itemCode)[idx] += m.qty;
  }

  const rows = [];
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

    rows.push({
      itemCode: it.itemCode, itemName: it.itemName, group: it.group, status, action,
      onHand: round(onHand, 2), committed: round(committed, 2), onOrder: round(onOrder, 2), projected: round(projected, 2),
      avgDaily: round(d, 3), avgWeekly: round(muW, 2), weeklyStd: round(sigW, 2), activeWeeks,
      cv: muW > 0 ? round(sigW / muW, 2) : null, leadTime: lt, leadTimeSource: it.leadTime > 0 ? 'item' : 'default',
      safetyStock: round(ss, 2), reorderPoint: round(rop, 2), recMin: round(rop, 2), recMax: round(max, 2),
      curMin: round(curMin, 2), curMax: round(curMax, 2), minGap, maxGap,
      paramStatus: minGap === 'OK' && maxGap === 'OK' ? 'OK' : minGap === 'NOT SET' || maxGap === 'NOT SET' ? 'NOT SET' : 'ADJUST',
      suggestQty: round(suggestQty, 2), orderValue: round(suggestQty * cost), excessQty: round(excessQty, 2),
      excessValue: round(excessQty * cost), unitCost: round(cost, 2), stockValue: round(onHand * cost),
      annualValue: d * 365 * cost, coverDays: coverDays != null ? Math.round(coverDays) : null, vendor: it.prefVendor,
    });
  }

  // ABC by annual consumption value, XYZ by demand variability.
  const withDemand = rows.filter(r => r.avgDaily > 0).sort((a, z2) => z2.annualValue - a.annualValue);
  const totalAnnual = withDemand.reduce((s, r) => s + r.annualValue, 0) || 1;
  let cum = 0;
  for (const r of withDemand) { cum += r.annualValue; r.abc = cum / totalAnnual <= 0.8 ? 'A' : cum / totalAnnual <= 0.95 ? 'B' : 'C'; }
  for (const r of rows) {
    r.abc = r.abc || '—';
    r.xyz = r.cv == null ? '—' : r.cv < 0.5 ? 'X' : r.cv < 1 ? 'Y' : 'Z';
    r.annualValue = round(r.annualValue);
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

  const idCols = [{ key: 'itemCode', label: 'Item', sub: 'itemName' },
    { key: 'abc', label: 'ABC', fmt: 'badge', badge: { A: 'purple', B: 'blue', C: 'grey' } },
    { key: 'xyz', label: 'XYZ', fmt: 'badge', badge: { X: 'green', Y: 'amber', Z: 'red' } }];
  return {
    kpis: [
      { label: 'Items analysed', value: rows.length, fmt: 'int' },
      { label: 'Stock value', value: stockValue, fmt: 'amt' },
      { label: 'Reorder now', value: reorder.length, fmt: 'int', tone: reorder.length ? 'warn' : 'good' },
      { label: 'Stock-out risk', value: stockouts.length, fmt: 'int', tone: stockouts.length ? 'bad' : 'good' },
      { label: 'Suggested order value', value: orderValue, fmt: 'amt' },
      { label: 'Excess stock value', value: excessValue, fmt: 'amt', tone: excessValue ? 'warn' : 'good' },
      { label: 'Min/Max to update', value: params.length, fmt: 'int', tone: params.length ? 'warn' : 'good' },
      { label: 'Service level', value: serviceLevel, fmt: 'pct' },
    ],
    chart: { title: 'Stock value by status', type: 'bar', labels: byStatus.map(b => b.status),
      series: [{ name: 'Stock value', values: byStatus.map(b => b.stockValue) }] },
    tabs: [
      { key: 'reorder', label: `Reorder now (${reorder.length})`, rows: reorder,
        columns: [{ key: 'status', label: 'Status', fmt: 'badge' }, ...idCols,
          { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'committed', label: 'Committed', fmt: 'num' }, { key: 'onOrder', label: 'On order', fmt: 'num' },
          { key: 'projected', label: 'Projected', fmt: 'num' }, { key: 'reorderPoint', label: 'Reorder pt', fmt: 'num' }, { key: 'recMax', label: 'Order-up-to', fmt: 'num' },
          { key: 'suggestQty', label: 'Order qty', fmt: 'num', strong: true }, { key: 'orderValue', label: 'Value', fmt: 'amt' },
          { key: 'leadTime', label: 'Lead (d)', fmt: 'int' }, { key: 'vendor', label: 'Pref. vendor' }] },
      { key: 'excess', label: `Excess (${excess.length})`, rows: excess,
        columns: [...idCols, { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'avgDaily', label: 'Daily demand', fmt: 'num' },
          { key: 'coverDays', label: 'Cover (days)', fmt: 'int' }, { key: 'recMax', label: 'Rec. max', fmt: 'num' },
          { key: 'excessQty', label: 'Excess qty', fmt: 'num' }, { key: 'excessValue', label: 'Excess value', fmt: 'amt', strong: true },
          { key: 'onOrder', label: 'On order', fmt: 'num' }, { key: 'action', label: 'Action', wrap: true }] },
      { key: 'params', label: `Min/Max changes (${params.length})`, rows: params,
        columns: [...idCols, { key: 'paramStatus', label: 'Setting', fmt: 'badge' },
          { key: 'curMin', label: 'SAP min', fmt: 'num' }, { key: 'recMin', label: 'Rec. min (ROP)', fmt: 'num', strong: true },
          { key: 'curMax', label: 'SAP max', fmt: 'num' }, { key: 'recMax', label: 'Rec. max', fmt: 'num', strong: true },
          { key: 'safetyStock', label: 'Safety stock', fmt: 'num' }, { key: 'avgWeekly', label: 'Avg weekly', fmt: 'num' },
          { key: 'weeklyStd', label: 'Weekly σ', fmt: 'num' }, { key: 'leadTime', label: 'Lead (d)', fmt: 'int', sub: 'leadTimeSource' }] },
      { key: 'all', label: `All items (${rows.length})`, rows: [...rows].sort((a, z2) => z2.annualValue - a.annualValue),
        columns: [{ key: 'status', label: 'Status', fmt: 'badge' }, ...idCols, { key: 'group', label: 'Group' },
          { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'avgDaily', label: 'Daily demand', fmt: 'num' }, { key: 'coverDays', label: 'Cover (d)', fmt: 'int' },
          { key: 'safetyStock', label: 'SS', fmt: 'num' }, { key: 'reorderPoint', label: 'ROP', fmt: 'num' }, { key: 'recMax', label: 'Max', fmt: 'num' },
          { key: 'annualValue', label: 'Annual usage value', fmt: 'amt' }, { key: 'stockValue', label: 'Stock value', fmt: 'amt' }] },
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
