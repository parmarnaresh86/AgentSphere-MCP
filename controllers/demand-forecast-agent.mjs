/**
 * Supply Chain Demand Forecast Agent — mounted at /api/demand-forecast-agent
 *
 * Automates the Watertech "Demand & Supply Forecast Planning" Excel model
 * (wt/Forcast Model Based On point.xlsx + SOW) on live SAP B1 data:
 *
 *   Actual demand     monthly A/R invoice qty − credit memos (or sales-order qty)
 *   Forecast demand   exponential smoothing per item, Excel FORECAST.ETS style:
 *                     Holt-Winters additive (trend + 12-month season) when there
 *                     are ≥ 24 months, else Holt / simple — picked by AIC —
 *                     with a confidence band and Alpha/Beta/Gamma/MAE/RMSE/
 *                     SMAPE/MASE like FORECAST.ETS.STAT. Manual overrides win.
 *   Forecasted supply open PO quantities by arrival month (line ship date, or a
 *                     "target delivery date" UDF), PO deposit RAG from a UDF
 *   Min inventory     daily forecast demand × lead time × (1 + safety margin %)
 *   Inventory level   on hand + supply − demand forecast, month by month
 *   Required order    lot-for-lot orders (≥ min order qty) that keep the
 *                     projection at or above min inventory, with order-by date
 *   Live pace         month-to-date sales vs this month's plan → FAST / SLOW
 */
import { createInsightRouter, ctxTable, num, round, clamp, fmtAmt, addDays, daysBetween, isoDate, AgentDataError } from '../lib/insight-kit.mjs';
import { loadItems, loadWarehouseStock } from '../lib/insight-data.mjs';
import { agentSettingsRepo } from '../lib/insight-store.mjs';

const SETTINGS_KEY = 'demand-forecast';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const Z = { 80: 1.2816, 90: 1.6449, 95: 1.96, 99: 2.5758 };

