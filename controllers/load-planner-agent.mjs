/**
 * Load Planner Agent — backend controller
 * Mounted at /api/load-planner by chat-server.mjs (UI: public/load-planner.html)
 *
 * Simulates how the cartons of open Sales Orders fill pallets and 20ft / 40ft / 40ft HC
 * containers. The packing itself runs in the browser (public/load-packer.js, in a worker);
 * this router supplies the SAP data and the AI loading advice:
 *
 *  GET  /orders?search=&from=&to=   open Sales Orders
 *  POST /lines  { docEntries }      open lines + item packaging (Item Master → Sales Data:
 *                                   length / width / height / weight, qty per package),
 *                                   converted to cm / kg
 *  POST /advice { result, items }   rule checks + AI loading brief for a simulated plan
 * Read-only — nothing is written to SAP.
 */

import { Router } from 'express';

const esc = s => String(s || '').replace(/'/g, "''");
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const MAX_LIST = 500;
const MAX_ORDERS = 25;

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
  } catch (e) { console.warn('[LoadPlanner] AI call failed:', e.message); }
  return '';
}

// Service Layer caps each page regardless of $top, so walk $skip until a short page.
async function fetchAllPaginated(sap, path, params, { pageSize = 100, maxItems = MAX_LIST } = {}) {
  const all = [];
  while (all.length < maxItems) {
    const r = await sap.get(path, { ...params, $top: pageSize, $skip: all.length });
    const batch = r.value || [];
    all.push(...batch);
    if (!batch.length || !(r['odata.nextLink'] || r['@odata.nextLink'] || batch.length === pageSize)) break;
  }
  return all.slice(0, maxItems);
}

// ── Units of measure (OLGT / OWGT) → cm / kg ──────────────────────────────────
async function unitFactors(sap) {
  const len = new Map(), wt = new Map();
  try {
    for (const u of (await sap.get('/LengthMeasures')).value || []) {
      const mm = Number(u.UnitLengthinmm);
      if (mm > 0) len.set(u.UnitCode, { cm: mm / 10, label: u.UnitDisplay || u.UnitName || '' });
    }
  } catch (e) { console.warn('[LoadPlanner] LengthMeasures unavailable:', e.message); }
  try {
    for (const u of (await sap.get('/WeightMeasures')).value || []) {
      const mg = Number(u.UnitWeightinmg);
      if (mg > 0) wt.set(u.UnitCode, { kg: mg / 1e6, label: u.UnitDisplay || u.UnitName || '' });
    }
  } catch (e) { console.warn('[LoadPlanner] WeightMeasures unavailable:', e.message); }
  return { len, wt };
}

const ITEM_FIELDS = [
  'ItemCode', 'ItemName', 'SalesUnit', 'SalesItemsPerUnit', 'SalesPackagingUnit', 'SalesQtyPerPackUnit',
  'SalesUnitLength', 'SalesLengthUnit', 'SalesUnitWidth', 'SalesWidthUnit',
  'SalesUnitHeight', 'SalesHeightUnit', 'SalesUnitWeight', 'SalesWeightUnit',
];

async function fetchItems(sap, codes) {
  const out = new Map();
  for (let i = 0; i < codes.length; i += 20) {
    const chunk = codes.slice(i, i + 20);
    const filter = chunk.map(c => `ItemCode eq '${esc(c)}'`).join(' or ');
    try {
      const rows = await fetchAllPaginated(sap, '/Items', { $filter: filter, $select: ITEM_FIELDS.join(',') }, { maxItems: 20 });
      rows.forEach(r => out.set(r.ItemCode, r));
    } catch {
      // Some Service Layer versions reject a field in the $select — read the items whole instead.
      for (const c of chunk) {
        try { out.set(c, await sap.get(`/Items('${esc(c)}')`)); } catch (e) { console.warn('[LoadPlanner] item', c, e.message); }
      }
    }
  }
  return out;
}

function packaging(item, units) {
  const conv = (v, code) => {
    const n = Number(v || 0);
    if (!(n > 0)) return 0;
    const f = units.len.get(code);
    return +(f ? n * f.cm : n).toFixed(1);       // no unit set → read as cm
  };
  const kgOf = (v, code) => {
    const n = Number(v || 0);
    if (!(n > 0)) return 0;
    const f = units.wt.get(code);
    return +(f ? n * f.kg : n).toFixed(2);       // no unit set → read as kg
  };
  const l = conv(item?.SalesUnitLength, item?.SalesLengthUnit);
  const w = conv(item?.SalesUnitWidth, item?.SalesWidthUnit);
  const h = conv(item?.SalesUnitHeight, item?.SalesHeightUnit);
  const kg = kgOf(item?.SalesUnitWeight, item?.SalesWeightUnit);
  return { l, w, h, kg, perCarton: Number(item?.SalesQtyPerPackUnit) > 0 ? Number(item.SalesQtyPerPackUnit) : 1,
    packUnit: item?.SalesPackagingUnit || '', salesUnit: item?.SalesUnit || '', hasDims: l > 0 && w > 0 && h > 0 };
}

