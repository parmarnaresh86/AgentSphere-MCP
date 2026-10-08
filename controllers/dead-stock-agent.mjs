/**
 * Dead Stock Agent — mounted at /api/dead-stock-agent
 *
 * For every item/warehouse holding stock, finds the last sale (OINM), sales
 * velocity here and in other warehouses, cover, stock value and open POs, then
 * classifies DEAD / SLOW and recommends one disposition:
 *   FREEZE PURCHASE → open POs still coming in for stock that isn't selling
 *   TRANSFER        → the same item sells in another warehouse
 *   PROMOTION       → slow but still selling; discount to clear
 *   LIQUIDATE       → not used in over a year (or never); clear / write down
 *   CONSUME         → non-sales (raw/packing) item: use up in production first
 */
import { createInsightRouter, ctxTable, daysBetween, num, round, clamp, fmtAmt } from '../lib/insight-kit.mjs';
import { loadItems, loadWarehouseStock, loadLastMovements, loadDemandMovements, loadOpenPoQtyByItem, since } from '../lib/insight-data.mjs';

// KPI drill-through (calc blocks → lib/insight-kit.mjs withKpiDetails).
const SRC = {
  oitw: 'OITW — stock per warehouse: quantity in stock, average cost',
  oitm: 'OITM — item master: description, group, sales/purchase item flags, average & last purchase price',
  oinm: 'OINM — inventory transactions: last delivery / invoice / goods issue date and quantities used per warehouse',
  opor: 'OPOR + POR1 — open purchase orders: open quantity per item',
  oitb: 'OITB — item groups',
};
const AGE_BANDS =['0-90d', '91-180d', '181-365d', '>365d', 'Never used'];
// Decision table for the explain popup; `hit` only on the rule that applied (keeps JSON small).
const rulesHit = (list, hitIdx) => list.map(([rule, result], i) => (i === hitIdx ? { rule, result, hit: true } : { rule, result }));
const ageBand = d => (d == null ? 'Never used' : d <= 90 ? '0-90d' : d <= 180 ? '91-180d' : d <= 365 ? '181-365d' : '>365d');