// ── Month keys ('YYYY-MM') ───────────────────────────────────────────────────
const mk = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return mk(Math.floor(t / 12), (t % 12) + 1);
}
const monthLabel = key => `${MON[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
const daysInMonth = key => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const monthRange = (from, n) => Array.from({ length: n }, (_, i) => addMonths(from, i));

// ── Exponential smoothing (ETS A,Ad,A) ───────────────────────────────────────
// One-step-ahead fit over the whole series; the grid search keeps the lowest
// SSE per model form, then AIC picks between simple / trend / trend+season so
// extra parameters have to earn their place. Trend is lightly damped so a
// 12-month horizon does not run away on a short series.
const PHI = 0.98;
const GRID_A = [0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8];
const GRID_B = [0.001, 0.01, 0.05, 0.1, 0.2, 0.3];
const GRID_G = [0.05, 0.1, 0.2, 0.3, 0.5];

function runEts(y, a, b, g, m, trend, seasonal) {
  const n = y.length;
  let l, t = 0;
  const s = new Array(m).fill(0);
  if (seasonal) {
    const m1 = y.slice(0, m).reduce((x, v) => x + v, 0) / m;
    const m2 = y.slice(m, 2 * m).reduce((x, v) => x + v, 0) / m;
    l = m1; t = trend ? (m2 - m1) / m : 0;
    for (let i = 0; i < m; i++) s[i] = y[i] - m1;
  } else {
    // Level/trend from a least-squares line over the first year (like Excel's
    // ETS start-up), so a short, noisy series still gets a sensible slope.
    const w = Math.min(n, 12), xm = (w - 1) / 2;
    const ym = y.slice(0, w).reduce((x, v) => x + v, 0) / w;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < w; i++) { sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) ** 2; }
    t = trend && sxx > 0 ? sxy / sxx : 0;
    l = trend ? ym - t * xm - t : y[0];
  }
  const fitted = new Array(n).fill(null);
  const start = seasonal ? m : 1;
  let sse = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const si = seasonal ? s[i % m] : 0;
    const f = l + (trend ? PHI * t : 0) + si;
    if (i >= start) { fitted[i] = f; sse += (y[i] - f) ** 2; cnt++; }
    const lPrev = l;
    l = a * (y[i] - si) + (1 - a) * (lPrev + (trend ? PHI * t : 0));
    if (trend) t = b * (l - lPrev) + (1 - b) * PHI * t;
    if (seasonal) s[i % m] = g * (y[i] - l) + (1 - g) * si;
  }
  return { sse, cnt, fitted, l, t, s };
}

function fitSeries(y, m = 12) {
  const n = y.length;
  const forms = [{ name: 'Simple', trend: false, seasonal: false, k: 2 }];
  if (n >= 6) forms.push({ name: 'Holt (trend)', trend: true, seasonal: false, k: 4 });
  if (n >= 2 * m) forms.push({ name: 'Holt-Winters', trend: true, seasonal: true, k: 4 + m });
  let best = null;
  for (const f of forms) {
    let bf = null;
    for (const a of GRID_A) for (const b of (f.trend ? GRID_B : [0])) for (const g of (f.seasonal ? GRID_G : [0])) {
      const r = runEts(y, a, b, g, m, f.trend, f.seasonal);
      if (!bf || r.sse < bf.r.sse) bf = { a, b, g, r };
    }
    const N = bf.r.cnt || 1;
    const aic = N * Math.log(Math.max(bf.r.sse, 1e-9) / N) + 2 * f.k;
    if (!best || aic < best.aic) best = { ...f, ...bf, aic };
  }
  const { r, a, b, g } = best;
  const errs = [], sm = [];
  for (let i = 0; i < n; i++) {
    if (r.fitted[i] == null) continue;
    const e = y[i] - r.fitted[i];
    errs.push(e);
    const den = Math.abs(y[i]) + Math.abs(r.fitted[i]);
    if (den > 0) sm.push((2 * Math.abs(e)) / den);
  }
  const mae = errs.length ? errs.reduce((x, e) => x + Math.abs(e), 0) / errs.length : 0;
  const rmse = errs.length ? Math.sqrt(errs.reduce((x, e) => x + e * e, 0) / errs.length) : 0;
  let naive = 0;
  for (let i = 1; i < n; i++) naive += Math.abs(y[i] - y[i - 1]);
  naive = n > 1 ? naive / (n - 1) : 0;
  const forecast = h => {
    let damp = 0;
    for (let j = 1; j <= h; j++) damp += PHI ** j;
    return r.l + (best.trend ? damp * r.t : 0) + (best.seasonal ? r.s[(n - 1 + h) % m] : 0);
  };
  // Prediction variance: σ²·(1 + Σ c_j²), c_j = α(1 + jβ) + γ·[j ≡ 0 mod m].
  const halfWidth = (h, z) => {
    let v = 1;
    for (let j = 1; j < h; j++) {
      const c = a * (1 + (best.trend ? j * b : 0)) + (best.seasonal && j % m === 0 ? g : 0);
      v += c * c;
    }
    return z * rmse * Math.sqrt(v);
  };
  return {
    method: best.name, alpha: a, beta: best.trend ? b : null, gamma: best.seasonal ? g : null,
    mae, rmse, smape: sm.length ? (sm.reduce((x, v) => x + v, 0) / sm.length) * 100 : null,
    mase: naive > 0 ? mae / naive : null, fitted: r.fitted, forecast, halfWidth,
    sumErr: errs.reduce((x, e) => x + e, 0), sumAbsErr: errs.reduce((x, e) => x + Math.abs(e), 0),
  };
}

// Too little history for smoothing: flat average of what there is.
function averageModel(y) {
  const avg = y.length ? y.reduce((a, v) => a + v, 0) / y.length : 0;
  const sd = y.length > 1 ? Math.sqrt(y.reduce((a, v) => a + (v - avg) ** 2, 0) / (y.length - 1)) : avg * 0.5;
  return {
    method: y.length ? 'Average (low data)' : 'No history', alpha: null, beta: null, gamma: null,
    mae: null, rmse: sd, smape: null, mase: null, fitted: y.map(() => null),
    forecast: () => avg, halfWidth: (h, z) => z * sd * Math.sqrt(h), sumErr: 0, sumAbsErr: 0,
  };
}

// ── SAP reads ────────────────────────────────────────────────────────────────
// Monthly qty per item from a marketing document pair, in inventory UoM when
// the line carries InvQty. Returns Map itemCode → Map monthKey → qty.
async function loadMonthlyQty(k, head, lines, from, to, { warehouse, sign = 1, into } = {}) {
  await k.need(head, ['DocEntry', 'DocDate', 'CANCELED']);
  await k.need(lines, ['DocEntry', 'ItemCode', 'Quantity', 'WhsCode']);
  const qty = (await k.has(lines, 'InvQty')) ? 'InvQty' : 'Quantity';
  const rows = await k.run(`SELECT T1.{ItemCode} AS {ItemCode}, YEAR(T0.{DocDate}) AS {Yr}, MONTH(T0.{DocDate}) AS {Mo}, SUM(T1.{${qty}}) AS {Qty}
    FROM @${head} T0 INNER JOIN @${lines} T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{CANCELED} = 'N' AND T0.{DocDate} >= ${k.lit(from)} AND T0.{DocDate} <= ${k.lit(to)} AND T1.{ItemCode} IS NOT NULL
      ${warehouse ? `AND T1.{WhsCode} = ${k.lit(warehouse)}` : ''}
    GROUP BY T1.{ItemCode}, YEAR(T0.{DocDate}), MONTH(T0.{DocDate})`);
  const map = into || new Map();
  for (const r of rows) {
    const key = mk(num(r.Yr), num(r.Mo));
    if (!map.has(r.ItemCode)) map.set(r.ItemCode, new Map());
    const m = map.get(r.ItemCode);
    m.set(key, (m.get(key) || 0) + num(r.Qty) * sign);
  }
  return map;
}

const UDF_RE = /^U_\w{1,50}$/;

// Open PO lines with arrival date and optional deposit / target-delivery UDFs.
async function loadOpenPoLines(k, { warehouse, arrivalField, depositField }) {
  await k.need('OPOR', ['DocEntry', 'DocNum', 'CardCode', 'CardName', 'DocDate', 'DocDueDate', 'DocStatus', 'CANCELED']);
  await k.need('POR1', ['DocEntry', 'LineNum', 'ItemCode', 'OpenQty', 'LineStatus', 'WhsCode', 'Price']);
  const openQty = (await k.has('POR1', 'OpenInvQty')) ? 'OpenInvQty' : 'OpenQty';
  const ship = await k.has('POR1', 'ShipDate');
  const udf = async f => {
    if (!f) return null;
    if (!UDF_RE.test(f)) throw new AgentDataError(`"${f}" is not a UDF name (expected U_…).`);
    if (await k.has('POR1', f)) return `T1.{${f}}`;
    if (await k.has('OPOR', f)) return `T0.{${f}}`;
    throw new AgentDataError(`UDF ${f} was not found on OPOR or POR1.`);
  };
  const arr = await udf(arrivalField), dep = await udf(depositField);
  const rows = await k.run(`SELECT T0.{DocEntry} AS {DocEntry}, T0.{DocNum} AS {DocNum}, T0.{CardCode} AS {CardCode}, T0.{CardName} AS {CardName},
      T0.{DocDate} AS {DocDate}, T0.{DocDueDate} AS {DocDueDate}, T1.{LineNum} AS {LineNum}, T1.{ItemCode} AS {ItemCode},
      T1.{${openQty}} AS {OpenQty}, T1.{Price} AS {Price}${ship ? ', T1.{ShipDate} AS {ShipDate}' : ''}
      ${arr ? `, ${arr} AS {ArrivalUdf}` : ''}${dep ? `, ${dep} AS {DepositUdf}` : ''}
    FROM @OPOR T0 INNER JOIN @POR1 T1 ON T1.{DocEntry} = T0.{DocEntry}
    WHERE T0.{DocStatus} = 'O' AND T0.{CANCELED} = 'N' AND T1.{LineStatus} = 'O' AND T1.{${openQty}} > 0
      ${warehouse ? `AND T1.{WhsCode} = ${k.lit(warehouse)}` : ''}`);
  const iso = isoDate;
  const paidFlag = v => v != null && String(v).trim() !== '' && !/^(n|no|0|false)$/i.test(String(v).trim());
  return {
    usedArrival: arr ? arrivalField : ship ? 'POR1.ShipDate' : 'OPOR.DocDueDate', usedDeposit: dep ? depositField : null,
    lines: rows.map(r => ({
      docEntry: r.DocEntry, docNum: r.DocNum, cardCode: r.CardCode, cardName: r.CardName || '', lineNum: r.LineNum,
      itemCode: r.ItemCode, openQty: num(r.OpenQty), price: num(r.Price), docDate: iso(r.DocDate),
      arrival: (arr && iso(r.ArrivalUdf)) || (ship && iso(r.ShipDate)) || iso(r.DocDueDate) || iso(r.DocDate),
      deposit: dep ? (paidFlag(r.DepositUdf) ? iso(r.DepositUdf) || String(r.DepositUdf).trim() : '') : undefined,
    })),
  };
}

async function loadOrderRules(k) {
  const cols = ['MinOrdrQty', 'OrdrMulti'];
  const have = [];
  for (const c of cols) if (await k.has('OITM', c)) have.push(c);
  if (!have.length) return new Map();
  const rows = await k.run(`SELECT {ItemCode}, ${have.map(c => `{${c}}`).join(', ')} FROM @OITM WHERE {InvntItem} = 'Y'`);
  return new Map(rows.map(r => [r.ItemCode, { minOrder: num(r.MinOrdrQty), multiple: num(r.OrdrMulti) }]));
}

function lotSize(need, rule) {
  let q = Math.max(need, rule?.minOrder || 0);
  if (rule?.multiple > 1) q = Math.ceil(q / rule.multiple) * rule.multiple;
  return Math.ceil(q);
}

// ── Analysis ─────────────────────────────────────────────────────────────────
async function run(k, p) {
  const asOf = p.asOf;
  const historyMonths = clamp(Math.round(num(p.historyMonths) || 36), 6, 60);
  const horizon = clamp(Math.round(num(p.horizonMonths) || 12), 3, 18);
  const conf = [80, 90, 95, 99].includes(Number(p.confidence)) ? Number(p.confidence) : 95;
  const z = Z[conf];
  const marginPct = clamp(num(p.safetyMarginPct ?? 25), 0, 300);
  const defaultLT = clamp(num(p.defaultLeadTime) || 30, 1, 365);
  const excessMonths = clamp(num(p.excessMonths) || 6, 1, 36);
  const staleDays = clamp(num(p.stalePoDays) || 180, 30, 3650);
  const source = String(p.demandSource || 'invoices') === 'orders' ? 'orders' : 'invoices';
  const warehouse = String(p.warehouse || '').trim();
  const groupFilter = String(p.group || '').trim().toLowerCase();
  const focus = String(p.item || '').trim();

  const cur = asOf.slice(0, 7);
  const histStart = addMonths(cur, -historyMonths);
  const histMonths = monthRange(histStart, historyMonths);            // completed months
  const planMonths = monthRange(cur, horizon);                        // cur = month 1
  const dom = Number(asOf.slice(8, 10)), dim = daysInMonth(cur);
  const from = `${histStart}-01`;

  // Demand history (completed months + month-to-date).
  const demand = new Map();
  if (source === 'orders') await loadMonthlyQty(k, 'ORDR', 'RDR1', from, asOf, { warehouse, into: demand });
  else {
    await loadMonthlyQty(k, 'OINV', 'INV1', from, asOf, { warehouse, into: demand });
    if (await k.has('RIN1', 'ItemCode')) await loadMonthlyQty(k, 'ORIN', 'RIN1', from, asOf, { warehouse, sign: -1, into: demand });
  }
  const poHist = await loadMonthlyQty(k, 'OPOR', 'POR1', from, asOf, { warehouse });
  const po = await loadOpenPoLines(k, { warehouse, arrivalField: String(p.arrivalField || '').trim(), depositField: String(p.depositField || '').trim() });
  const items = await loadItems(k);
  const whs = warehouse ? new Map((await loadWarehouseStock(k, { warehouse })).map(r => [r.itemCode, r])) : null;
  const rules = await loadOrderRules(k);
  const overrides = agentSettingsRepo.get(k.company, SETTINGS_KEY).overrides || {};

  const supplyBy = new Map();
  for (const l of po.lines) {
    if (l.arrival && daysBetween(l.arrival, asOf) > staleDays) continue;               // stale: excluded from supply
    const mon = l.arrival && l.arrival.slice(0, 7) > cur ? l.arrival.slice(0, 7) : cur;   // late POs land in the current month
    if (!supplyBy.has(l.itemCode)) supplyBy.set(l.itemCode, new Map());
    const m = supplyBy.get(l.itemCode);
    m.set(mon, (m.get(mon) || 0) + l.openQty);
  }

  const codes = new Set([...demand.keys(), ...supplyBy.keys()]);
  const rows = [];
  for (const code of codes) {
    const it = items.get(code);
    if (!it) continue;                                   // non-inventory lines
    if (groupFilter && !it.group.toLowerCase().includes(groupFilter)) continue;
    const dm = demand.get(code) || new Map();
    const full = histMonths.map(mo => Math.max(0, dm.get(mo) || 0));
    const mtd = Math.max(0, dm.get(cur) || 0);
    const firstNz = full.findIndex(v => v > 0);
    const y = firstNz < 0 ? [] : full.slice(firstNz);   // new items: start at first sale
    const model = y.length >= 4 && y.some(v => v > 0) ? fitSeries(y) : averageModel(y);
    const ov = overrides[code] || {};
    const zeroShare = y.length ? y.filter(v => v === 0).length / y.length : 1;

    const fc = planMonths.map((mo, i) => {
      const stat = Math.max(0, model.forecast(i + 1));
      const hw = model.halfWidth(i + 1, z);
      const manual = ov[mo] != null ? num(ov[mo]) : null;
      return { mo, stat, hw, value: manual ?? stat, lower: Math.max(0, (manual ?? stat) - hw), upper: (manual ?? stat) + hw, manual: manual != null };
    });
    const s = warehouse ? whs.get(code) : null;
    const onHand = s ? s.onHand : it.onHand;
    const committed = s ? s.committed : it.committed;
    const unitCost = (s?.avgPrice ?? null) || it.avgPrice || it.lastPurPrice || 0;
    const lt = it.leadTime > 0 ? it.leadTime : defaultLT;
    const horizonDemand = fc.reduce((a, f) => a + f.value, 0);
    const dailyFc = horizonDemand / planMonths.reduce((a, mo) => a + daysInMonth(mo), 0);
    const active = horizonDemand >= 0.5;                 // below this the plan is effectively zero
    if (!active) for (const f of fc) { f.hw = 0; f.lower = 0; f.upper = f.value; }   // dormant: no band
    const minInv = active ? Math.max(it.minLevel || 0, dailyFc * lt * (1 + marginPct / 100)) : 0;
    const sup = supplyBy.get(code) || new Map();

    // Projection with confirmed supply only, then lot-for-lot planned orders.
    let invC = onHand, invP = onHand, firstShort = null, firstBelowMin = null;
    const proj = [], plans = [];
    fc.forEach((f, i) => {
      const d = i === 0 ? Math.max(0, f.value - mtd) : f.value;
      const supply = sup.get(f.mo) || 0;
      invC += supply - d;
      invP += supply - d;
      if (active && invC < -1e-6 && !firstShort) firstShort = f.mo;
      if (active && invC < minInv - 1e-6 && !firstBelowMin) firstBelowMin = f.mo;
      let planned = 0;
      if (active && invP < minInv - 1e-6) {
        planned = lotSize(minInv - invP, rules.get(code));
        invP += planned;
        const needBy = i === 0 ? asOf : `${f.mo}-01`;
        const orderBy = addDays(needBy, -lt);
        plans.push({ month: f.mo, qty: planned, needBy, orderBy, lateDays: Math.max(0, daysBetween(orderBy, asOf)) });
      }
      proj.push({ mo: f.mo, demand: d, supply, invC, invP, planned });
    });

    const expected = fc[0].value * (dom / dim);
    const pace = expected >= 1 ? (mtd / expected) * 100 : null;
    const paceStatus = pace == null ? 'NO PLAN' : pace > 125 ? 'FAST' : pace < 75 ? 'SLOW' : 'ON PLAN';
    const avgMonthly = horizonDemand / horizon;
    const cover = avgMonthly > 0 ? onHand / avgMonthly : null;
    const lastIdx = histMonths.length - 1;
    const lastActual = full[lastIdx];
    const lastFc = firstNz >= 0 && lastIdx >= firstNz ? model.fitted[lastIdx - firstNz] : null;
    const sumY = y.reduce((a, v) => a + v, 0);

    let status = 'OK';
    if (!active) status = 'NO DEMAND';
    else if (firstShort) status = 'STOCKOUT RISK';
    else if (firstBelowMin) status = 'BELOW MIN';
    else if (cover != null && cover > excessMonths) status = 'EXCESS';
    else if (y.length < 4) status = 'LOW DATA';

    const row = {
      itemCode: code, itemName: it.itemName, group: it.group, vendor: it.prefVendor, status, method: model.method,
      pattern: !y.length ? 'none' : zeroShare >= 0.5 ? 'intermittent' : model.gamma != null ? 'seasonal' : model.beta != null ? 'trend' : 'level',
      historyMonths: y.length, last3Avg: round(full.slice(-3).reduce((a, v) => a + v, 0) / 3, 2), histTotal: round(sumY, 2),
      onHand: round(onHand, 2), committed: round(committed, 2), openPo: round([...sup.values()].reduce((a, v) => a + v, 0), 2),
      leadTime: lt, leadTimeSource: it.leadTime > 0 ? 'item' : 'default', minInv: round(minInv, 2),
      horizonDemand: round(horizonDemand, 2), horizonLower: round(fc.reduce((a, f) => a + f.lower, 0), 2), horizonUpper: round(fc.reduce((a, f) => a + f.upper, 0), 2),
      horizonValue: round(horizonDemand * unitCost), unitCost: round(unitCost, 2), stockValue: round(onHand * unitCost),
      coverMonths: cover != null ? round(cover, 1) : null, firstShort: firstShort ? monthLabel(firstShort) : '', firstBelowMin: firstBelowMin ? monthLabel(firstBelowMin) : '',
      endInv: round(proj[proj.length - 1].invC, 2),
      mtd: round(mtd, 2), planThisMonth: round(fc[0].value, 2), expectedMtd: round(expected, 2), pace: pace != null ? round(pace, 1) : null, paceStatus,
      alpha: model.alpha, beta: model.beta, gamma: model.gamma, mae: model.mae != null ? round(model.mae, 2) : null, rmse: round(model.rmse, 2),
      smape: model.smape != null ? round(model.smape, 1) : null, mase: model.mase != null ? round(model.mase, 2) : null,
      biasPct: sumY > 0 && model.sumAbsErr ? round((model.sumErr / sumY) * 100, 1) : null,
      accuracyPct: sumY > 0 && model.sumAbsErr ? round(Math.max(0, 100 - (model.sumAbsErr / sumY) * 100), 1) : null,
      lastMonthActual: round(lastActual, 2), lastMonthPlan: lastFc != null ? round(Math.max(0, lastFc), 2) : null,
      lastMonthErrPct: lastFc != null && lastActual > 0 ? round(((lastActual - Math.max(0, lastFc)) / lastActual) * 100, 1) : null,
      overrides: Object.keys(ov).length, orderQty: plans.reduce((a, x) => a + x.qty, 0),
      _full: full, _y0: firstNz, _fitted: model.fitted, _fc: fc, _proj: proj, _plans: plans, _poHist: histMonths.map(mo => poHist.get(code)?.get(mo) || 0),
    };
    fc.forEach((f, i) => { row[`f${i}`] = round(f.value, 2); row[`p${i}`] = round(proj[i].invC, 2); });
    row.orderValue = round(row.orderQty * unitCost);
    rows.push(row);
  }
  if (!rows.length) throw new AgentDataError(`No inventory items with ${source === 'orders' ? 'sales orders' : 'A/R invoices'} or open POs since ${from}${warehouse ? ` in ${warehouse}` : ''}.`);

  // ABC by forecast value over the horizon.
  const byVal = [...rows].sort((a, b) => b.horizonValue - a.horizonValue);
  const totVal = byVal.reduce((a, r) => a + r.horizonValue, 0) || 1;
  let cum = 0;
  for (const r of byVal) { cum += r.horizonValue; r.abc = r.horizonValue <= 0 ? '—' : cum / totVal <= 0.8 ? 'A' : cum / totVal <= 0.95 ? 'B' : 'C'; }

  // ── Procurement recommendations ───────────────────────────────────────────
  const recs = [];
  for (const r of rows) for (const pl of r._plans) {
    recs.push({
      itemCode: r.itemCode, itemName: r.itemName, abc: r.abc, vendor: r.vendor, month: monthLabel(pl.month), qty: pl.qty,
      value: round(pl.qty * r.unitCost), orderBy: pl.orderBy, needBy: pl.needBy, leadTime: r.leadTime, lateDays: pl.lateDays,
      urgency: pl.lateDays > 0 ? 'EXPEDITE' : daysBetween(asOf, pl.orderBy) <= 14 ? 'ORDER NOW' : 'PLANNED',
      note: pl.lateDays > 0 ? `Order-by date passed ${pl.lateDays}d ago — normal lead time cannot cover ${monthLabel(pl.month)}; expedite or split` : `Arrives for ${monthLabel(pl.month)} if ordered by ${pl.orderBy}`,
    });
  }
  const urgRank = { EXPEDITE: 0, 'ORDER NOW': 1, PLANNED: 2 };
  recs.sort((a, b) => urgRank[a.urgency] - urgRank[b.urgency] || a.orderBy.localeCompare(b.orderBy) || b.value - a.value);

  // ── Open PO supply with RAG ───────────────────────────────────────────────
  const poRows = po.lines.filter(l => items.has(l.itemCode)).map(l => {
    const late = l.arrival && l.arrival < asOf;
    return {
      docNum: l.docNum, cardName: l.cardName, cardCode: l.cardCode, itemCode: l.itemCode, itemName: items.get(l.itemCode)?.itemName || '',
      openQty: round(l.openQty, 2), value: round(l.openQty * l.price), arrival: l.arrival, month: l.arrival ? monthLabel(l.arrival.slice(0, 7)) : '',
      arrivalStatus: late && daysBetween(l.arrival, asOf) > staleDays ? 'STALE' : late ? 'LATE' : daysBetween(asOf, l.arrival) <= 30 ? 'DUE 30D' : 'SCHEDULED', daysLate: late ? daysBetween(l.arrival, asOf) : null,
      deposit: l.deposit === undefined ? 'NOT TRACKED' : late ? '—' : l.deposit ? 'PAID' : 'NOT PAID', depositDate: l.deposit || '',
    };
  }).sort((a, b) => String(a.arrival).localeCompare(String(b.arrival)));

  // ── Timeline (focus item in qty, else all items in value) ─────────────────
  const focusRow = focus ? rows.find(r => r.itemCode.toLowerCase() === focus.toLowerCase()) : null;
  if (focus && !focusRow) throw new AgentDataError(`Item ${focus} has no demand or open POs in this window${groupFilter ? ' / group filter' : ''}.`);
  const set = focusRow ? [focusRow] : rows;
  const w = r => (focusRow ? 1 : r.unitCost);
  const showHist = histMonths.slice(-Math.min(historyMonths, 24));
  const offset = historyMonths - showHist.length;
  const timeline = [];
  showHist.forEach((mo, j) => {
    const i = offset + j;
    let actual = 0, fitted = 0, hasFit = false, supply = 0;
    for (const r of set) {
      actual += r._full[i] * w(r);
      supply += r._poHist[i] * w(r);
      const fi = r._y0 >= 0 ? i - r._y0 : -1;
      const fv = fi >= 0 ? r._fitted[fi] : null;
      if (fv != null) { fitted += Math.max(0, fv) * w(r); hasFit = true; }
    }
    timeline.push({ month: monthLabel(mo), key: mo, phase: 'Actual', actual: round(actual), forecast: hasFit ? round(fitted) : null, lower: null, upper: null, supply: round(supply), inventory: null, planned: null });
  });
  planMonths.forEach((mo, i) => {
    // Item errors are treated as independent, so band half-widths add in quadrature.
    let f = 0, hw2 = 0, supply = 0, inv = 0, planned = 0;
    for (const r of set) {
      f += r._fc[i].value * w(r); hw2 += (r._fc[i].hw * w(r)) ** 2;
      supply += r._proj[i].supply * w(r); inv += r._proj[i].invC * w(r); planned += r._proj[i].planned * w(r);
    }
    timeline.push({ month: monthLabel(mo), key: mo, phase: i === 0 ? 'Current (MTD)' : 'Forecast', actual: i === 0 ? round(set.reduce((a, r) => a + r.mtd * w(r), 0)) : null,
      forecast: round(f), lower: round(Math.max(0, f - Math.sqrt(hw2))), upper: round(f + Math.sqrt(hw2)), supply: round(supply), inventory: round(inv), planned: round(planned) });
  });
  const unitWord = focusRow ? 'qty' : 'value';

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const withHist = rows.filter(r => r.accuracyPct != null);
  const sumAbs = withHist.reduce((a, r) => a + (100 - r.accuracyPct) / 100 * r.histTotal * r.unitCost, 0);
  const sumErr = withHist.reduce((a, r) => a + (r.biasPct / 100) * r.histTotal * r.unitCost, 0);
  const sumAct = withHist.reduce((a, r) => a + r.histTotal * r.unitCost, 0) || 1;
  const accuracy = Math.max(0, 100 - (sumAbs / sumAct) * 100), bias = (sumErr / sumAct) * 100;
  const stockouts = rows.filter(r => r.status === 'STOCKOUT RISK');
  const belowMin = rows.filter(r => r.status === 'BELOW MIN');
  const excess = rows.filter(r => r.status === 'EXCESS');
  const nextValue = rows.reduce((a, r) => a + r.f0 * r.unitCost, 0);
  const horizonValue = rows.reduce((a, r) => a + r.horizonValue, 0);
  const poValue = poRows.filter(r => r.arrivalStatus !== 'STALE').reduce((a, r) => a + r.value, 0);
  const recValue = recs.reduce((a, r) => a + r.value, 0);
  const planMtdValue = rows.reduce((a, r) => a + r.expectedMtd * r.unitCost, 0);
  const mtdValue = rows.reduce((a, r) => a + r.mtd * r.unitCost, 0);
  const fast = rows.filter(r => r.paceStatus === 'FAST'), slow = rows.filter(r => r.paceStatus === 'SLOW');
  const latePo = poRows.filter(r => r.arrivalStatus === 'LATE');
  const stalePo = poRows.filter(r => r.arrivalStatus === 'STALE');
  const unpaid = poRows.filter(r => r.deposit === 'NOT PAID');

  // ── Tabs ──────────────────────────────────────────────────────────────────
  const idCols = [{ key: 'itemCode', label: 'Item', sub: 'itemName' },
    { key: 'abc', label: 'ABC', fmt: 'badge', badge: { A: 'purple', B: 'blue', C: 'grey' } }];
  const monthCols = (prefix, strongFirst) => planMonths.map((mo, i) => ({ key: `${prefix}${i}`, label: i === 0 ? `${monthLabel(mo)} (cur)` : monthLabel(mo), fmt: 'num', strong: strongFirst && i === 0 }));
  const STATUS_BADGE = { 'STOCKOUT RISK': 'red', 'BELOW MIN': 'amber', EXCESS: 'purple', 'LOW DATA': 'grey', OK: 'green', 'NO DEMAND': 'grey' };
  const riskRank = { 'STOCKOUT RISK': 0, 'BELOW MIN': 1, 'EXCESS': 2, 'LOW DATA': 3, OK: 4, 'NO DEMAND': 5 };
  const planRows = [...rows].sort((a, b) => b.horizonValue - a.horizonValue);
  const projRows = [...rows].sort((a, b) => riskRank[a.status] - riskRank[b.status] || 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc) || b.horizonValue - a.horizonValue);
  const paceRows = rows.filter(r => r.paceStatus !== 'NO PLAN').sort((a, b) => Math.abs(100 - (b.pace ?? 100)) * b.planThisMonth * b.unitCost - Math.abs(100 - (a.pace ?? 100)) * a.planThisMonth * a.unitCost);
  const accRows = withHist.concat(rows.filter(r => r.accuracyPct == null)).sort((a, b) => b.histTotal * b.unitCost - a.histTotal * a.unitCost);
  const focusAct = { id: 'focus', label: 'Chart', kind: 'focus', param: 'item', from: 'itemCode' };
  const overrideAct = { id: 'override', label: 'Override', kind: 'form', endpoint: '/api/demand-forecast-agent/override', refresh: true,
    fields: [{ key: 'month', label: `Month (YYYY-MM, ${planMonths[0]} … ${planMonths[planMonths.length - 1]})`, default: planMonths[1] || planMonths[0] },
      { key: 'qty', label: 'Forecast qty (leave blank to clear that month)' }] };
  const clearAct = { id: 'clear', label: 'Clear overrides', kind: 'post', endpoint: '/api/demand-forecast-agent/override/clear', refresh: true, confirm: 'Remove all manual forecast overrides for {itemCode}?' };

  const tabs = [
    { key: 'plan', label: `Demand plan (${rows.length})`, rows: planRows, actions: [focusAct, overrideAct],
      columns: [...idCols, { key: 'method', label: 'Model', sub: 'pattern' }, { key: 'last3Avg', label: 'Last 3m avg', fmt: 'num' },
        ...monthCols('f', true), { key: 'horizonDemand', label: `${horizon}m total`, fmt: 'num', strong: true },
        { key: 'horizonLower', label: `Low (${conf}%)`, fmt: 'num' }, { key: 'horizonUpper', label: `High (${conf}%)`, fmt: 'num' },
        { key: 'horizonValue', label: 'Plan value', fmt: 'amt' }, { key: 'overrides', label: 'Manual', fmt: 'int', hint: 'Months with a manual forecast override' }] },
    { key: 'projection', label: `Inventory projection (${stockouts.length + belowMin.length} at risk)`, rows: projRows, actions: [focusAct],
      columns: [{ key: 'status', label: 'Status', fmt: 'badge', badge: STATUS_BADGE }, ...idCols, { key: 'onHand', label: 'On hand', fmt: 'num' },
        { key: 'committed', label: 'Committed (SO)', fmt: 'num', hint: 'Open sales orders — informational; the projection uses the forecast' },
        { key: 'openPo', label: 'Open PO', fmt: 'num' }, { key: 'minInv', label: 'Min inv.', fmt: 'num', hint: `Daily forecast × lead time × (1 + ${marginPct}%)` },
        ...monthCols('p', false), { key: 'firstShort', label: 'Stock-out' }, { key: 'coverMonths', label: 'Cover (m)', fmt: 'num' },
        { key: 'leadTime', label: 'Lead (d)', fmt: 'int', sub: 'leadTimeSource' }] },
    { key: 'orders', label: `Required orders (${recs.length})`, rows: recs,
      columns: [{ key: 'urgency', label: 'Urgency', fmt: 'badge', badge: { EXPEDITE: 'red', 'ORDER NOW': 'amber', PLANNED: 'blue' } }, ...idCols,
        { key: 'vendor', label: 'Pref. vendor' }, { key: 'month', label: 'Needed in' }, { key: 'qty', label: 'Order qty', fmt: 'num', strong: true },
        { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'orderBy', label: 'Order by', fmt: 'date' }, { key: 'leadTime', label: 'Lead (d)', fmt: 'int' },
        { key: 'note', label: 'Note', wrap: true }] },
    { key: 'supply', label: `Open PO supply (${poRows.length})`, rows: poRows,
      columns: [{ key: 'arrivalStatus', label: 'Arrival', fmt: 'badge', badge: { STALE: 'grey', LATE: 'red', 'DUE 30D': 'amber', SCHEDULED: 'green' } },
        { key: 'docNum', label: 'PO #' }, { key: 'cardName', label: 'Vendor', sub: 'cardCode' }, { key: 'itemCode', label: 'Item', sub: 'itemName' },
        { key: 'openQty', label: 'Open qty', fmt: 'num' }, { key: 'value', label: 'Value', fmt: 'amt' }, { key: 'arrival', label: 'Arrival date', fmt: 'date' },
        { key: 'daysLate', label: 'Days late', fmt: 'int' },
        { key: 'deposit', label: 'Deposit', fmt: 'badge', sub: 'depositDate', badge: { PAID: 'green', 'NOT PAID': 'red', 'NOT TRACKED': 'grey' } }] },
    { key: 'pace', label: `Live vs plan — ${monthLabel(cur)} (${fast.length} fast / ${slow.length} slow)`, rows: paceRows, actions: [focusAct],
      columns: [{ key: 'paceStatus', label: 'Pace', fmt: 'badge', badge: { FAST: 'red', SLOW: 'amber', 'ON PLAN': 'green' } }, ...idCols,
        { key: 'planThisMonth', label: 'Plan (month)', fmt: 'num' }, { key: 'expectedMtd', label: `Expected by day ${dom}`, fmt: 'num' },
        { key: 'mtd', label: 'Actual MTD', fmt: 'num', strong: true }, { key: 'pace', label: 'Pace %', fmt: 'pct' },
        { key: 'onHand', label: 'On hand', fmt: 'num' }, { key: 'status', label: 'Stock status', fmt: 'badge', badge: STATUS_BADGE }] },
    { key: 'accuracy', label: 'Forecast accuracy', rows: accRows, actions: [focusAct, clearAct],
      columns: [...idCols, { key: 'method', label: 'Model', sub: 'pattern' }, { key: 'historyMonths', label: 'Months', fmt: 'int' },
        { key: 'alpha', label: 'Alpha', fmt: 'num' }, { key: 'beta', label: 'Beta', fmt: 'num' }, { key: 'gamma', label: 'Gamma', fmt: 'num' },
        { key: 'mae', label: 'MAE', fmt: 'num' }, { key: 'rmse', label: 'RMSE', fmt: 'num' }, { key: 'smape', label: 'SMAPE %', fmt: 'pct' }, { key: 'mase', label: 'MASE', fmt: 'num' },
        { key: 'accuracyPct', label: 'Accuracy %', fmt: 'pct', strong: true }, { key: 'biasPct', label: 'Bias %', fmt: 'pct', hint: '+ = under-forecast (stock-out risk), − = over-forecast (cash tied up)' },
        { key: 'lastMonthPlan', label: `${monthLabel(addMonths(cur, -1))} plan`, fmt: 'num' }, { key: 'lastMonthActual', label: 'Actual', fmt: 'num' },
        { key: 'lastMonthErrPct', label: 'Error %', fmt: 'pct' }] },
    { key: 'timeline', label: `Timeline — ${focusRow ? focusRow.itemCode : 'all items (value)'}`, rows: timeline,
      columns: [{ key: 'month', label: 'Month' }, { key: 'phase', label: 'Phase', fmt: 'badge', badge: { Actual: 'grey', 'Current (MTD)': 'amber', Forecast: 'blue' } },
        { key: 'actual', label: `Actual ${unitWord}`, fmt: 'num' }, { key: 'forecast', label: 'Forecast', fmt: 'num', strong: true },
        { key: 'lower', label: `Lower (${conf}%)`, fmt: 'num' }, { key: 'upper', label: `Upper (${conf}%)`, fmt: 'num' },
        { key: 'supply', label: 'Supply (PO)', fmt: 'num' }, { key: 'inventory', label: 'Projected inventory', fmt: 'num' },
        { key: 'planned', label: 'Required order', fmt: 'num' }] },
  ];
  for (const r of rows) for (const kk of Object.keys(r)) if (kk.startsWith('_')) delete r[kk];

  // ── Narrative ─────────────────────────────────────────────────────────────
  const topOut = [...stockouts].sort((a, b) => 'ABC'.indexOf(a.abc) - 'ABC'.indexOf(b.abc) || b.horizonValue - a.horizonValue)[0];
  const topRec = recs[0];
  const insight = `**${horizon}-month demand plan ${fmtAmt(horizonValue)} across ${rows.length} items; ${stockouts.length} items run out and ${belowMin.length} dip below min inventory on confirmed supply.**\n\n` +
    (topOut ? `- Most urgent: **${topOut.itemCode}** ${topOut.itemName} (class ${topOut.abc}) runs out in **${topOut.firstShort}** — on hand ${topOut.onHand}, open PO ${topOut.openPo}.\n` : '') +
    (topRec ? `- ${recs.filter(r => r.urgency !== 'PLANNED').length} orders to place now (${recs.filter(r => r.urgency === 'EXPEDITE').length} past their order-by date); total required ${fmtAmt(recValue)}.\n` : '') +
    `- Forecast accuracy ${round(accuracy, 1)}% with bias ${bias >= 0 ? '+' : ''}${round(bias, 1)}% (${bias >= 0 ? 'under-forecasting → stock-out risk' : 'over-forecasting → cash tied up'}).\n` +
    `- ${monthLabel(cur)} to day ${dom}: ${fmtAmt(mtdValue)} shipped vs ${fmtAmt(planMtdValue)} expected — ${fast.length} items selling fast, ${slow.length} slow.\n` +
    (latePo.length ? `- ${latePo.length} open PO lines are past their arrival date and counted as ${monthLabel(cur)} supply — confirm new ETAs.\n` : '') +
    (stalePo.length ? `- ${stalePo.length} open PO lines are over ${staleDays} days late and **excluded** from supply — close them in SAP or update the dates.\n` : '') +
    (unpaid.length ? `- ${unpaid.length} upcoming PO lines have no deposit recorded.\n` : '') +
    (excess.length ? `- ${excess.length} items hold more than ${excessMonths} months of cover (${fmtAmt(excess.reduce((a, r) => a + r.stockValue, 0))} stock value).\n` : '');

  const aiContext = `SUPPLY CHAIN DEMAND FORECAST as of ${asOf}${warehouse ? `, warehouse ${warehouse}` : ''}${groupFilter ? `, group ~ "${p.group}"` : ''}. Demand source: ${source === 'orders' ? 'sales orders' : 'A/R invoices net of credit memos'}. History ${historyMonths}m, horizon ${horizon}m (month 1 = ${monthLabel(cur)}, day ${dom}/${dim}), ${conf}% band, min inventory = daily forecast × lead time × (1+${marginPct}%).
