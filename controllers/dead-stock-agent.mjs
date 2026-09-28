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

const AGE_BANDS = ['0-90d', '91-180d', '181-365d', '>365d', 'Never used'];
const ageBand = d => (d == null ? 'Never used' : d <= 90 ? '0-90d' : d <= 180 ? '91-180d' : d <= 365 ? '181-365d' : '>365d');

async function run(k, p) {
  const asOf = p.asOf;
  const slowDays = clamp(Math.round(num(p.slowDays) || 90), 14, 720);
  const deadDays = clamp(Math.round(num(p.deadDays) || 180), slowDays + 1, 1500);
  const warehouse = String(p.warehouse || '').trim();
  const minValue = num(p.minValue);

  const items = await loadItems(k);
  const stock = await loadWarehouseStock(k, { onlyPositive: true });
  const last = await loadLastMovements(k);
  const moves = await loadDemandMovements(k, since(asOf, 365), { byWarehouse: true });
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
    let rec, detail;
    if (po && po.openQty > 0) {
      rec = 'FREEZE PURCHASE';
      detail = `${round(po.openQty, 2)} still on ${po.poCount} open PO(s) — hold or cancel before it arrives`;
    } else if (others.length) {
      const [toWhs, e] = others[0];
      const qty = Math.min(s.onHand, Math.max(1, e.s90 * 2));
      rec = 'TRANSFER';
      detail = `Move ${round(qty, 2)} to ${toWhs} (used ${round(e.s90, 2)} there in 90 days)`;
    } else if (isConsumable(s.itemCode, it)) {
      // Raw / packing material: a customer promotion makes no sense.
      rec = dead && (daysSinceSale == null || daysSinceSale > 365) ? 'LIQUIDATE' : 'CONSUME';
      detail = rec === 'LIQUIDATE'
        ? `Non-sales item unused for ${daysSinceSale ?? 'ever'}${daysSinceSale != null ? ' days' : ''} — return to vendor, sell as scrap or write down`
        : `Non-sales item — use up in production/BOMs before re-ordering; ${coverMonths != null ? `${round(coverMonths, 1)} months of cover` : `unused for ${daysSinceSale} days`}`;
    } else if (!dead) {
      const disc = coverMonths != null && coverMonths > 24 ? 20 : 10;
      rec = 'PROMOTION';
      detail = `${coverMonths != null ? `${round(coverMonths, 1)} months of cover` : 'Slow seller'} — run a ${disc}% promotion or bundle with fast movers`;
    } else if (daysSinceSale == null || daysSinceSale > 365) {
      rec = 'LIQUIDATE';
      detail = daysSinceSale == null ? 'Never sold or consumed from this warehouse — clearance sale, return to vendor or write down' : `Not sold or consumed for ${daysSinceSale} days — clearance sale, return to vendor or write down`;
    } else {
      rec = 'PROMOTION';
      detail = `Not used for ${daysSinceSale} days — deep 25-30% discount to key customers before it becomes obsolete`;
    }

    rows.push({
      itemCode: s.itemCode, itemName: it.itemName, group: it.group, whsCode: s.whsCode,
      class: dead ? 'DEAD' : 'SLOW', recommendation: rec, detail,
      onHand: round(s.onHand, 2), unitCost: round(unitCost, 2), value: round(value),
      lastSale, lastMove, daysSinceSale, ageBand: ageBand(daysSinceSale),
      sold365: round(here.s365, 2), sold90: round(here.s90, 2), coverMonths: coverMonths != null ? round(coverMonths, 1) : null,
      openPoQty: po ? round(po.openQty, 2) : 0, sellsElsewhere: others.map(([w]) => w).slice(0, 3).join(', '),
      purchasable: it.purchasable ? 'YES' : 'NO',
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
    { key: 'recommendation', label: 'Action', fmt: 'badge' }, { key: 'class', label: 'Class', fmt: 'badge' },
    { key: 'itemCode', label: 'Item', sub: 'itemName' }, { key: 'whsCode', label: 'Whs' },
    { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'value', label: 'Value', fmt: 'amt', strong: true },
    { key: 'lastSale', label: 'Last used', fmt: 'date' }, { key: 'daysSinceSale', label: 'Days since', fmt: 'int' },
    { key: 'sold365', label: 'Used 12m', fmt: 'num' }, { key: 'coverMonths', label: 'Cover (mo)', fmt: 'num' },
    { key: 'openPoQty', label: 'Open PO', fmt: 'num' }, { key: 'detail', label: 'Recommendation detail', wrap: true },
  ];

  return {
    kpis: [
      { label: 'Stock value', value: totalValue, fmt: 'amt' },
      { label: 'Dead stock', value: deadValue, fmt: 'amt', tone: deadValue ? 'bad' : 'good' },
      { label: 'Slow-moving', value: slowValue, fmt: 'amt', tone: slowValue ? 'warn' : 'good' },
      { label: 'Dead + slow %', value: totalValue ? ((deadValue + slowValue) / totalValue) * 100 : 0, fmt: 'pct' },
      { label: 'Lines flagged', value: rows.length, fmt: 'int' },
      { label: 'Transfer opportunities', value: byRec[1].lines, fmt: 'int' },
      { label: 'Freeze purchasing', value: freeze.length, fmt: 'int', tone: freeze.some(f => f.openPoQty > 0) ? 'bad' : 'warn' },
      { label: 'Liquidation value', value: byRec[3].value, fmt: 'amt' },
    ],
    chart: { title: 'Flagged stock value by time since last use', type: 'bar', labels: byBand.map(b => b.band), series: [{ name: 'Value', values: byBand.map(b => b.value), color: '#E9730C' }] },
    tabs: [
      { key: 'flagged', label: `Dead & slow (${rows.length})`, rows, columns: cols },
      { key: 'transfer', label: `Transfers (${byRec[1].lines})`, rows: rows.filter(r => r.recommendation === 'TRANSFER'), columns: cols },
      { key: 'freeze', label: `Purchase freeze (${freeze.length})`, rows: freeze,
        columns: [{ key: 'class', label: 'Class', fmt: 'badge' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
          { key: 'value', label: 'Stock value', fmt: 'amt' }, { key: 'openPoQty', label: 'Open PO qty', fmt: 'num' },
          { key: 'warehouses', label: 'Warehouses' }, { key: 'action', label: 'Action', wrap: true }] },
      { key: 'groups', label: 'By item group', rows: groupRows,
        columns: [{ key: 'group', label: 'Item group' }, { key: 'lines', label: 'Lines', fmt: 'int' }, { key: 'dead', label: 'Dead', fmt: 'amt' },
          { key: 'slow', label: 'Slow', fmt: 'amt' }, { key: 'value', label: 'Total', fmt: 'amt' }, { key: 'share', label: '% of stock', fmt: 'pct' }] },
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