async function run(k, p) {
  const asOf = p.asOf;
  const slowDays = clamp(Math.round(num(p.slowDays) || 90), 14, 720);
  const deadDays = clamp(Math.round(num(p.deadDays) || 180), slowDays + 1, 1500);
  const warehouse = String(p.warehouse || '').trim();
  const minValue = num(p.minValue);

  const items = await loadItems(k);
  const stock = await loadWarehouseStock(k, { onlyPositive: true });
  const last = await loadLastMovements(k, { until: asOf });
  const moves = await loadDemandMovements(k, since(asOf, 365), { byWarehouse: true, until: asOf });
  const openPo = await loadOpenPoQtyByItem(k);

  const d90 = since(asOf, 90);
  const sold = new Map();   // item → Map(whs → {s365, s90})
  const usageMix = new Map(); // item → { sale, issue } qty over 12 months, all warehouses
  for (const m of moves) {
    const u = usageMix.get(m.itemCode) || { sale: 0, issue: 0 };
    u[m.kind] += Math.max(0, m.qty);
    usageMix.set(m.itemCode, u);
    if (!sold.has(m.itemCode)) sold.set(m.itemCode, new Map());
    const w = sold.get(m.itemCode);
    const e = w.get(m.whsCode) || { s365: 0, s90: 0 };
    e.s365 += m.qty;
    if (m.date >= d90) e.s90 += m.qty;
    w.set(m.whsCode, e);
  }

  // Consumption item = not a sales item, or mostly goods-issued rather than
  // sold over the last 12 months (falls back to "never sold" with no usage).
  const isConsumable = (code, it) => {
    if (!it.sellable) return true;
    const u = usageMix.get(code);
    if (u && u.sale + u.issue > 0) return u.issue > u.sale;
    return !last.soldItems.has(code);
  };

  const rows = [];
  for (const s of stock) {
    if (warehouse && s.whsCode !== warehouse) continue;
    const it = items.get(s.itemCode);
    if (!it) continue;
    const lastSale = last.lastUse.get(last.key(s.itemCode, s.whsCode)) || null;
    const lastMove = last.lastMove.get(last.key(s.itemCode, s.whsCode)) || null;
    const daysSinceSale = lastSale ? daysBetween(lastSale, asOf) : null;
    const whsSales = sold.get(s.itemCode) || new Map();
    const here = whsSales.get(s.whsCode) || { s365: 0, s90: 0 };
    const monthly = Math.max(0, here.s365) / 12;
    const coverMonths = monthly > 0 ? s.onHand / monthly : null;
    const unitCost = s.avgPrice || it.avgPrice || it.lastPurPrice;
    const value = s.onHand * unitCost;
    if (value < minValue) continue;

    const dead = daysSinceSale == null || daysSinceSale >= deadDays;
    const slow = !dead && (daysSinceSale >= slowDays || (coverMonths != null && coverMonths > 12));
    if (!dead && !slow) continue;

    const others = [...whsSales.entries()].filter(([w, e]) => w !== s.whsCode && e.s90 > 0).sort((a, z) => z[1].s90 - a[1].s90);
    const po = openPo.get(s.itemCode);
    let rec, detail, recRule;   // recRule = index of the decision rule (for the explain popup)
    let transfer = null;        // { to, qty } for TRANSFER lines (KPI popup)
    const nonSales = isConsumable(s.itemCode, it);
    if (po && po.openQty > 0) {
      rec = 'FREEZE PURCHASE'; recRule = 0;
      detail = `${round(po.openQty, 2)} still on ${po.poCount} open PO(s) — hold or cancel before it arrives`;
    } else if (others.length) {
      const [toWhs, e] = others[0];
      const qty = Math.min(s.onHand, Math.max(1, e.s90 * 2));
      rec = 'TRANSFER'; recRule = 1; transfer = { to: toWhs, qty };
      detail = `Move ${round(qty, 2)} to ${toWhs} (used ${round(e.s90, 2)} there in 90 days)`;
    } else if (nonSales) {
      // Raw / packing material: a customer promotion makes no sense.
      rec = dead && (daysSinceSale == null || daysSinceSale > 365) ? 'LIQUIDATE' : 'CONSUME';
      recRule = rec === 'LIQUIDATE' ? 2 : 3;
      detail = rec === 'LIQUIDATE'
        ? `Non-sales item unused for ${daysSinceSale ?? 'ever'}${daysSinceSale != null ? ' days' : ''} — return to vendor, sell as scrap or write down`
        : `Non-sales item — use up in production/BOMs before re-ordering; ${coverMonths != null ? `${round(coverMonths, 1)} months of cover` : `unused for ${daysSinceSale} days`}`;
    } else if (!dead) {
      const disc = coverMonths != null && coverMonths > 24 ? 20 : 10;
      rec = 'PROMOTION'; recRule = 4;
      detail = `${coverMonths != null ? `${round(coverMonths, 1)} months of cover` : 'Slow seller'} — run a ${disc}% promotion or bundle with fast movers`;
    } else if (daysSinceSale == null || daysSinceSale > 365) {
      rec = 'LIQUIDATE'; recRule = 5;
      detail = daysSinceSale == null ? 'Never sold or consumed from this warehouse — clearance sale, return to vendor or write down' : `Not sold or consumed for ${daysSinceSale} days — clearance sale, return to vendor or write down`;
    } else {
      rec = 'PROMOTION'; recRule = 6;
      detail = `Not used for ${daysSinceSale} days — deep 25-30% discount to key customers before it becomes obsolete`;
    }

    rows.push({
      itemCode: s.itemCode, itemName: it.itemName, group: it.group, whsCode: s.whsCode,
      class: dead ? 'DEAD' : 'SLOW', recommendation: rec, detail,
      onHand: round(s.onHand, 2), unitCost: round(unitCost, 2), value: round(value),
      lastSale, lastMove, daysSinceSale, ageBand: ageBand(daysSinceSale),
      sold365: round(here.s365, 2), sold90: round(here.s90, 2), coverMonths: coverMonths != null ? round(coverMonths, 1) : null,
      openPoQty: po ? round(po.openQty, 2) : 0, sellsElsewhere: others.map(([w]) => w).slice(0, 3).join(', '),
      purchasable: it.purchasable ? 'YES' : 'NO', itemType: nonSales ? 'Non-sales' : 'Sales',
      transferTo: transfer ? transfer.to : null, transferQty: transfer ? round(transfer.qty, 2) : null,
      transferValue: transfer ? round(transfer.qty * unitCost) : null,
      // "How is this calculated?" popups (click the cell) — same inputs as the rules above.
      explain: {
        class: { rules: rulesHit([
          [`Never used, or last use ≥ ${deadDays} days ago`, 'DEAD'],
          [`Last use ≥ ${slowDays} days ago, or > 12 months of cover`, 'SLOW'],
        ], dead ? 0 : 1), note: `Last used ${lastSale ? `${lastSale} (${daysSinceSale} days ago)` : 'never'}${coverMonths != null ? `; ${round(coverMonths, 1)} months of cover` : ''}.` },
        recommendation: { rules: rulesHit([
          ['Open purchase orders for the item', 'FREEZE PURCHASE'],
          ['Used in another warehouse in the last 90 days', 'TRANSFER'],
          ['Non-sales item, dead and unused > 365 days (or never)', 'LIQUIDATE'],
          ['Non-sales item, otherwise', 'CONSUME'],
          ['Slow but still selling (10% off; 20% if > 24 months cover)', 'PROMOTION'],
          ['Dead and unused > 365 days (or never)', 'LIQUIDATE'],
          ['Dead, unused up to 365 days (25–30% off)', 'PROMOTION'],
        ], recRule), note: `First matching rule wins. Open PO qty ${po ? round(po.openQty, 2) : 0}; used elsewhere: ${others.length ? others.slice(0, 3).map(([w]) => w).join(', ') : 'no'}; non-sales item: ${nonSales ? 'yes' : 'no'}.` },
        ...(coverMonths != null ? { coverMonths: { steps: [
          { label: 'Monthly usage', formula: 'used in last 12 months ÷ 12', value: round(monthly, 2), detail: `${round(here.s365, 2)} used in ${s.whsCode}` },
          { label: 'Cover', formula: 'on hand ÷ monthly usage', value: round(coverMonths, 1), detail: `${round(s.onHand, 2)} ÷ ${round(monthly, 2)}` }] } } : {}),
        value: { steps: [{ label: 'Stock value', formula: 'on hand × average cost', value: round(value), detail: `${round(s.onHand, 2)} × ${round(unitCost, 2)}` }] },
      },
    });
  }
  rows.sort((a, z) => z.value - a.value);

  const totalValue = stock.filter(s => !warehouse || s.whsCode === warehouse).reduce((sum, s) => {
    const it = items.get(s.itemCode); return sum + (it ? s.onHand * (s.avgPrice || it.avgPrice || it.lastPurPrice) : 0);
  }, 0);
  const sum = f => rows.filter(f).reduce((s, r) => s + r.value, 0);
  const deadValue = sum(r => r.class === 'DEAD'), slowValue = sum(r => r.class === 'SLOW');
  const byRec = ['FREEZE PURCHASE', 'TRANSFER', 'PROMOTION', 'LIQUIDATE', 'CONSUME'].map(r => ({ recommendation: r, lines: rows.filter(x => x.recommendation === r).length, value: round(sum(x => x.recommendation === r)) }));
  const byBand = AGE_BANDS.map(b => ({ band: b, lines: rows.filter(r => r.ageBand === b).length, value: round(sum(r => r.ageBand === b)) }));
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.group) || { group: r.group, lines: 0, dead: 0, slow: 0, value: 0 };
    g.lines++; g.value += r.value; if (r.class === 'DEAD') g.dead += r.value; else g.slow += r.value;
    groups.set(r.group, g);
  }
  const groupRows = [...groups.values()].map(g => ({ ...g, value: round(g.value), dead: round(g.dead), slow: round(g.slow), share: totalValue ? round((g.value / totalValue) * 100, 1) : 0 })).sort((a, z) => z.value - a.value);
  // Purchase-freeze list is per item (not per warehouse): anything dead/slow that is still purchasable.
  const freezeMap = new Map();
  for (const r of rows) {
    if (r.purchasable !== 'YES') continue;
    const f = freezeMap.get(r.itemCode) || { itemCode: r.itemCode, itemName: r.itemName, class: r.class, value: 0, openPoQty: r.openPoQty, warehouses: [] };
    f.value += r.value; f.warehouses.push(r.whsCode); if (r.class === 'DEAD') f.class = 'DEAD';
    freezeMap.set(r.itemCode, f);
  }
  const freeze = [...freezeMap.values()].map(f => ({ ...f, value: round(f.value), warehouses: f.warehouses.join(', '),
    explain: { action: { rules: rulesHit([
      ['Open purchase orders exist', 'Cancel/hold the open POs and block new purchasing'],
      ['No open purchase orders', 'Block new purchasing until stock clears'],
    ], f.openPoQty > 0 ? 0 : 1), note: `Listed because the item is ${f.class} and still a purchase item.` } },
    action: f.openPoQty > 0 ? `Cancel/hold ${f.openPoQty} on open POs and block new purchasing` : 'Block new purchasing (untick "Purchase Item" or set Max to 0) until stock clears' }))
    .sort((a, z) => (z.openPoQty > 0) - (a.openPoQty > 0) || z.value - a.value);

  const insight = `**${fmtAmt(deadValue + slowValue)} (${totalValue ? Math.round(((deadValue + slowValue) / totalValue) * 100) : 0}% of stock value) is dead or slow-moving across ${rows.length} item-warehouse lines.**\n\n` +
    `- Dead (not sold or consumed ≥ ${deadDays} days): ${fmtAmt(deadValue)}; slow (≥ ${slowDays} days or > 12 months' cover): ${fmtAmt(slowValue)}.\n` +
    byRec.filter(b => b.lines).map(b => `- ${b.recommendation}: ${b.lines} lines, ${fmtAmt(b.value)}.`).join('\n') + '\n' +
    (rows[0] ? `- Largest: **${rows[0].itemCode}** in ${rows[0].whsCode} — ${fmtAmt(rows[0].value)}, last used ${rows[0].lastSale || 'never'} → ${rows[0].recommendation}.\n` : '') +
    (freeze.some(f => f.openPoQty > 0) ? `- ${freeze.filter(f => f.openPoQty > 0).length} dead/slow items still have open purchase orders — freeze these first.\n` : '');

  const aiContext = `DEAD & SLOW STOCK as of ${asOf}${warehouse ? `, warehouse ${warehouse}` : ''}. Slow ≥ ${slowDays}d without sale/consumption (or >12 months cover), dead ≥ ${deadDays}d.
Total stock value ${fmtAmt(totalValue)}, dead ${fmtAmt(deadValue)}, slow ${fmtAmt(slowValue)}.
BY RECOMMENDATION: ${byRec.map(b => `${b.recommendation} ${b.lines} lines ${fmtAmt(b.value)}`).join('; ')}
BY LAST-SALE AGE: ${byBand.map(b => `${b.band} ${fmtAmt(b.value)}`).join('; ')}
TOP LINES:
${ctxTable(rows, [['itemCode', 'Item'], ['whsCode', 'Whs'], ['class', 'Class'], ['value', 'Value'], ['onHand', 'Qty'], ['lastSale', 'LastSale'], ['coverMonths', 'CoverM'], ['openPoQty', 'OpenPO'], ['sellsElsewhere', 'SellsIn'], ['recommendation', 'Rec']], 25)}
GROUPS: ${groupRows.slice(0, 8).map(g => `${g.group} ${fmtAmt(g.value)}`).join('; ')}`;

  const cols = [
    { key: 'recommendation', label: 'Action', fmt: 'badge', hint: 'Recommended disposition (first matching rule): FREEZE PURCHASE, TRANSFER, CONSUME, PROMOTION or LIQUIDATE' },
    { key: 'class', label: 'Class', fmt: 'badge', hint: `DEAD = never used or last used ≥ ${deadDays} days ago; SLOW = last used ≥ ${slowDays} days ago or more than 12 months of cover` },
    { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'SAP item code and description' }, { key: 'whsCode', label: 'Whs', hint: 'Warehouse holding the stock' },
    { key: 'onHand', label: 'On hand', fmt: 'num', hint: 'Quantity in stock in this warehouse' },
    { key: 'value', label: 'Value', fmt: 'amt', strong: true, hint: 'Stock value = on hand × warehouse average cost (item cost as fallback)' },
    { key: 'lastSale', label: 'Last used', fmt: 'date', hint: 'Latest delivery, direct A/R invoice or goods issue (incl. production) from this warehouse' },
    { key: 'daysSinceSale', label: 'Days since', fmt: 'int', hint: 'Days between the last use and the analysis date (blank = never used)' },
    { key: 'sold365', label: 'Used 12m', fmt: 'num', hint: 'Net quantity sold or consumed from this warehouse in the last 12 months' },
    { key: 'coverMonths', label: 'Cover (mo)', fmt: 'num', hint: 'Months the stock lasts at the current pace = on hand ÷ (used 12m ÷ 12)' },
    { key: 'openPoQty', label: 'Open PO', fmt: 'num', hint: 'Quantity still open on purchase orders for this item (all warehouses)' },
    { key: 'detail', label: 'Recommendation detail', wrap: true, hint: 'What to do and why, with quantities' },
  ];
  const flaggedValue = deadValue + slowValue;
  const steps = [
    `Last used = latest A/R invoice, delivery, goods issue or production-order issue (OINM types 13/15/60/202 with outbound qty) for the item in that warehouse, over all history up to the as-of date ${asOf}.`,
    `Days since last use are counted to the analysis date ${asOf}. DEAD = never used or ≥ ${deadDays} days; SLOW = ≥ ${slowDays} days, or more than 12 months of cover (on hand ÷ (net 12-month usage in that warehouse ÷ 12); credit memos and returns reduce usage).`,
    `Value = on hand × warehouse average cost (item average cost, then last purchase price as fallback)${minValue ? `; flagged lines below ${fmtAmt(minValue)} are ignored` : ''}${warehouse ? `; warehouse ${warehouse} only` : ''}.`,
  ];

  // ── KPI popup helpers (charts, tables, rule-based insights per KPI) ──
  const pct = (a, b) => (b ? round((a / b) * 100, 1) : 0);
  const sumOf = (list, f = 'value') => list.reduce((s, r) => s + (typeof f === 'function' ? f(r) : num(r[f])), 0);
  const topBy = (list, key, n = 10) => [...list].sort((a, z) => num(z[key]) - num(a[key])).slice(0, n);
  const distinct = (list, key) => new Set(list.map(r => r[key])).size;
  const nm = r => (r.itemName ? ` (${String(r.itemName).slice(0, 40)})` : '');
  const lineTxt = r => `**${r.itemCode}**${nm(r)} in ${r.whsCode} — ${fmtAmt(r.value)}`;
  const REC_COLOR = { 'FREEZE PURCHASE': '#DC2626', TRANSFER: '#0A6ED1', PROMOTION: '#E9730C', LIQUIDATE: '#6B7280', CONSUME: '#16A34A' };
  const C = {
    item: { key: 'itemCode', label: 'Item', sub: 'itemName' }, whs: { key: 'whsCode', label: 'Whs' },
    value: { key: 'value', label: 'Value', fmt: 'amt' }, last: { key: 'lastSale', label: 'Last used', fmt: 'date' },
    days: { key: 'daysSinceSale', label: 'Days since', fmt: 'int' }, cover: { key: 'coverMonths', label: 'Cover (mo)', fmt: 'num' },
    used: { key: 'sold365', label: 'Used 12m', fmt: 'num' }, rec: { key: 'recommendation', label: 'Action', fmt: 'badge' },
    cls: { key: 'class', label: 'Class', fmt: 'badge' }, group: { key: 'group', label: 'Item group' },
  };
  // Stacked bar: value per band, one series per recommendation present.
  const stackByRec = (title, list, bands, bandOf) => {
    const recs = byRec.map(b => b.recommendation).filter(rc => list.some(r => r.recommendation === rc));
    const used = bands.filter(b => list.some(r => bandOf(r) === b));
    return used.length ? { title, type: 'bar', stacked: true, fmt: 'amt', labels: used,
      series: recs.map(rc => ({ name: rc, color: REC_COLOR[rc], values: used.map(b => round(sumOf(list.filter(r => bandOf(r) === b && r.recommendation === rc)))) })) } : null;
  };
  const deadRows = rows.filter(r => r.class === 'DEAD'), slowRows = rows.filter(r => r.class === 'SLOW');
  const trRows = rows.filter(r => r.recommendation === 'TRANSFER'), liqRows = rows.filter(r => r.recommendation === 'LIQUIDATE');
  const healthyValue = Math.max(0, totalValue - flaggedValue);
  const top10Flag = sumOf(topBy(rows, 'value', 10));

  // Stock base per warehouse and item group (all stock on hand, not only flagged lines).
  const whsAgg = new Map(), grpAgg = new Map();
  const addAgg = (m, key, v) => { const e = m.get(key) || { name: key ?? '—', stockValue: 0, lines: 0, dead: 0, slow: 0, flaggedLines: 0 }; e.stockValue += v; e.lines++; m.set(key, e); };
  for (const s of stock) {
    if (warehouse && s.whsCode !== warehouse) continue;
    const it = items.get(s.itemCode); if (!it) continue;
    const v = s.onHand * (s.avgPrice || it.avgPrice || it.lastPurPrice);
    addAgg(whsAgg, s.whsCode, v); addAgg(grpAgg, it.group, v);
  }
  for (const r of rows) for (const [m, key] of [[whsAgg, r.whsCode], [grpAgg, r.group]]) {
    const e = m.get(key); if (!e) continue;
    e[r.class === 'DEAD' ? 'dead' : 'slow'] += r.value; e.flaggedLines++;
  }
  const finishAgg = m => [...m.values()].map(e => ({ ...e, stockValue: round(e.stockValue), dead: round(e.dead), slow: round(e.slow),
    flagged: round(e.dead + e.slow), healthy: round(Math.max(0, e.stockValue - e.dead - e.slow)),
    flaggedPct: pct(e.dead + e.slow, e.stockValue), share: pct(e.stockValue, totalValue) })).sort((a, z) => z.stockValue - a.stockValue);
  const whsHealth = finishAgg(whsAgg), grpHealth = finishAgg(grpAgg);
  const stockLines = sumOf(whsHealth, 'lines');

  // 1. Stock value
  const grpTop = grpHealth.slice(0, 10);
  const worstGrp = grpHealth.filter(g => g.flagged > 0).sort((a, z) => z.flaggedPct - a.flaggedPct || z.flagged - a.flagged)[0];
  const stockInsight = `**${fmtAmt(totalValue)} of stock on hand in ${stockLines} item-warehouse lines — ${pct(healthyValue, totalValue)}% is healthy, ${pct(flaggedValue, totalValue)}% is dead or slow.**\n\n` +
    (grpHealth[0] ? `- Largest item group: **${grpHealth[0].name}** with ${fmtAmt(grpHealth[0].stockValue)} (${grpHealth[0].share}% of stock), of which ${grpHealth[0].flaggedPct}% is dead or slow.\n` : '') +
    (whsHealth[0] ? `- Largest warehouse: **${whsHealth[0].name}** with ${fmtAmt(whsHealth[0].stockValue)} (${whsHealth[0].share}%); ${whsHealth.length} warehouse(s) hold stock.\n` : '') +
    (worstGrp ? `- Weakest group: **${worstGrp.name}** — ${worstGrp.flaggedPct}% of its ${fmtAmt(worstGrp.stockValue)} is dead or slow; review its re-order points and purchasing first.`
      : '- No dead or slow stock found — keep the current re-order settings.');

  // 2. Dead stock
  const deadBand = b => round(sumOf(deadRows.filter(r => r.ageBand === b)));
  const deadNever = deadBand('Never used'), deadOver365 = deadBand('>365d');
  const deadTop10 = sumOf(topBy(deadRows, 'value', 10));
  const deadWithPo = deadRows.filter(r => r.openPoQty > 0);
  const deadLiq = sumOf(deadRows.filter(r => r.recommendation === 'LIQUIDATE')), deadTr = sumOf(deadRows.filter(r => r.recommendation === 'TRANSFER'));
  const deadInsight = deadRows.length
    ? `**${fmtAmt(deadValue)} (${pct(deadValue, totalValue)}% of stock value) is dead — ${deadRows.length} lines never used or unused for ${deadDays}+ days.**\n\n` +
      `- Largest: ${topBy(deadRows, 'value', 3).map(lineTxt).join('; ')}.\n` +
      `- Never used: ${fmtAmt(deadNever)}; unused > 365 days: ${fmtAmt(deadOver365)}. The top 10 lines are ${pct(deadTop10, deadValue)}% of dead value.\n` +
      (deadWithPo.length ? `- ${deadWithPo.length} dead line(s) still have open purchase orders — hold or cancel those POs first.\n` : '') +
      `- Action: liquidate ${fmtAmt(deadLiq)} (clearance sale, return to vendor or write-down) and transfer ${fmtAmt(deadTr)} to warehouses that still use the item.`
    : `**No dead stock — nothing has gone unused for ${deadDays}+ days.**\n\n- Keep an eye on the ${slowRows.length} slow line(s) before they age into dead stock.`;

  // 3. Slow-moving
  const COVER_BANDS = ['No net use 12m', '≤ 12 mo', '12–24 mo', '> 24 mo'];
  const coverBand = r => (r.coverMonths == null ? COVER_BANDS[0] : r.coverMonths <= 12 ? COVER_BANDS[1] : r.coverMonths <= 24 ? COVER_BANDS[2] : COVER_BANDS[3]);
  const slowOver24 = slowRows.filter(r => r.coverMonths > 24);
  const slowAgeOnly = slowRows.filter(r => !(r.coverMonths > 12));
  const slowPromo = slowRows.filter(r => r.recommendation === 'PROMOTION');
  const slowInsight = slowRows.length
    ? `**${fmtAmt(slowValue)} (${pct(slowValue, totalValue)}% of stock value) is slow-moving across ${slowRows.length} lines — unused for ${slowDays}+ days or holding more than 12 months of cover.**\n\n` +
      `- Largest: ${topBy(slowRows, 'value', 3).map(lineTxt).join('; ')}.\n` +
      `- ${slowOver24.length} line(s) hold more than 24 months of cover (${fmtAmt(sumOf(slowOver24))}); ${slowAgeOnly.length} are flagged by age only (${fmtAmt(sumOf(slowAgeOnly))}).\n` +
      `- Action: promote ${slowPromo.length} line(s) worth ${fmtAmt(sumOf(slowPromo))} (10% off, 20% where cover > 24 months) and stop re-ordering until cover is below 12 months.`
    : `**No slow-moving stock at the current thresholds (${slowDays} days / 12 months of cover).**`;

  // 4. Dead + slow %
  const byWhsDim = whsHealth.length > 1;
  const dimLabel = byWhsDim ? 'Warehouse' : 'Item group';
  const pctBase = (byWhsDim ? whsHealth : grpHealth).filter(e => e.stockValue > 0);
  const pctTop = pctBase.filter(e => e.flagged > 0).sort((a, z) => z.flaggedPct - a.flaggedPct).slice(0, 10);
  const pctBig = [...pctBase].sort((a, z) => z.flagged - a.flagged)[0];
  const pctInsight = flaggedValue && pctTop[0]
    ? `**${pct(flaggedValue, totalValue)}% of stock value (${fmtAmt(flaggedValue)} of ${fmtAmt(totalValue)}) is tied up in dead or slow stock.**\n\n` +
      `- Split: dead ${fmtAmt(deadValue)} (${pct(deadValue, totalValue)}%), slow ${fmtAmt(slowValue)} (${pct(slowValue, totalValue)}%).\n` +
      `- Highest share: **${pctTop[0].name}** — ${pctTop[0].flaggedPct}% of its ${fmtAmt(pctTop[0].stockValue)}. Largest amount: **${pctBig.name}** with ${fmtAmt(pctBig.flagged)}.\n` +
      `- Action: clearing the top 10 lines (${fmtAmt(top10Flag)}) would bring the ratio down to ${pct(flaggedValue - top10Flag, totalValue)}%.`
    : '**0% of stock value is dead or slow — inventory is turning.**';

  // 5. Lines flagged
  const recLines = byRec.filter(b => b.lines).map(b => {
    const l = rows.filter(r => r.recommendation === b.recommendation);
    return { recommendation: b.recommendation, lines: b.lines, dead: l.filter(r => r.class === 'DEAD').length, slow: l.filter(r => r.class === 'SLOW').length, value: b.value, avgValue: round(b.value / b.lines) };
  });
  const recMost = [...recLines].sort((a, z) => z.lines - a.lines)[0];
  const linesInsight = rows.length
    ? `**${rows.length} item-warehouse lines flagged — ${deadRows.length} dead, ${slowRows.length} slow — covering ${distinct(rows, 'itemCode')} items in ${distinct(rows, 'whsCode')} warehouse(s).**\n\n` +
      `- Most common action: **${recMost.recommendation}** (${recMost.lines} lines, ${fmtAmt(recMost.value)}).\n` +
      `- The top 10 lines hold ${pct(top10Flag, flaggedValue)}% of flagged value; the average line is ${fmtAmt(flaggedValue / rows.length)}.\n` +
      `- Action: work the list by value — start with ${lineTxt(rows[0])} → ${rows[0].recommendation}.`
    : '**No item-warehouse lines are dead or slow.**';

  // 6. Transfers
  const trByTarget = new Map();
  for (const r of trRows) { const e = trByTarget.get(r.transferTo) || { to: r.transferTo, lines: 0, value: 0 }; e.lines++; e.value += num(r.transferValue); trByTarget.set(r.transferTo, e); }
  const trTargets = [...trByTarget.values()].sort((a, z) => z.value - a.value);
  const trMoveValue = sumOf(trRows, 'transferValue');
  const tr1 = topBy(trRows, 'transferValue', 1)[0];
  const trInsight = trRows.length
    ? `**${trRows.length} dead/slow lines (${fmtAmt(byRec[1].value)}) sit in warehouses where they don't move, but are used elsewhere — suggested transfers are worth ${fmtAmt(trMoveValue)}.**\n\n` +
      `- Largest: **${tr1.itemCode}**${nm(tr1)} — move ${tr1.transferQty} from ${tr1.whsCode} to ${tr1.transferTo} (${fmtAmt(tr1.transferValue)}).\n` +
      `- Main destination: **${trTargets[0].to}** would receive ${trTargets[0].lines} line(s) worth ${fmtAmt(trTargets[0].value)}${trTargets.length > 1 ? `; ${trTargets.length} target warehouses in total` : ''}.\n` +
      `- Action: raise inventory transfer requests for the top lines; the remaining ${fmtAmt(Math.max(0, byRec[1].value - trMoveValue))} stays put and should be promoted or cleared if it still doesn't move.`
    : '**No transfer opportunities — no flagged item is being used in another warehouse in the last 90 days.**';

  // 7. Freeze purchasing
  const costOf = new Map();
  for (const r of rows) if (!costOf.has(r.itemCode)) costOf.set(r.itemCode, r.unitCost);
  const freezeRows = freeze.map(f => ({ ...f, poValue: round(f.openPoQty * (costOf.get(f.itemCode) || 0)) }));
  const frWithPo = freezeRows.filter(f => f.openPoQty > 0);
  const frPoValue = sumOf(frWithPo, 'poValue'), frStock = sumOf(freezeRows);
  const frTopPo = topBy(frWithPo, 'poValue', 10);
  const frTop = frTopPo[0] || topBy(freezeRows, 'value', 1)[0];
  const freezeInsight = freezeRows.length
    ? `**${freezeRows.length} dead/slow items are still purchase items${frWithPo.length ? `; ${frWithPo.length} have open POs worth about ${fmtAmt(frPoValue)} still to arrive` : ' (no open POs)'}.**\n\n` +
      (frTopPo[0] ? `- Biggest incoming: **${frTop.itemCode}**${nm(frTop)} — ${frTop.openPoQty} on order (≈ ${fmtAmt(frTop.poValue)}) on top of ${fmtAmt(frTop.value)} already dead/slow.\n`
        : `- Largest: **${frTop.itemCode}**${nm(frTop)} — ${fmtAmt(frTop.value)} dead/slow in ${frTop.warehouses}.\n`) +
      `- ${freezeRows.filter(f => f.class === 'DEAD').length} of these items are DEAD; together the items hold ${fmtAmt(frStock)} of flagged stock.\n` +
      `- Action: ${frWithPo.length ? 'hold or cancel the open POs first, then ' : ''}untick "Purchase Item" or set Max stock to 0 until the stock clears.`
    : '**No dead or slow item is still set as a purchase item.**';

  // 8. Liquidation
  const liqGrp = new Map();
  for (const r of liqRows) liqGrp.set(r.group ?? '—', (liqGrp.get(r.group ?? '—') || 0) + r.value);
  const liqGroups = [...liqGrp.entries()].sort((a, z) => z[1] - a[1]);
  const liqValue = byRec[3].value;
  const liqNever = sumOf(liqRows.filter(r => r.daysSinceSale == null)), liqNonSales = sumOf(liqRows.filter(r => r.itemType === 'Non-sales'));
  const liqInsight = liqRows.length
    ? `**${fmtAmt(liqValue)} in ${liqRows.length} lines should be cleared, returned or written down — ${pct(liqValue, flaggedValue)}% of dead + slow value.**\n\n` +
      `- Largest: ${topBy(liqRows, 'value', 3).map(lineTxt).join('; ')}.\n` +
      `- Never used: ${fmtAmt(liqNever)}; non-sales (raw/packing) items: ${fmtAmt(liqNonSales)}. Biggest group: **${liqGroups[0][0]}** with ${fmtAmt(liqGroups[0][1])}.\n` +
      `- Action: offer the top lines back to vendors or to clearance buyers, and agree the write-down of ${fmtAmt(liqValue)} with finance before month-end.`
    : '**Nothing to liquidate — no line is dead and unused for more than 365 days without another use.**';

  return {
    kpis: [
      { label: 'Stock value', value: totalValue, fmt: 'amt', hint: `All stock on hand${warehouse ? ` in ${warehouse}` : ''} at average cost`,
        calc: { formula: `Σ on-hand quantity × warehouse average cost (item average cost, then last purchase price as fallback) over every warehouse line with stock > 0${warehouse ? ` in warehouse ${warehouse}` : ' in all warehouses'}.`,
          steps: ['Includes every item with stock, not only flagged lines — it is the base for the dead + slow %.',
            'Lines whose item is missing from the item master are skipped; the minimum-value filter applies only to flagged lines, not to this total.'],
          sources: [SRC.oitw, SRC.oitm], rows: grpHealth, sortBy: 'stockValue', title: 'Stock value by item group — largest first',
          columns: [{ key: 'name', label: 'Item group' }, { key: 'stockValue', label: 'Stock value', fmt: 'amt' }, { key: 'share', label: '% of stock', fmt: 'pct' },
            { key: 'flagged', label: 'Dead + slow', fmt: 'amt' }, { key: 'flaggedPct', label: '% flagged', fmt: 'pct' }, { key: 'lines', label: 'Lines', fmt: 'int' }],
          stats: [{ label: 'Total stock value', value: round(totalValue), fmt: 'amt' }, { label: 'Healthy (not flagged)', value: round(healthyValue), fmt: 'amt' },
            { label: 'Healthy share', value: pct(healthyValue, totalValue), fmt: 'pct' }, { label: 'Dead', value: round(deadValue), fmt: 'amt' },
            { label: 'Slow', value: round(slowValue), fmt: 'amt' }, { label: 'Lines / warehouses', value: `${stockLines} / ${whsHealth.length}` }],
          chart: grpTop.length ? { title: 'Stock value by item group — healthy vs dead vs slow (top 10)', type: 'bar', stacked: true, horizontal: grpTop.length > 5, fmt: 'amt',
            labels: grpTop.map(g => String(g.name)), series: [{ name: 'Healthy', values: grpTop.map(g => g.healthy), color: '#16A34A' },
              { name: 'Slow', values: grpTop.map(g => g.slow), color: '#E9730C' }, { name: 'Dead', values: grpTop.map(g => g.dead), color: '#DC2626' }] } : null,
          insight: stockInsight } },
      { label: 'Dead stock', value: deadValue, fmt: 'amt', tone: deadValue ? 'bad' : 'good', hint: `Not used for ≥ ${deadDays} days, or never`,
        calc: { formula: `Σ stock value of item-warehouse lines never used in that warehouse, or last used ${deadDays} or more days before ${asOf}.`,
          steps, sources: [SRC.oitw, SRC.oinm, SRC.oitm], tab: 'flagged', filter: r => r.class === 'DEAD', sortBy: 'value', title: 'Largest dead stock lines',
          columns: [C.item, C.whs, C.value, C.last, C.days, C.rec],
          stats: [{ label: 'Dead lines', value: deadRows.length, fmt: 'int' }, { label: 'Distinct items', value: distinct(deadRows, 'itemCode'), fmt: 'int' },
            { label: 'Never used', value: deadNever, fmt: 'amt' }, { label: 'Unused > 365 days', value: deadOver365, fmt: 'amt' },
            { label: 'Share of stock value', value: pct(deadValue, totalValue), fmt: 'pct' }, { label: 'Top-10 concentration', value: pct(deadTop10, deadValue), fmt: 'pct' }],
          chart: stackByRec('Dead stock value by time since last use and recommended action', deadRows, AGE_BANDS, r => r.ageBand),
          insight: deadInsight } },
      { label: 'Slow-moving', value: slowValue, fmt: 'amt', tone: slowValue ? 'warn' : 'good', hint: `≥ ${slowDays} days unused or > 12 months cover`,
        calc: { formula: `Σ stock value of lines not dead but last used ${slowDays}+ days before ${asOf}, or holding more than 12 months of cover at the net 12-month usage pace in that warehouse.`,
          steps, sources: [SRC.oitw, SRC.oinm, SRC.oitm], tab: 'flagged', filter: r => r.class === 'SLOW', sortBy: 'value', title: 'Largest slow-moving lines',
          columns: [C.item, C.whs, C.value, C.days, C.cover, C.rec],
          stats: [{ label: 'Slow lines', value: slowRows.length, fmt: 'int' }, { label: 'Share of stock value', value: pct(slowValue, totalValue), fmt: 'pct' },
            { label: '> 24 months cover (lines)', value: slowOver24.length, fmt: 'int' }, { label: '> 24 months cover (value)', value: round(sumOf(slowOver24)), fmt: 'amt' },
            { label: 'Flagged by age only', value: round(sumOf(slowAgeOnly)), fmt: 'amt' }, { label: 'Promotion candidates', value: round(sumOf(slowPromo)), fmt: 'amt' }],
          chart: stackByRec('Slow stock value by months of cover and recommended action', slowRows, COVER_BANDS, coverBand),
          insight: slowInsight } },
      { label: 'Dead + slow %', value: totalValue ? ((deadValue + slowValue) / totalValue) * 100 : 0, fmt: 'pct', hint: 'Flagged value ÷ total stock value',
        calc: { formula: '(Dead stock value + slow-moving value) ÷ total stock value × 100.', steps,
          sources: [SRC.oitw, SRC.oinm, SRC.oitm], rows: pctBase, sortBy: 'flagged', title: `Dead + slow share by ${dimLabel.toLowerCase()} — largest flagged value first`,
          columns: [{ key: 'name', label: dimLabel }, { key: 'stockValue', label: 'Stock value', fmt: 'amt' }, { key: 'dead', label: 'Dead', fmt: 'amt' },
            { key: 'slow', label: 'Slow', fmt: 'amt' }, { key: 'flaggedPct', label: '% dead + slow', fmt: 'pct' }],
          stats: [{ label: 'Dead + slow value', value: round(flaggedValue), fmt: 'amt' }, { label: 'Total stock value', value: round(totalValue), fmt: 'amt' },
            { label: 'Dead % of stock', value: pct(deadValue, totalValue), fmt: 'pct' }, { label: 'Slow % of stock', value: pct(slowValue, totalValue), fmt: 'pct' },
            { label: 'After clearing top 10 lines', value: pct(flaggedValue - top10Flag, totalValue), fmt: 'pct' },
            { label: `Worst ${dimLabel.toLowerCase()}`, value: pctTop[0] ? `${pctTop[0].name} (${pctTop[0].flaggedPct}%)` : '—' }],
          chart: pctTop.length ? { title: `Dead + slow % of stock value by ${dimLabel.toLowerCase()} (highest 10)`, type: 'bar', horizontal: pctTop.length > 5, fmt: 'pct',
            labels: pctTop.map(e => String(e.name)), series: [{ name: '% dead + slow', values: pctTop.map(e => e.flaggedPct), color: '#E9730C' }] } : null,
          insight: pctInsight } },
      { label: 'Lines flagged', value: rows.length, fmt: 'int', hint: 'Item-warehouse lines that are dead or slow',
        calc: { formula: `Count of item × warehouse combinations with stock classified DEAD or SLOW${minValue ? ` (value ≥ ${fmtAmt(minValue)})` : ''}.`, steps,
          sources: [SRC.oitw, SRC.oinm, SRC.oitm], rows: recLines, sortBy: 'lines', title: 'Flagged lines by recommended action',
          columns: [{ key: 'recommendation', label: 'Action', fmt: 'badge' }, { key: 'lines', label: 'Lines', fmt: 'int' }, { key: 'dead', label: 'Dead', fmt: 'int' },
            { key: 'slow', label: 'Slow', fmt: 'int' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'avgValue', label: 'Avg per line', fmt: 'amt' }],
          stats: [{ label: 'Dead lines', value: deadRows.length, fmt: 'int' }, { label: 'Slow lines', value: slowRows.length, fmt: 'int' },
            { label: 'Distinct items', value: distinct(rows, 'itemCode'), fmt: 'int' }, { label: 'Warehouses', value: distinct(rows, 'whsCode'), fmt: 'int' },
            { label: 'Avg value per line', value: rows.length ? round(flaggedValue / rows.length) : 0, fmt: 'amt' }, { label: 'Top-10 lines share', value: pct(top10Flag, flaggedValue), fmt: 'pct' }],
          chart: recLines.length ? { title: 'Flagged lines by action — dead vs slow', type: 'bar', stacked: true, fmt: 'int', labels: recLines.map(r => r.recommendation),
            series: [{ name: 'Dead lines', values: recLines.map(r => r.dead), color: '#DC2626' }, { name: 'Slow lines', values: recLines.map(r => r.slow), color: '#E9730C' }] } : null,
          insight: linesInsight } },
      { label: 'Transfer opportunities', value: byRec[1].lines, fmt: 'int', hint: 'Lines that still sell in another warehouse',
        calc: { formula: 'Count of dead/slow lines with no open PO for the item whose item had net usage (sales + issues − returns) in another warehouse in the last 90 days before the analysis date.',
          steps: ['Target = the other warehouse with the most usage in the last 90 days.', 'Suggested qty = min(on hand, max(1, 2 × 90-day usage there)) ≈ six months of its demand.',
            'Value to move = suggested qty × this warehouse\'s unit cost.'],
          sources: [SRC.oitw, SRC.oinm, SRC.opor], tab: 'transfer', sortBy: 'transferValue', title: 'Suggested transfers — largest value to move first',
          columns: [C.item, { key: 'whsCode', label: 'From' }, { key: 'transferTo', label: 'To' }, { key: 'transferQty', label: 'Qty to move', fmt: 'num' },
            { key: 'transferValue', label: 'Value to move', fmt: 'amt' }, { key: 'value', label: 'Line value', fmt: 'amt' }],
          stats: [{ label: 'Lines', value: byRec[1].lines, fmt: 'int' }, { label: 'Line value (dead/slow)', value: byRec[1].value, fmt: 'amt' },
            { label: 'Value of suggested qty', value: round(trMoveValue), fmt: 'amt' }, { label: 'Distinct items', value: distinct(trRows, 'itemCode'), fmt: 'int' },
            { label: 'Target warehouses', value: trTargets.length, fmt: 'int' }],
          chart: trTargets.length ? { title: 'Suggested transfer value by target warehouse', type: 'bar', horizontal: trTargets.length > 5, fmt: 'amt',
            labels: trTargets.slice(0, 10).map(t => String(t.to)), series: [{ name: 'Value to move', values: trTargets.slice(0, 10).map(t => round(t.value)), color: '#0A6ED1' }] } : null,
          insight: trInsight } },
      { label: 'Freeze purchasing', value: freeze.length, fmt: 'int', tone: freeze.some(f => f.openPoQty > 0) ? 'bad' : 'warn', hint: 'Dead/slow items still set as purchase items',
        calc: { formula: 'Count of distinct items with at least one dead or slow line that are still flagged "Purchase Item" in SAP.',
          steps: ['Items with open purchase orders come first — hold or cancel those POs.', 'Open PO qty is per item across all warehouses (open, non-cancelled POs, open lines).',
            'Open PO value is an estimate: open qty × the item\'s unit cost in its first flagged warehouse.', 'Others: untick "Purchase Item" or set Max to 0 until stock clears.'],
          sources: [SRC.oitm, SRC.opor, SRC.oitw], rows: freezeRows, sortBy: 'poValue', title: 'Items to block — open POs first, then by stock value',
          columns: [C.item, C.cls, { key: 'value', label: 'Dead/slow value', fmt: 'amt' }, { key: 'openPoQty', label: 'Open PO qty', fmt: 'num' },
            { key: 'poValue', label: 'Open PO value (est.)', fmt: 'amt' }, { key: 'action', label: 'Action', wrap: true }],
          stats: [{ label: 'Items', value: freezeRows.length, fmt: 'int' }, { label: 'With open POs', value: frWithPo.length, fmt: 'int' },
            { label: 'Open PO qty', value: round(sumOf(freezeRows, 'openPoQty'), 2), fmt: 'num' }, { label: 'Open PO value (est.)', value: round(frPoValue), fmt: 'amt' },
            { label: 'Dead/slow stock value', value: round(frStock), fmt: 'amt' }, { label: 'DEAD items', value: freezeRows.filter(f => f.class === 'DEAD').length, fmt: 'int' }],
          chart: frTopPo.length >= 2
            ? { title: 'Open PO value still arriving for dead/slow items (top 10)', type: 'bar', horizontal: true, fmt: 'amt',
              labels: frTopPo.map(f => `${f.itemCode} · ${String(f.itemName || '').slice(0, 30)}`), series: [{ name: 'Open PO value (est.)', values: frTopPo.map(f => f.poValue), color: '#DC2626' }] }
            : freezeRows.length ? { title: 'Dead/slow value of purchasable items — with vs without open POs', type: 'bar', stacked: true, fmt: 'amt', labels: ['DEAD', 'SLOW'],
              series: [{ name: 'With open PO', color: '#DC2626', values: ['DEAD', 'SLOW'].map(c => round(sumOf(frWithPo.filter(f => f.class === c)))) },
                { name: 'No open PO', color: '#E9730C', values: ['DEAD', 'SLOW'].map(c => round(sumOf(freezeRows.filter(f => f.class === c && !(f.openPoQty > 0))))) }] } : null,
          insight: freezeInsight } },
      { label: 'Liquidation value', value: byRec[3].value, fmt: 'amt', hint: 'Stock to clear, return or write down',
        calc: { formula: 'Σ stock value of lines recommended LIQUIDATE: dead and unused for more than 365 days (or never used in that warehouse), with no open PO for the item and no other warehouse using it in the last 90 days — sales and non-sales (raw/packing) items alike.',
          steps: ['Options: clearance sale, return to vendor, scrap sale or write-down.', 'Discuss write-downs with finance before month-end.'],
          sources: [SRC.oitw, SRC.oinm, SRC.oitm, SRC.opor], tab: 'flagged', filter: r => r.recommendation === 'LIQUIDATE', sortBy: 'value', title: 'Lines to liquidate — largest value first',
          columns: [C.item, C.whs, C.group, C.value, C.days, { key: 'itemType', label: 'Item type' }],
          stats: [{ label: 'Lines', value: byRec[3].lines, fmt: 'int' }, { label: 'Distinct items', value: distinct(liqRows, 'itemCode'), fmt: 'int' },
            { label: 'Share of dead + slow', value: pct(liqValue, flaggedValue), fmt: 'pct' }, { label: 'Never used', value: round(liqNever), fmt: 'amt' },
            { label: 'Non-sales items', value: round(liqNonSales), fmt: 'amt' }, { label: 'Item groups', value: liqGroups.length, fmt: 'int' }],
          chart: liqGroups.length ? { title: 'Liquidation value by item group (top 10)', type: 'bar', horizontal: liqGroups.length > 5, fmt: 'amt',
            labels: liqGroups.slice(0, 10).map(([g]) => String(g)), series: [{ name: 'Liquidation value', values: liqGroups.slice(0, 10).map(([, v]) => round(v)), color: '#6B7280' }] } : null,
          insight: liqInsight } },
    ],
    chart: { title: 'Flagged stock value by time since last use', type: 'bar', labels: byBand.map(b => b.band), series: [{ name: 'Value', values: byBand.map(b => b.value), color: '#E9730C' }],
      desc: 'Value of dead and slow stock grouped by how long ago it was last sold or consumed — the further right, the harder it is to recover the value.' },
    tabs: [
      { key: 'flagged', label: `Dead & slow (${rows.length})`, rows, columns: cols,
        desc: 'Every dead or slow-moving item-warehouse line with its recommended action, largest value first — click Action or Class to see why.' },
      { key: 'transfer', label: `Transfers (${byRec[1].lines})`, rows: rows.filter(r => r.recommendation === 'TRANSFER'), columns: cols,
        desc: 'Lines that do not move here but sell in another warehouse — the detail column names the target warehouse and suggested quantity.' },
      { key: 'freeze', label: `Purchase freeze (${freeze.length})`, rows: freeze,
        desc: 'Dead or slow items that can still be purchased — block purchasing, and hold or cancel open POs (listed first).',
        columns: [{ key: 'class', label: 'Class', fmt: 'badge', hint: 'DEAD if any warehouse line is dead, otherwise SLOW' },
          { key: 'itemCode', label: 'Item', sub: 'itemName', hint: 'SAP item code and description' },
          { key: 'value', label: 'Stock value', fmt: 'amt', hint: 'Σ value of the flagged lines of this item across warehouses' },
          { key: 'openPoQty', label: 'Open PO qty', fmt: 'num', hint: 'Quantity still open on purchase orders' },
          { key: 'warehouses', label: 'Warehouses', hint: 'Warehouses where the item is dead or slow' },
          { key: 'action', label: 'Action', wrap: true, hint: 'What to do in SAP purchasing' }] },
      { key: 'groups', label: 'By item group', rows: groupRows,
        desc: 'Dead and slow stock summarised by item group — shows which product families tie up the most capital.',
        columns: [{ key: 'group', label: 'Item group', hint: 'SAP item group' }, { key: 'lines', label: 'Lines', fmt: 'int', hint: 'Number of flagged item-warehouse lines' },
          { key: 'dead', label: 'Dead', fmt: 'amt', hint: 'Value of dead lines in the group' },
          { key: 'slow', label: 'Slow', fmt: 'amt', hint: 'Value of slow lines in the group' }, { key: 'value', label: 'Total', fmt: 'amt', hint: 'Dead + slow value' },
          { key: 'share', label: '% of stock', fmt: 'pct', hint: 'Group dead + slow value ÷ total stock value of all items' }] },
    ],
    notes: [
      'Last used = latest delivery, direct A/R invoice or goods issue (incl. issue for production) for the item in that warehouse (OINM). Value = on hand × warehouse average cost (item average cost as fallback).',
      'Transfers target the warehouse with the most usage of the item in the last 90 days, sized to about six months of its demand.',
    ],
    insight, aiContext,
  };
}

export function createDeadStockAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'deadstock', title: 'Dead Stock Agent',
    defaults: { slowDays: 90, deadDays: 180 },
    persona: 'You are an inventory controller reducing dead and slow-moving stock in SAP Business One.',
    aiTask: 'Review this dead and slow-moving stock analysis. Prioritise the disposition plan (freeze purchases, transfers, promotions, liquidation) by value, with item codes and warehouses.',
    run,
  });
}