Items ${rows.length}; plan value ${fmtAmt(horizonValue)}; next month value ${fmtAmt(nextValue)}; open PO value ${fmtAmt(poValue)}; required orders ${recs.length} (${fmtAmt(recValue)}); stock-out ${stockouts.length}; below min ${belowMin.length}; excess ${excess.length}; accuracy ${round(accuracy, 1)}%, bias ${round(bias, 1)}% (+ = under-forecast); MTD ${fmtAmt(mtdValue)} vs expected ${fmtAmt(planMtdValue)}; late PO lines ${latePo.length}; stale PO lines excluded ${stalePo.length}; unpaid deposits ${unpaid.length}.
AT RISK:
${ctxTable(projRows.filter(r => r.status === 'STOCKOUT RISK' || r.status === 'BELOW MIN'), [['itemCode', 'Item'], ['abc', 'ABC'], ['status', 'Status'], ['onHand', 'OnHand'], ['openPo', 'OpenPO'], ['minInv', 'MinInv'], ['firstShort', 'StockOut'], ['leadTime', 'LT']], 20)}
REQUIRED ORDERS:
${ctxTable(recs, [['urgency', 'Urgency'], ['itemCode', 'Item'], ['vendor', 'Vendor'], ['month', 'NeededIn'], ['qty', 'Qty'], ['value', 'Value'], ['orderBy', 'OrderBy']], 20)}
DEMAND PLAN (top by value):
${ctxTable(planRows, [['itemCode', 'Item'], ['method', 'Model'], ['last3Avg', 'Last3mAvg'], ['f0', monthLabel(planMonths[0])], ['f1', monthLabel(planMonths[1])], ['f2', monthLabel(planMonths[2])], ['horizonDemand', `${horizon}mTotal`], ['accuracyPct', 'Acc%'], ['biasPct', 'Bias%']], 20)}
PACE THIS MONTH:
${ctxTable(paceRows, [['itemCode', 'Item'], ['paceStatus', 'Pace'], ['planThisMonth', 'Plan'], ['mtd', 'MTD'], ['pace', 'Pace%']], 12)}
${latePo.length ? `LATE PO LINES:\n${ctxTable(latePo, [['docNum', 'PO'], ['cardName', 'Vendor'], ['itemCode', 'Item'], ['openQty', 'Qty'], ['daysLate', 'DaysLate'], ['deposit', 'Deposit']], 12)}` : ''}`;

  return {
    kpis: [
      { label: 'Items planned', value: rows.length, fmt: 'int' },
      { label: `Demand plan (${horizon}m)`, value: horizonValue, fmt: 'amt', hint: 'Forecast qty × item cost' },
      { label: `Plan ${monthLabel(planMonths[1] || cur)}`, value: rows.reduce((a, r) => a + (r.f1 ?? 0) * r.unitCost, 0), fmt: 'amt' },
      { label: 'Open PO supply', value: poValue, fmt: 'amt', tone: latePo.length ? 'warn' : '' , hint: `Excludes stale lines; ${latePo.length} lines late` },
      { label: 'Stock-out risk', value: stockouts.length, fmt: 'int', tone: stockouts.length ? 'bad' : 'good' },
      { label: 'Below min inventory', value: belowMin.length, fmt: 'int', tone: belowMin.length ? 'warn' : 'good' },
      { label: 'Required order value', value: recValue, fmt: 'amt', tone: recs.some(r => r.urgency === 'EXPEDITE') ? 'bad' : '' },
      { label: 'Forecast accuracy', value: accuracy, fmt: 'pct', tone: accuracy >= 70 ? 'good' : accuracy >= 50 ? 'warn' : 'bad', hint: '100 − WAPE, value weighted, in-sample one-step-ahead' },
      { label: 'Forecast bias', value: bias, fmt: 'pct', tone: Math.abs(bias) <= 10 ? 'good' : 'warn', hint: '+ under-forecast / − over-forecast' },
      { label: `MTD pace ${monthLabel(cur)}`, value: planMtdValue > 0 ? (mtdValue / planMtdValue) * 100 : null, fmt: 'pct' },
    ],
    chart: {
      title: focusRow ? `${focusRow.itemCode} — ${focusRow.itemName} (qty)` : 'All items — demand, supply & projected inventory (value)',
      type: 'bar', labels: timeline.map(t => t.month),
      series: [
        { name: 'Actual demand', values: timeline.map(t => t.actual), color: '#0F766E' },
        { name: 'Supply (PO)', values: timeline.map(t => t.supply), color: '#CBD5E1' },
        { name: 'Forecast', type: 'line', values: timeline.map(t => t.forecast), color: '#2563EB' },
        { name: `Lower ${conf}%`, type: 'line', values: timeline.map(t => t.lower), color: '#93C5FD' },
        { name: `Upper ${conf}%`, type: 'line', values: timeline.map(t => t.upper), color: '#93C5FD' },
        { name: 'Projected inventory', type: 'line', values: timeline.map(t => t.inventory), color: '#D97706' },
      ],
    },
    tabs, insight, aiContext,
    paramsOut: { item: focusRow ? focusRow.itemCode : '' },
    notes: [
      `Actual demand = ${source === 'orders' ? 'sales-order quantity by posting month' : 'A/R invoice quantity − A/R credit memos by posting month'} (inventory UoM)${warehouse ? `, warehouse ${warehouse}` : ''}. ${monthLabel(cur)} is month-to-date; models are fitted on completed months only.`,
      `Forecast = exponential smoothing per item (Holt-Winters with 12-month season when ≥ 24 months of history, else Holt trend or simple; chosen by AIC, trend damped φ=${PHI}), like Excel FORECAST.ETS. Band = ±${Z[conf]}·RMSE widened by horizon. Accuracy/bias are in-sample one-step-ahead.`,
      `Supply = open PO quantity by arrival (${po.usedArrival}); late POs count in ${monthLabel(cur)}; lines more than ${staleDays} days late are treated as stale and excluded. Deposit RAG ${po.usedDeposit ? `from ${po.usedDeposit}` : 'is off — set "PO deposit UDF" (e.g. U_DepositDate)'}. Projection = on hand + supply − forecast (remaining forecast for ${monthLabel(cur)}).`,
      `Min inventory = max(SAP min level, daily forecast × lead time × (1 + ${marginPct}%)); lead time from the item master, else ${defaultLT} days. Required orders are lot-for-lot, rounded up to the item's minimum order qty / order multiple.`,
    ],
  };
}

