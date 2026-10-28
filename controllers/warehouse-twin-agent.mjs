/**
 * Warehouse Digital Twin — backend controller
 * Mounted at /api/warehouse-twin by chat-server.mjs (UI: public/warehouse-twin.html)
 *
 * 3D view of a warehouse (default 17SH): aisles, racks, shelf levels and bins, with the
 * stock that sits in each bin. The 3D layout, item search and "what-if" re-slotting run in
 * the browser; this router supplies the SAP data, the saved layout and the AI brief:
 *
 *  GET  /warehouses             warehouses (bin-enabled flag)
 *  GET  /stock?whs=17SH         bins + stock per bin. Source, best first:
 *                                 'bins'    — OBIN / OIBQ (+ OBBQ batches, OINM pick frequency) via DB Direct
 *                                 'slotted' — warehouse stock only (OITW or Service Layer); the UI
 *                                             places it on a generated rack layout as a simulation
 *                                 'demo'    — no SAP data reachable: generated sample warehouse
 *  GET  /layout?whs=            saved layout settings (data/warehouse-twin/<whs>.json)
 *  PUT  /layout?whs=  {config}  save layout settings
 *  POST /advice { summary }     rule checks + AI brief on space use and slotting
 * Read-only towards SAP — moves are simulated in the UI and nothing is posted.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAYOUT_DIR = path.join(__dirname, '..', 'data', 'warehouse-twin');
const DEFAULT_WHS = '17SH';
const MAX_BINS = 20000;
const MAX_ITEMS = 3000;
const PICK_DAYS = 90;

const esc = s => String(s || '').replace(/'/g, "''");
const validWhs = s => /^[\w.-]{1,20}$/.test(String(s || ''));
function qcol(name, isHana) { return isHana ? `"${name}"` : name; }
const ymd = d => d.toISOString().slice(0, 10);

// ── AI helper ─────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, systemPrompt, maxTokens = 1200) {
  if (!aiDeps) return '';
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  try {
    if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
      const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
      return r.choices?.[0]?.message?.content || '';
    }
    if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
      const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
      const msgs  = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const ant  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await ant.messages.create({
        model: 'claude-sonnet-5-5', max_tokens: maxTokens,
        system: systemPrompt || undefined, messages,
      });
      return resp.content?.[0]?.text || '';
    }
  } catch (e) { console.warn('[WarehouseTwin] AI call failed:', e.message); }
  return '';
}

async function fetchAllPaginated(sap, p, params, { pageSize = 100, maxItems = MAX_ITEMS } = {}) {
  const all = [];
  while (all.length < maxItems) {
    const r = await sap.get(p, { ...params, $top: pageSize, $skip: all.length });
    const batch = r.value || [];
    all.push(...batch);
    if (!batch.length || !(r['odata.nextLink'] || r['@odata.nextLink'] || batch.length === pageSize)) break;
  }
  return all.slice(0, maxItems);
}

const isSystemBin = code => /SYSTEM-BIN-LOCATION$/i.test(String(code || ''));

// ── DB Direct: bins, bin stock, batches, pick frequency ──────────────────────
async function fetchViaDB(deps, whs) {
  const { isConnected, ensureConnected, getActiveConfig, getActiveType, tableRef, executeSQL } = deps;
  if (!executeSQL) return null;
  if (!isConnected?.() && ensureConnected) { try { await ensureConnected(); } catch (e) { console.warn('[WarehouseTwin] DB reconnect failed:', e.message); } }
  if (!isConnected?.()) return null;
  const cfg = getActiveConfig(), q = n => qcol(n, getActiveType() === 'hana'), T = n => tableRef(n, cfg);
  const w = esc(whs);

  const binRows = await executeSQL(
    `SELECT ${['AbsEntry', 'BinCode', 'SL1Code', 'SL2Code', 'SL3Code', 'SL4Code', 'Disabled'].map(q).join(', ')} ` +
    `FROM ${T('OBIN')} WHERE ${q('WhsCode')} = '${w}'`);
  const stockRows = await executeSQL(
    `SELECT Q.${q('BinAbs')} AS ${q('BinAbs')}, Q.${q('ItemCode')} AS ${q('ItemCode')}, Q.${q('OnHandQty')} AS ${q('Qty')}, ` +
    `I.${q('ItemName')} AS ${q('ItemName')}, I.${q('InvntryUom')} AS ${q('Uom')}, G.${q('ItmsGrpNam')} AS ${q('GroupName')} ` +
    `FROM ${T('OIBQ')} Q INNER JOIN ${T('OITM')} I ON I.${q('ItemCode')} = Q.${q('ItemCode')} ` +
    `LEFT JOIN ${T('OITB')} G ON G.${q('ItmsGrpCod')} = I.${q('ItmsGrpCod')} ` +
    `WHERE Q.${q('WhsCode')} = '${w}' AND Q.${q('OnHandQty')} > 0`);

  // Warehouse without bin locations → fall back to warehouse stock (OITW), placed by the UI.
  if (!binRows.length) {
    const rows = await executeSQL(
      `SELECT W.${q('ItemCode')} AS ${q('ItemCode')}, W.${q('OnHand')} AS ${q('Qty')}, I.${q('ItemName')} AS ${q('ItemName')}, ` +
      `I.${q('InvntryUom')} AS ${q('Uom')}, G.${q('ItmsGrpNam')} AS ${q('GroupName')} ` +
      `FROM ${T('OITW')} W INNER JOIN ${T('OITM')} I ON I.${q('ItemCode')} = W.${q('ItemCode')} ` +
      `LEFT JOIN ${T('OITB')} G ON G.${q('ItmsGrpCod')} = I.${q('ItmsGrpCod')} ` +
      `WHERE W.${q('WhsCode')} = '${w}' AND W.${q('OnHand')} > 0`);
    return { source: 'slotted', via: 'db', bins: [], items: rows.slice(0, MAX_ITEMS).map(r => ({
      itemCode: r.ItemCode, itemName: r.ItemName || '', qty: Number(r.Qty || 0), uom: r.Uom || '', group: r.GroupName || '' })),
      picks: await fetchPicksDB(deps, q, T, w) };
  }

  const batches = new Map();
  try {
    const rows = await executeSQL(
      `SELECT Q.${q('BinAbs')} AS ${q('BinAbs')}, Q.${q('ItemCode')} AS ${q('ItemCode')}, B.${q('DistNumber')} AS ${q('Batch')}, Q.${q('OnHandQty')} AS ${q('Qty')} ` +
      `FROM ${T('OBBQ')} Q INNER JOIN ${T('OBTN')} B ON B.${q('AbsEntry')} = Q.${q('SnBMDAbs')} ` +
      `WHERE Q.${q('WhsCode')} = '${w}' AND Q.${q('OnHandQty')} > 0`);
    for (const r of rows) {
      const k = `${r.BinAbs}|${r.ItemCode}`;
      if (!batches.has(k)) batches.set(k, []);
      batches.get(k).push({ batch: r.Batch, qty: Number(r.Qty || 0) });
    }
  } catch (e) { console.warn('[WarehouseTwin] batch-per-bin query skipped:', e.message); }

  const byBin = new Map();
  for (const r of stockRows) {
    if (!byBin.has(r.BinAbs)) byBin.set(r.BinAbs, []);
    byBin.get(r.BinAbs).push({ itemCode: r.ItemCode, itemName: r.ItemName || '', qty: Number(r.Qty || 0), uom: r.Uom || '',
      group: r.GroupName || '', batches: batches.get(`${r.BinAbs}|${r.ItemCode}`) || [] });
  }
  const bins = binRows.filter(b => !isSystemBin(b.BinCode)).slice(0, MAX_BINS).map(b => ({
    abs: b.AbsEntry, code: b.BinCode, sl: [b.SL1Code, b.SL2Code, b.SL3Code, b.SL4Code].map(s => s || ''),
    disabled: b.Disabled === 'Y', items: byBin.get(b.AbsEntry) || [],
  }));
  const sysStock = binRows.filter(b => isSystemBin(b.BinCode)).flatMap(b => byBin.get(b.AbsEntry) || []);
  return { source: 'bins', via: 'db', bins, items: [], unbinned: sysStock, picks: await fetchPicksDB(deps, q, T, w) };
}

// Pick frequency: outbound movements per item in the last PICK_DAYS days (OINM).
async function fetchPicksDB({ executeSQL }, q, T, w) {
  try {
    const since = ymd(new Date(Date.now() - PICK_DAYS * 864e5));
    const rows = await executeSQL(
      `SELECT ${q('ItemCode')} AS ${q('ItemCode')}, COUNT(*) AS ${q('Picks')}, SUM(${q('OutQty')}) AS ${q('OutQty')} ` +
      `FROM ${T('OINM')} WHERE ${q('Warehouse')} = '${w}' AND ${q('OutQty')} > 0 AND ${q('DocDate')} >= '${since}' GROUP BY ${q('ItemCode')}`);
    return Object.fromEntries(rows.map(r => [r.ItemCode, { picks: Number(r.Picks || 0), outQty: Number(r.OutQty || 0) }]));
  } catch (e) { console.warn('[WarehouseTwin] pick-frequency query skipped:', e.message); return {}; }
}

// ── Service Layer: bin structure + warehouse stock (no stock-per-bin entity in SL) ──
async function fetchViaSL(sap, whs) {
  const w = esc(whs);
  let bins = [];
  try {
    bins = (await fetchAllPaginated(sap, '/BinLocations', {
      $filter: `Warehouse eq '${w}'`, $select: 'AbsEntry,BinCode,Sublevel1,Sublevel2,Sublevel3,Sublevel4,Inactive',
    }, { maxItems: MAX_BINS })).filter(b => !isSystemBin(b.BinCode)).map(b => ({
      abs: b.AbsEntry, code: b.BinCode, sl: [b.Sublevel1, b.Sublevel2, b.Sublevel3, b.Sublevel4].map(s => s || ''),
      disabled: b.Inactive === 'tYES', items: [],
    }));
  } catch (e) { console.warn('[WarehouseTwin] BinLocations unavailable:', e.message); }

  let rows;
  try {
    rows = await fetchAllPaginated(sap, '/Items', {
      $filter: `ItemWarehouseInfoCollection/any(d: d/WarehouseCode eq '${w}' and d/InStock gt 0)`,
      $select: 'ItemCode,ItemName,ItemsGroupCode,InventoryUOM,ItemWarehouseInfoCollection',
    });
  } catch {
    // Older Service Layer without lambda filters — read stocked items and keep the warehouse line.
    rows = await fetchAllPaginated(sap, '/Items', {
      $filter: `QuantityOnStock gt 0`, $select: 'ItemCode,ItemName,ItemsGroupCode,InventoryUOM,ItemWarehouseInfoCollection',
    });
  }
  const groups = new Map();
  try { for (const g of await fetchAllPaginated(sap, '/ItemGroups', { $select: 'Number,GroupName' }, { maxItems: 1000 })) groups.set(g.Number, g.GroupName); } catch {}
  const items = rows.map(r => {
    const wi = (r.ItemWarehouseInfoCollection || []).find(x => x.WarehouseCode === whs);
    return { itemCode: r.ItemCode, itemName: r.ItemName || '', qty: Number(wi?.InStock || 0), uom: r.InventoryUOM || '', group: groups.get(r.ItemsGroupCode) || '' };
  }).filter(i => i.qty > 0);
  // Bins known but quantities per bin are not — the UI places the warehouse stock onto the real bins.
  return { source: 'slotted', via: 'sl', bins, items, picks: {} };
}

// ── Demo warehouse (no SAP reachable) ────────────────────────────────────────
function demoData(whs) {
  let seed = 17;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const groups = ['Fasteners', 'Bearings', 'Electricals', 'Hydraulics', 'Packaging', 'Spares', 'Paints', 'Tools'];
  const items = Array.from({ length: 60 }, (_, i) => {
    const g = groups[i % groups.length];
    return { itemCode: `ITM-${String(1001 + i)}`, itemName: `${g.replace(/s$/, '')} item ${1001 + i}`, uom: ['PCS', 'BOX', 'KG'][i % 3], group: g };
  });
  const picks = Object.fromEntries(items.map((it, i) => [it.itemCode, { picks: Math.round(200 * Math.pow(rnd(), 2.2) + (i < 8 ? 120 : 0)), outQty: 0 }]));
  const bins = [];
  let abs = 1;
  for (const a of ['A', 'B', 'C', 'D', 'E', 'F']) for (let r = 1; r <= 8; r++) for (let l = 1; l <= 4; l++) for (let p = 1; p <= 2; p++) {
    const filled = rnd() < 0.72;
    const its = [];
    if (filled) {
      const n = rnd() < 0.15 ? 2 : 1;
      for (let k = 0; k < n; k++) { const it = items[Math.floor(rnd() * items.length)]; its.push({ ...it, qty: Math.round(20 + rnd() * 380), batches: [] }); }
    }
    bins.push({ abs: abs++, code: `${whs}-${a}-${String(r).padStart(2, '0')}-${l}-${p}`, sl: [a, String(r).padStart(2, '0'), String(l), String(p)], disabled: false, items: its });
  }
  return { source: 'demo', via: 'demo', bins, items: [], picks };
}

// ── Rule checks on the client's summary ──────────────────────────────────────
function ruleChecks(s) {
  const notes = [];
  const add = (level, text) => notes.push({ level, text });
  if (!s) return notes;
  if (s.occupancyPct > 90) add('critical', `Occupancy is ${s.occupancyPct}% — fewer than 1 in 10 bins is free for receipts.`);
  else if (s.occupancyPct > 80) add('serious', `Occupancy is ${s.occupancyPct}% — plan space before the next large inbound.`);
  else if (s.occupancyPct < 40) add('info', `Only ${s.occupancyPct}% of bins are used — racks could be consolidated.`);
  for (const a of (s.aisles || []).filter(a => a.occupancyPct > 95)) add('serious', `Aisle ${a.aisle} is full (${a.occupancyPct}%) — receipts there will need overflow bins.`);
  if (s.mixedBins > 0) add('info', `${s.mixedBins} bin(s) hold more than one item — picking from them is slower and counting is error-prone.`);
  if (s.fastHigh > 0) add('serious', `${s.fastHigh} fast-moving item location(s) sit above level 2 — move them to ground/waist level near the dock.`);
  if (s.spread?.length) add('info', `${s.spread.length} item(s) are spread over 3+ part-full bins (e.g. ${s.spread.slice(0, 3).map(x => x.itemCode).join(', ')}) — consolidate to free bins.`);
  if (s.unbinnedQty > 0) add('serious', `Stock of ${s.unbinnedQty} is still in the system bin — put it away to a real bin.`);
  if (!notes.length) add('good', 'No issues found in occupancy or slotting.');
  return notes;
}

export function createWarehouseTwinRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  router.get('/warehouses', requireAuth, async (req, res) => {
    try {
      const rows = await fetchAllPaginated(getActiveSap(), '/Warehouses', {
        $filter: "Inactive eq 'tNO'", $select: 'WarehouseCode,WarehouseName,EnableBinLocations', $orderby: 'WarehouseCode asc',
      }, { maxItems: 500 });
      res.json({ ok: true, default: DEFAULT_WHS, warehouses: rows.map(w => ({ code: w.WarehouseCode, name: w.WarehouseName || '', bins: w.EnableBinLocations === 'tYES' })) });
    } catch (e) {
      res.json({ ok: true, default: DEFAULT_WHS, warehouses: [{ code: DEFAULT_WHS, name: '', bins: true }], warning: `Warehouse list unavailable: ${e.message}` });
    }
  });

  router.get('/stock', requireAuth, async (req, res) => {
    const whs = String(req.query.whs || DEFAULT_WHS).trim();
    if (!validWhs(whs)) return res.status(400).json({ error: 'Invalid warehouse code' });
    const notes = [];
    let data = null;
    try { data = await fetchViaDB(deps, whs); }
    catch (e) { notes.push(`DB Direct read failed (${e.message}) — trying the Service Layer.`); }
    if (!data || (data.source === 'slotted' && !data.items.length)) {
      try {
        const sl = await fetchViaSL(getActiveSap(), whs);
        if (sl.bins.length || sl.items.length) data = { ...sl, picks: data?.picks || {} };
      } catch (e) { notes.push(`Service Layer read failed: ${e.message}`); }
    }
    if (!data || (!data.bins.length && !data.items.length)) {
      if (req.query.demo === '0') return res.json({ ok: true, whs, source: 'empty', bins: [], items: [], picks: {}, notes: [...notes, `No stock found in warehouse ${whs}.`] });
      data = demoData(whs);
      notes.push(`No SAP stock could be read for ${whs} — showing a generated demo warehouse.`);
    }
    if (data.source === 'slotted') notes.push(data.bins.length
      ? 'SAP gives warehouse totals but not stock per bin here (connect DB Direct for OIBQ) — stock is placed on the real bins by simulation.'
      : `${whs} has no bin locations — stock is placed on a generated rack layout by simulation. Adjust the layout in "Layout designer".`);
    res.json({ ok: true, whs, ...data, notes, loadedAt: new Date().toISOString() });
  });

  router.get('/layout', requireAuth, (req, res) => {
    const whs = String(req.query.whs || DEFAULT_WHS);
    if (!validWhs(whs)) return res.status(400).json({ error: 'Invalid warehouse code' });
    try {
      const f = path.join(LAYOUT_DIR, `${whs}.json`);
      res.json({ ok: true, config: fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null });
    } catch (e) { res.status(500).json({ error: `Could not read layout: ${e.message}` }); }
  });

  router.put('/layout', requireAuth, (req, res) => {
    const whs = String(req.query.whs || DEFAULT_WHS);
    if (!validWhs(whs)) return res.status(400).json({ error: 'Invalid warehouse code' });
    const config = req.body?.config;
    if (!config || typeof config !== 'object') return res.status(400).json({ error: 'No layout config' });
    const text = JSON.stringify({ ...config, savedAt: new Date().toISOString() }, null, 2);
    if (text.length > 500000) return res.status(400).json({ error: 'Layout config too large' });
    try {
      fs.mkdirSync(LAYOUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(LAYOUT_DIR, `${whs}.json`), text);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: `Could not save layout: ${e.message}` }); }
  });

  router.post('/advice', requireAuth, async (req, res) => {
    const { summary } = req.body || {};
    if (!summary) return res.status(400).json({ error: 'No warehouse summary' });
    const checks = ruleChecks(summary);
    const ai = await callAI(deps, [{ role: 'user', content: `Warehouse snapshot:\n${JSON.stringify(summary).slice(0, 12000)}\n\nRule checks already shown to the user:\n${checks.map(c => `- ${c.text}`).join('\n')}` }],
      'You are a warehouse operations and slotting expert. Given a snapshot of a warehouse (bin occupancy by aisle and level, mixed bins, fast movers and where they sit, items spread over many bins, simulated moves), ' +
      'write a short brief in markdown for the warehouse manager: (1) a one-line verdict on space use; (2) the top slotting changes — which items to move closer to the dock / to lower levels and which bins to consolidate; ' +
      '(3) risks (full aisles, mixed bins, stock in system bins); (4) one quick win for this week. Use only the numbers and codes given. At most 180 words, bullet points, no preamble, no tables.', 700);
    res.json({ ok: true, checks, ai });
  });

  return router;
}