// ── Rule checks on a simulated plan (always available, AI or not) ─────────────
function ruleChecks(result, items) {
  const notes = [];
  const add = (level, text) => notes.push({ level, text });
  const part = result?.containers || result?.pallets;
  if (!part) return notes;
  const spaces = part.spaces || [];
  const label = result.containers ? result.containers.spec?.name || 'container' : 'pallet';

  const unpacked = (part.unpacked || []).reduce((s, u) => s + u.cartons, 0)
    + (result.pallets && result.containers ? (result.pallets.unpacked || []).reduce((s, u) => s + u.cartons, 0) : 0);
  if (unpacked) add('critical', `${unpacked} carton(s) did not fit — see "Not loaded". Check their dimensions or choose a larger space.`);

  const missing = (items || []).filter(i => !(i.l > 0 && i.w > 0 && i.h > 0));
  if (missing.length) add('serious', `${missing.length} item(s) have no carton dimensions and were left out: ${missing.slice(0, 5).map(i => i.code).join(', ')}${missing.length > 5 ? '…' : ''}.`);
  const noWeight = (items || []).filter(i => i.l > 0 && !(i.kg > 0));
  if (noWeight.length) add('serious', `${noWeight.length} item(s) have no carton weight — weight limits and balance are understated.`);

  spaces.forEach((s, i) => {
    const n = spaces.length > 1 ? ` #${i + 1}` : '';
    if (s.weightPct > 95) add('serious', `${label}${n} is at ${s.weightPct}% of its payload — weight, not space, is the limit.`);
    if (result.containers && s.cog && Math.abs(s.cog.x) > 10) add('serious', `${label}${n}: centre of gravity is ${Math.abs(s.cog.x)}% toward the ${s.cog.x > 0 ? 'doors' : 'front wall'} — move heavy cartons toward the middle.`);
    if (result.containers && s.cog && Math.abs(s.cog.y) > 5) add('serious', `${label}${n}: load leans ${Math.abs(s.cog.y)}% to one side — balance left and right.`);
  });

  if (result.containers && spaces.length > 1) {
    const last = spaces[spaces.length - 1];
    if (last.fillPct < 35) {
      const smaller = result.containers.spec?.code?.startsWith('40') ? 'a 20ft container' : 'LCL / a truck';
      add('info', `The last ${label} is only ${last.fillPct}% full — consider ${smaller} for the remainder, or move those cartons to the next shipment.`);
    }
  }
  if (result.containers && spaces.length === 1 && spaces[0].fillPct < 45 && result.containers.spec?.code?.startsWith('40'))
    add('info', `Only ${spaces[0].fillPct}% of the ${label} is used — check whether a 20ft container takes this load.`);
  if (!notes.length) add('good', 'No issues found: everything fits within volume, payload and stacking limits.');
  return notes;
}