export function createDemandForecastAgentRouter(deps) {
  return createInsightRouter(deps, {
    slug: 'scforecast', title: 'Supply Chain Demand Forecast Agent',
    defaults: { historyMonths: 36, horizonMonths: 12, confidence: 95, safetyMarginPct: 25, defaultLeadTime: 30, excessMonths: 6, stalePoDays: 180, demandSource: 'invoices' },
    persona: 'You are an S&OP demand and supply planner for a company running SAP Business One.',
    aiTask: 'Review this demand & supply forecast for the S&OP meeting. Summarise the rolling demand plan, which items will stock out or fall below minimum inventory and when, what must be ordered now (quantities, vendors, order-by dates), items selling faster or slower than plan this month, late POs and unpaid deposits, and where the forecast is least reliable.',
    run,
    extra(router, h) {
      const company = () => h.kit().company;
      router.post('/override', h.requireAuth, (req, res) => {
        try {
          const { row = {}, values = {} } = req.body || {};
          const month = String(values.month || '').trim();
          if (!row.itemCode) return res.status(400).json({ ok: false, error: 'Item required.' });
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ ok: false, error: 'Month must be YYYY-MM.' });
          const s = agentSettingsRepo.get(company(), SETTINGS_KEY);
          const ov = s.overrides || {};
          const item = ov[row.itemCode] || {};
          const raw = String(values.qty ?? '').trim();
          if (raw === '') delete item[month];
          else {
            const q = Number(raw);
            if (!Number.isFinite(q) || q < 0) return res.status(400).json({ ok: false, error: 'Quantity must be a number ≥ 0.' });
            item[month] = q;
          }
          if (Object.keys(item).length) ov[row.itemCode] = item; else delete ov[row.itemCode];
          agentSettingsRepo.set(company(), SETTINGS_KEY, { ...s, overrides: ov });
          res.json({ ok: true, message: raw === '' ? `Override for ${row.itemCode} ${month} cleared.` : `${row.itemCode} ${month} forecast set to ${raw}.` });
        } catch (e) { res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message }); }
      });
      router.post('/override/clear', h.requireAuth, (req, res) => {
        try {
          const code = req.body?.row?.itemCode;
          if (!code) return res.status(400).json({ ok: false, error: 'Item required.' });
          const s = agentSettingsRepo.get(company(), SETTINGS_KEY);
          const ov = s.overrides || {};
          delete ov[code];
          agentSettingsRepo.set(company(), SETTINGS_KEY, { ...s, overrides: ov });
          res.json({ ok: true, message: `Manual overrides for ${code} removed.` });
        } catch (e) { res.status(e instanceof AgentDataError ? 400 : 500).json({ ok: false, error: e.message }); }
      });
    },
  });
}