export function createLoadPlannerRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  // ── Open Sales Orders ───────────────────────────────────────────────────────
  router.get('/orders', requireAuth, async (req, res) => {
    const { search = '', from = '', to = '' } = req.query;
    const filters = [`DocumentStatus eq 'bost_Open'`, `Cancelled eq 'tNO'`];
    if (isDate(from)) filters.push(`DocDueDate ge '${from}'`);
    if (isDate(to))   filters.push(`DocDueDate le '${to}'`);
    const term = String(search).trim().slice(0, 60);
    if (term) {
      const t = esc(term);
      const parts = [`contains(CardName,'${t}')`, `contains(CardCode,'${t}')`, `contains(NumAtCard,'${t}')`];
      if (/^\d+$/.test(term)) parts.push(`DocNum eq ${parseInt(term, 10)}`);
      filters.push(`(${parts.join(' or ')})`);
    }
    try {
      const docs = await fetchAllPaginated(getActiveSap(), '/Orders', {
        $filter: filters.join(' and '),
        $select: 'DocEntry,DocNum,CardCode,CardName,DocDate,DocDueDate,NumAtCard,DocTotal,DocCurrency,Address2',
        $orderby: 'DocDueDate asc,DocNum asc',
      });
      res.json({ ok: true, truncated: docs.length >= MAX_LIST, orders: docs.map(d => ({
        docEntry: d.DocEntry, docNum: d.DocNum, cardCode: d.CardCode, cardName: d.CardName,
        docDate: String(d.DocDate || '').slice(0, 10), dueDate: String(d.DocDueDate || '').slice(0, 10),
        customerRef: d.NumAtCard || '', total: Number(d.DocTotal || 0), currency: d.DocCurrency || '',
        shipTo: String(d.Address2 || '').split(/\r?\n/)[0],
      })) });
    } catch (e) {
      res.status(502).json({ error: `Could not read Sales Orders from SAP: ${e.message}` });
    }
  });

  // ── Open lines + carton packaging for the selected orders ───────────────────
  router.post('/lines', requireAuth, async (req, res) => {
    const docEntries = [...new Set((req.body?.docEntries || []).map(n => parseInt(n, 10)).filter(n => n > 0))];
    if (!docEntries.length) return res.status(400).json({ error: 'Select at least one Sales Order' });
    if (docEntries.length > MAX_ORDERS) return res.status(400).json({ error: `Select at most ${MAX_ORDERS} Sales Orders at a time` });
    try {
      const sap = getActiveSap();
      const [docs, units] = await Promise.all([
        Promise.all(docEntries.map(de => sap.get(`/Orders(${de})`, { $select: 'DocEntry,DocNum,CardCode,CardName,DocDueDate,DocumentLines' }))),
        unitFactors(sap),
      ]);
      const lines = [];
      for (const d of docs) {
        for (const l of d.DocumentLines || []) {
          if (l.LineStatus && l.LineStatus !== 'bost_Open') continue;
          const qty = Number(l.RemainingOpenQuantity ?? l.Quantity ?? 0);
          if (!(qty > 0) || !l.ItemCode) continue;
          lines.push({ docEntry: d.DocEntry, docNum: d.DocNum, cardName: d.CardName, dueDate: String(d.DocDueDate || '').slice(0, 10),
            lineNum: l.LineNum, itemCode: l.ItemCode, itemName: l.ItemDescription || '', qty, uom: l.UoMCode || l.MeasureUnit || '' });
        }
      }
      const items = await fetchItems(sap, [...new Set(lines.map(l => l.itemCode))]);
      for (const l of lines) {
        const it = items.get(l.itemCode);
        Object.assign(l, packaging(it, units));
        if (!l.itemName && it?.ItemName) l.itemName = it.ItemName;
      }
      res.json({ ok: true, lines, unitsKnown: units.len.size > 0 && units.wt.size > 0 });
    } catch (e) {
      res.status(502).json({ error: `Could not read order lines from SAP: ${e.message}` });
    }
  });

  // ── Advice on a simulated plan ──────────────────────────────────────────────
  router.post('/advice', requireAuth, async (req, res) => {
    const { result, items = [], compare = [] } = req.body || {};
    if (!result) return res.status(400).json({ error: 'No simulation result' });
    const checks = ruleChecks(result, items);

    // Compact plan for the model: no box coordinates, just the numbers that matter.
    const brief = sp => sp && ({
      type: sp.spec?.name, strategy: sp.strategy,
      spaces: (sp.spaces || []).map(s => ({ cartons: s.count, fillPct: s.fillPct, kg: s.kg, weightPct: s.weightPct, usedHeightCm: s.usedH, usedLengthCm: s.usedL, cog: s.cog })),
      notLoaded: sp.unpacked,
    });
    const plan = {
      mode: result.mode, cartons: result.cartons, totalKg: result.totalKg, totalM3: result.totalM3,
      pallets: brief(result.pallets), containers: brief(result.containers), containerOptions: compare,
      items: items.slice(0, 60).map(i => ({ code: i.code, name: i.name, order: i.ref, cartons: i.cartons, cartonCm: `${i.l}x${i.w}x${i.h}`, kg: i.kg, stackable: i.stackable, canTurn: i.canTurn })),
    };
    const ai = await callAI(deps, [{ role: 'user', content: `Load plan simulation:\n${JSON.stringify(plan)}\n\nRule checks already shown to the user:\n${checks.map(c => `- ${c.text}`).join('\n')}` }],
      'You are an export logistics load-planning expert. Given a carton/pallet/container load simulation, write a short loading brief in markdown for the warehouse supervisor: ' +
      '(1) a one-line verdict on the container/pallet choice, using containerOptions when present; (2) the loading order — which items go in first at the front wall, what goes on top, what goes near the doors; ' +
      '(3) stability, weight-distribution and damage risks (heavy on top, non-stackable items, centre of gravity); (4) one or two concrete ways to save space or cost. ' +
      'Use only the numbers given. At most 180 words, bullet points, no preamble, no tables.', 700);
    res.json({ ok: true, checks, ai });
  });

  return router;
}
