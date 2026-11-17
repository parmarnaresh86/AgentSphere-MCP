/**
 * Purchase Request Chat Agent
 * Mounted at /api/pr-agent by chat-server.mjs
 *
 * State machine flow (existing SAP items only — no "New Item" option):
 *  INIT → ITEM_SEARCH → ITEM_SELECT → ITEM_QTY → WAREHOUSE (skip = default warehouse) → ADD_MORE_ITEMS
 *                                                               (loop) ↓ proceed
 *                                                         VENDOR → VENDOR_SELECT?
 *                                                               ↓
 *                                              DUE_DATE → COMMENTS → CONFIRM → POSTING → DONE
 */
import { Router } from 'express';
import { searchItems as searchItemsShared, searchVendors as searchVendorsShared } from '../lib/master-search.mjs';
import { buildReviewCard, readReviewPost } from '../lib/o2c-review.mjs';

const HEADER_KEYS = ['docDate', 'requiredDate', 'comments'];
const isIsoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// ── Session store ──────────────────────────────────────────────────────────────
const _sessions = new Map();

function initSession() {
  return {
    step: 'INIT',
    history: [],
    prLines: [],          // { itemCode, itemName, qty, unit, unitPrice, warehouseCode, isNew }
    currentItem: null,    // item being configured right now
    vendor: null,         // { cardCode, cardName }
    dueDate: null,
    comments: null,
    result: null,         // { docEntry, docNum } after posting
    _suggestedVendorCode: null,
    _vendorResults: null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sapDate(dateStr) {
  const d = dateStr || today();
  return d.length === 10 ? `${d}T00:00:00` : d;
}

function datePlusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseDate(str) {
  if (!str) return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2, '0')}-${m1[1].padStart(2, '0')}`;
  // MM/DD/YYYY
  const m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m2) {
    const yr = m2[3].length === 2 ? `20${m2[3]}` : m2[3];
    return `${yr}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  return null;
}

// ── AI helper (identical pattern to forecasting.mjs) ──────────────────────────
async function callAI(aiDeps, messages, system, maxTokens = 700) {
  if (!aiDeps?.USE_AI) return null;
  const { AI_PROVIDER, gptChatComplete, azureMessagesCreate } = aiDeps;
  try {
    if (AI_PROVIDER === 'gpt' && process.env.AZURE_GPT_ENDPOINT) {
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const r = await gptChatComplete({ messages: msgs, max_tokens: maxTokens });
      return r.choices?.[0]?.message?.content || null;
    }
    if (AI_PROVIDER === 'azure' && process.env.AZURE_OPENAI_API_KEY) {
      const model = process.env.AZURE_CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';
      const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || null;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system: system || undefined, messages,
      });
      return resp.content?.[0]?.text || null;
    }
  } catch (e) {
    console.error('[PR-Agent] AI error:', e.message);
  }
  return null;
}

// ── SAP helpers ────────────────────────────────────────────────────────────────
// Item / vendor search: the shared search (lib/master-search.mjs) — not case-sensitive,
// matches code or name by any keyword.
async function searchItems(sap, query, top = 15) {
  return searchItemsShared(sap, query, { top });
}

async function getItemDetails(sap, itemCode) {
  try {
    const esc = encodeURIComponent(String(itemCode).replace(/'/g, "''"));
    return await sap.get(`/Items('${esc}')`, {
      $select: 'ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,PurchaseUnit,SalesUnit,DefaultWarehouse',
    });
  } catch {
    return null;
  }
}

// Company default warehouse (Administration → General Settings), used when the user skips the warehouse
// and the item has no default warehouse of its own. Cached per process.
let _companyDefWhs;
async function companyDefaultWarehouse(sap) {
  if (_companyDefWhs !== undefined) return _companyDefWhs;
  try {
    const a = await sap.post('/CompanyService_GetAdminInfo', {});
    _companyDefWhs = a?.DefaultWarehouse || '';
  } catch (e) {
    console.error('[PR-Agent] admin info error:', e.message);
    return '';   // not cached — try again next time
  }
  return _companyDefWhs;
}

const itemListOf = rows => rows.map(it => ({
  code: it.ItemCode, name: it.ItemName,
  onStock: Number(it.QuantityOnStock || 0),
  minStock: Number(it.MinInventory || 0),
}));

// Active warehouses for the warehouse picker; the item's default warehouse goes first
async function getWarehouses(sap, defaultCode = '') {
  try {
    const r = await sap.get('/Warehouses', {
      $select: 'WarehouseCode,WarehouseName',
      $filter: "Inactive eq 'tNO'",
      $orderby: 'WarehouseCode asc',
      $top: 200,
    });
    const list = (Array.isArray(r.value) ? r.value : [])
      .map(w => ({ code: w.WarehouseCode, name: w.WarehouseName || '' }));
    const d = list.findIndex(w => w.code.toUpperCase() === String(defaultCode).toUpperCase());
    if (d > 0) list.unshift(...list.splice(d, 1));
    if (d >= 0) list[0] = { ...list[0], isDefault: true };
    return list;
  } catch (e) {
    console.error('[PR-Agent] warehouse list error:', e.message);
    return [];
  }
}

// Resolve user input ("01", "01 — Main", chip text) to a warehouse code from the list
function resolveWarehouse(msg, list) {
  const code = (msg.includes(' — ') ? msg.split(' — ')[0] : msg).trim();
  if (!list.length) return code.toUpperCase() || null;   // list unavailable — accept as typed
  const hit = list.find(w => w.code.toUpperCase() === code.toUpperCase())
           || list.find(w => w.name.toUpperCase() === code.toUpperCase());
  return hit ? hit.code : undefined;                       // undefined = not a valid warehouse
}

async function searchVendors(sap, query) {
  return searchVendorsShared(sap, query, { top: 20 });
}

// ── Inventory analysis renderer ────────────────────────────────────────────────
function renderInventoryAnalysis(item) {
  const onStock   = Number(item.QuantityOnStock             || 0);
  const committed = Number(item.QuantityOrderedByCustomers  || 0);
  const onOrder   = Number(item.QuantityOrderedFromVendors  || 0);
  const available = onStock - committed + onOrder;
  const minStock  = Number(item.MinInventory                || 0);
  const lastPrice = 0; // LastPurchasePrice not available via Service Layer Items entity
  const unit      = item.PurchaseUnit || item.SalesUnit || 'EA';
  const suggestQty = minStock > 0 ? Math.max(0, minStock * 2 - onStock) : 0;

  let status = '✅ OK';
  if (onStock <= 0)                           status = '🔴 Out of Stock';
  else if (minStock > 0 && onStock < minStock) status = '⚠️ Below Minimum';
  else if (minStock > 0 && onStock < minStock * 1.5) status = '🟡 Low Stock';

  const rows = [
    ['Item Code',         `**${item.ItemCode}**`],
    ['Item Name',         item.ItemName || '—'],
    ['Unit',              unit],
    ['On Stock',          fmtN(onStock, 0)],
    ['Committed (Sales)', fmtN(committed, 0)],
    ['On Order (Purch.)', fmtN(onOrder, 0)],
    ['Available',         `**${fmtN(available, 0)}**`],
    ['Reorder Level (Min Stock)', minStock > 0 ? fmtN(minStock, 0) : '_(Not set)_'],
    ['Suggested Order Qty',       suggestQty > 0 ? `**${fmtN(suggestQty, 0)} ${unit}**` : '_(No min stock defined)_'],
    ['Status',            status],
  ];

  let text = `### 📦 Inventory Analysis — ${item.ItemCode}\n\n`;
  text += `| Field | Value |\n|---|---|\n`;
  rows.forEach(([k, v]) => { text += `| ${k} | ${v} |\n`; });

  if (minStock > 0) {
    text += `\n> **Reorder Scenario:** `;
    if (onStock <= 0) {
      text += `Item is **out of stock**. Immediate purchase required.`;
    } else if (onStock < minStock) {
      text += `Current stock (${fmtN(onStock, 0)}) is **below minimum** (${fmtN(minStock, 0)}). Order recommended.`;
    } else {
      text += `Stock is above minimum level. Order is proactive/planned.`;
    }
    if (suggestQty > 0) {
      const estCost = lastPrice > 0 ? ` — Estimated cost: **${fmtN(suggestQty * lastPrice)}**` : '';
      text += `\n> Suggested order of **${fmtN(suggestQty, 0)} ${unit}** will bring stock to 2× minimum level.${estCost}`;
    }
  }

  return { text, suggestQty, unit, onStock, minStock, lastPrice, defaultWarehouse: item.DefaultWarehouse || '' };
}

// ── Main router factory ────────────────────────────────────────────────────────
export function createPurchaseRequestAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  // POST /chat ──────────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `pr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap = getActiveSap();
      const msg = message.trim();
      const msgL = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply = '';
      let quickReplies = [];
      let meta = {};
      let itemList    = null;   // combo list for item selection
      let vendorComboList = null; // combo list for vendor selection
      let warehouseList = null;   // combo list for warehouse selection

      let card = null;   // review card HTML — shown as its own message, not through the markdown renderer

      // Review card: header (posting date, required by, comments) and rows (item, qty, warehouse) editable
      // with ✏️, rows removable, "+ Add Row" for more items. Every render gets a new seq; only the newest card posts.
      const reviewCard = async (s, sessId, headerOverride) => {
        s.reviewSeq = (s.reviewSeq || 0) + 1;
        const h = headerOverride || s._header || {};
        const [items, whs] = await Promise.all([searchItems(sap, '', 500), getWarehouses(sap)]);
        return buildReviewCard({
          title: '📋 Purchase Request Ready to Post', partyLabel: 'Preferred Vendor',
          party: s.vendor ? { code: s.vendor.cardCode, name: s.vendor.cardName } : { code: '—', name: 'Open — no vendor' },
          seq: s.reviewSeq, send: 'praSend', postAction: 'post_pr', postLabel: '✅ Post Purchase Request',
          qtyOnly: true,
          addRow: { items: items.map(i => ({ code: i.ItemCode, name: i.ItemName })), sessionId: sessId, searchApi: '/api/pr-agent' },
          header: [
            { key: 'docDate', label: 'Posting Date', type: 'date', value: h.docDate || today() },
            { key: 'requiredDate', label: 'Required By', type: 'date', value: h.requiredDate || s.dueDate || today() },
            { key: 'comments', label: 'Comments', value: h.comments ?? s.comments ?? '', placeholder: 'Optional', wide: true },
          ],
          lines: (s.prLines || []).map(l => ({ itemCode: l.itemCode, itemName: l.itemName, quantity: l.qty, unitPrice: l.unitPrice || 0,
            discountPercent: 0, taxCode: '', warehouseCode: l.warehouseCode || '' })),
          warehouses: whs.map(w => ({ WarehouseCode: w.code })),
        });
      };

      // Card values → checked PR lines. New rows must be active purchase items; an empty warehouse
      // takes the item default, else the company default (same as Skip in the chat).
      const readCardPost = async (s, action) => {
        const base = (s.prLines || []).map(l => ({ ...l, quantity: l.qty }));
        const rp = readReviewPost(action, base, HEADER_KEYS, { allowNew: true });
        const header = rp.header || {};
        if (!rp.ok) return { ok: false, error: rp.error, header };
        header.docDate = header.docDate || today();
        header.requiredDate = header.requiredDate || header.docDate;
        if (!isIsoDate(header.docDate)) return { ok: false, error: 'Posting Date is not a valid date.', header };
        if (!isIsoDate(header.requiredDate)) return { ok: false, error: 'Required By is not a valid date.', header };
        if (header.requiredDate < header.docDate) return { ok: false, error: 'Required By cannot be before the Posting Date.', header };
        const whsList = await getWarehouses(sap);
        const lines = [];
        for (const [i, l] of rp.lines.entries()) {
          const it = await getItemDetails(sap, l.itemCode);
          if (!it?.ItemCode) return { ok: false, error: `Row ${i + 1}: item ${l.itemCode} was not found in SAP.`, header };
          if (l.isNew) {
            let flags = null;
            try { flags = await sap.get(`/Items('${encodeURIComponent(it.ItemCode.replace(/'/g, "''"))}')`, { $select: 'ItemCode,Frozen,PurchaseItem' }); } catch { flags = null; }
            if (flags?.Frozen === 'tYES') return { ok: false, error: `Row ${i + 1}: ${it.ItemCode} is inactive (frozen) in SAP.`, header };
            if (flags?.PurchaseItem === 'tNO') return { ok: false, error: `Row ${i + 1}: ${it.ItemCode} is not a purchase item.`, header };
          }
          let whs = l.warehouseCode;
          if (whs && whsList.length && !whsList.some(w => w.code === whs)) return { ok: false, error: `Row ${i + 1}: warehouse ${whs} is not active in SAP.`, header };
          if (!whs) whs = it.DefaultWarehouse || await companyDefaultWarehouse(sap) || '';
          lines.push({ itemCode: it.ItemCode, itemName: it.ItemName || l.itemName || it.ItemCode, qty: l.quantity,
            unit: l.unit || it.PurchaseUnit || it.SalesUnit || 'EA', unitPrice: Number(l.unitPrice) || 0, warehouseCode: whs, isNew: false });
        }
        return { ok: true, header, lines };
      };

      // Post the session's PR. SAP keeps the preferred vendor on each line (LineVendor), not on the header.
      const postPR = async s => {
        const h = s._header || {};
        const docDate = h.docDate || today(), reqDate = h.requiredDate || s.dueDate || today();
        const vendor = s.vendor?.cardCode || '';
        return sap.post('/PurchaseRequests', {
          DocDate:      sapDate(docDate),
          DocDueDate:   sapDate(reqDate),
          RequriedDate: sapDate(reqDate), // SAP B1 typo — "RequriedDate"
          ...(s.comments ? { Comments: s.comments } : {}),
          DocumentLines: s.prLines.map(l => ({
            ItemCode:     l.itemCode,
            Quantity:     l.qty,
            RequiredDate: sapDate(reqDate),
            ...(vendor          ? { LineVendor:    vendor          } : {}),
            ...(l.unitPrice > 0 ? { UnitPrice:     l.unitPrice     } : {}),
            ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
          })),
        });
      };

      // Item list for the next line — only existing SAP items can be requested (no "New Item")
      const startItemPick = async (s, lead = '') => {
        s.step = 'ITEM_SEARCH';
        const topItems = await searchItems(sap, '');
        s.currentItem = { searchResults: topItems };
        if (topItems.length > 0) {
          reply = `${lead}Select an item from the list, or type any part of the item name or code to search:`;
          itemList = itemListOf(topItems);
        } else {
          reply = `${lead}Please enter the **item name or code** to search for (e.g. "pump", "A1001"):`;
        }
      };

      // ── INIT ──────────────────────────────────────────────────────────────────
      // (ITEM_TYPE / NEW_ITEM_* are steps of the removed "New Item" option — a session still on one starts the item list)
      // A card action ({...}) from an earlier card once the request has moved on → refused
      if (msg.startsWith('{') && session.step !== 'CONFIRM') {
        reply = session.step === 'DONE'
          ? `This Purchase Request is already posted (#${session.result?.docNum ?? ''}). Start a new one to create another.`
          : `⚠️ That card is no longer active — continue with the latest step.`;
        if (session.step === 'DONE') quickReplies = ['Yes, New PR'];
      }
      else if (session.step === 'INIT' || !msg || session.step === 'ITEM_TYPE' || session.step.startsWith('NEW_ITEM')) {
        if (session.step.startsWith('NEW_ITEM')) session.currentItem = null;
        await startItemPick(session, `Let's start with the item.\n\n`);
      }

      // ── ITEM_SEARCH ───────────────────────────────────────────────────────────
      else if (session.step === 'ITEM_SEARCH') {
        if (!msg) { reply = 'Please enter an item name or code to search:'; }
        else if (msg.includes(' — ')) {
          // User clicked a chip from the pre-fetched list — go straight to inventory analysis
          const codeFromChip = msg.split(' — ')[0].trim();
          const preloaded = session.currentItem?.searchResults?.find(
            r => r.ItemCode.toUpperCase() === codeFromChip.toUpperCase()
          );
          const details = preloaded ? (await getItemDetails(sap, codeFromChip) || preloaded) : await getItemDetails(sap, codeFromChip);
          if (!details) {
            reply = `Could not find item **${codeFromChip}**. Please type a name or code to search:`;
          } else {
            const analysis = renderInventoryAnalysis(details);
            session.currentItem = { searchResults: session.currentItem?.searchResults || [], selected: details, analysis, isNew: false };
            if (details.DefaultVendor && !session._suggestedVendorCode) session._suggestedVendorCode = details.DefaultVendor;
            const hint = analysis.suggestQty > 0
              ? ` _(Suggested: **${fmtN(analysis.suggestQty, 0)} ${analysis.unit}** based on min stock rule)_`
              : '';
            reply = `${analysis.text}\n\n---\n\n**How many units do you want to request?**${hint}`;
            if (analysis.suggestQty > 0) quickReplies = [String(Math.ceil(analysis.suggestQty)), 'Enter custom qty'];
            session.step = 'ITEM_QTY';
          }
        } else {
          const results = await searchItems(sap, msg);
          if (!results.length) {
            const prev = session.currentItem?.searchResults || [];
            reply = `No items found matching **"${msg}"**.`;
            if (prev.length > 0) {
              reply += ` Showing full list — select one or try a different search:`;
              itemList = itemListOf(prev);
            } else {
              reply += ` Please try a different search term.`;
            }
          } else {
            session.currentItem = { searchResults: results };
            reply = `Found **${results.length}** item(s) matching "**${msg}**" — select one:`;
            session.step = 'ITEM_SELECT';
            itemList = itemListOf(results);
          }
        }
      }

      // ── ITEM_SELECT ───────────────────────────────────────────────────────────
      else if (session.step === 'ITEM_SELECT') {
        const results = session.currentItem?.searchResults || [];
        let selected = null;
        const numM = msg.match(/^(\d+)$/);
        if (numM) {
          const idx = parseInt(numM[1]) - 1;
          if (idx >= 0 && idx < results.length) selected = results[idx];
        }
        // Handle chip format "CODE — Name"
        if (!selected && msg.includes(' — ')) {
          const codeFromChip = msg.split(' — ')[0].trim();
          selected = results.find(r => r.ItemCode.toUpperCase() === codeFromChip.toUpperCase());
        }
        if (!selected) selected = results.find(r =>
          r.ItemCode.toLowerCase() === msgL || r.ItemName.toLowerCase() === msgL);
        if (!selected && results.length === 1) selected = results[0];

        // Free text that isn't in the current list → run a fresh SAP search
        if (!selected && !numM && !msg.includes(' — ')) {
          const fresh = await searchItems(sap, msg);
          const exact = fresh.find(r => r.ItemCode.toUpperCase() === msg.trim().toUpperCase());
          if (exact || fresh.length === 1) {
            selected = exact || fresh[0];
            results.splice(0, results.length, ...fresh);
          } else if (fresh.length > 1) {
            session.currentItem = { searchResults: fresh };
            reply = `Found **${fresh.length}** item(s) matching "**${msg}**" — select one:`;
            itemList = itemListOf(fresh);
          }
        }

        if (itemList) { /* fresh search results already shown */ }
        else if (!selected) {
          reply = `Could not find that item — please select from the list:`;
          itemList = itemListOf(results);
        } else {
          const details = await getItemDetails(sap, selected.ItemCode) || selected;
          const analysis = renderInventoryAnalysis(details);
          session.currentItem = { searchResults: results, selected: details, analysis, isNew: false };
          if (details.DefaultVendor && !session._suggestedVendorCode) {
            session._suggestedVendorCode = details.DefaultVendor;
          }
          const hint = analysis.suggestQty > 0
            ? ` _(Suggested: **${fmtN(analysis.suggestQty, 0)} ${analysis.unit}** based on min stock rule)_`
            : '';
          reply = `${analysis.text}\n\n---\n\n**How many units do you want to request?**${hint}`;
          if (analysis.suggestQty > 0) quickReplies = [String(Math.ceil(analysis.suggestQty)), 'Enter custom qty'];
          session.step = 'ITEM_QTY';
        }
      }

      // ── ITEM_QTY (existing item) ───────────────────────────────────────────────
      else if (session.step === 'ITEM_QTY') {
        const qtyRaw = msg.replace(/,/g, '').match(/[\d.]+/);
        const qty = qtyRaw ? parseFloat(qtyRaw[0]) : NaN;
        if (!qty || qty <= 0 || isNaN(qty)) {
          reply = 'Please enter a valid quantity (e.g. 50):';
        } else {
          const it = session.currentItem?.selected || {};
          session.currentItem.qty = qty;
          session.currentItem.unit = it.PurchaseUnit || it.SalesUnit || 'EA';
          session.currentItem.unitPrice = Number(it.LastPurchasePrice || 0);
          session.step = 'WAREHOUSE';
          // Skip → the item's default warehouse, else the company default warehouse
          const itemWhs = it.DefaultWarehouse || '';
          const defWhs = itemWhs || await companyDefaultWarehouse(sap);
          session.currentItem.defaultWarehouse = defWhs;
          session._warehouses = await getWarehouses(sap, defWhs);
          warehouseList = session._warehouses;
          reply = `**${qty} ${session.currentItem.unit}** noted.\n\n**Select the warehouse** this should be requested for` +
            (defWhs ? `, or choose **Skip** to use the default warehouse **${defWhs}**${itemWhs ? ' (item default)' : ' (company default)'}:` : `, or choose **Skip**:`);
          quickReplies = defWhs ? [defWhs, 'Skip'] : ['Skip'];
        }
      }

      // ── WAREHOUSE ─────────────────────────────────────────────────────────────
      else if (session.step === 'WAREHOUSE' && !/skip|none|n\/a/i.test(msgL)
               && resolveWarehouse(msg, session._warehouses || []) === undefined) {
        reply = `Warehouse **${msg}** was not found — please select one from the list:`;
        warehouseList = session._warehouses;
      }
      else if (session.step === 'WAREHOUSE') {
        const skipped = /skip|none|n\/a/i.test(msgL);
        const whs = skipped ? (session.currentItem?.defaultWarehouse || null) : resolveWarehouse(msg, session._warehouses || []);
        session.currentItem.warehouseCode = whs;

        // Commit current item to prLines
        const it = session.currentItem?.selected || {};
        session.prLines.push({
          itemCode:      it.ItemCode       || session.currentItem.itemCode || '',
          itemName:      it.ItemName       || session.currentItem.itemName || '',
          qty:           session.currentItem.qty,
          unit:          session.currentItem.unit || 'EA',
          unitPrice:     session.currentItem.unitPrice || 0,
          warehouseCode: whs || '',
          isNew:         false,
        });
        session.currentItem = null;

        session.step = 'ADD_MORE_ITEMS';
        reply = `✅ Item added to the purchase request${skipped && whs ? ` — default warehouse **${whs}**` : ''}.\n\n**Current PR (${session.prLines.length} line${session.prLines.length !== 1 ? 's' : ''}):**\n` +
          session.prLines.map((l, i) => `${i + 1}. **${l.itemCode}** — ${l.itemName} — Qty: ${fmtN(l.qty, 0)} ${l.unit}${l.warehouseCode ? ` — Whs: ${l.warehouseCode}` : ''}`).join('\n') +
          `\n\nWould you like to **add another item** or **proceed to vendor/header details**?`;
        quickReplies = ['Add Another Item', 'Proceed to Header'];
      }

      // ── ADD_MORE_ITEMS ────────────────────────────────────────────────────────
      else if (session.step === 'ADD_MORE_ITEMS') {
        if (/add|another|more item|new line/i.test(msgL) && !/proceed|vendor|header|done|finish|no\b/i.test(msgL)) {
          await startItemPick(session, `Great! Let's add another item.\n\n`);
        } else {
          // Proceed to header details — pre-fetch vendor list for combo
          session.step = 'VENDOR';
          const fetchedVendors = await searchVendors(sap, '');
          const hint = session._suggestedVendorCode
            ? `\n\n_(Suggested vendor from item: **${session._suggestedVendorCode}**)_`
            : '';
          reply = `**${session.prLines.length} item(s)** ready.\n\n**Select a preferred vendor** or type **skip** to leave it open:${hint}`;
          quickReplies = session._suggestedVendorCode ? [`Use ${session._suggestedVendorCode}`, 'Skip'] : ['Skip'];
          if (fetchedVendors.length > 0)
            vendorComboList = fetchedVendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        }
      }

      // ── VENDOR ────────────────────────────────────────────────────────────────
      else if (session.step === 'VENDOR') {
        if (/skip|none|no vendor|n\/a|open/i.test(msgL)) {
          session.vendor = null;
          session.step = 'DUE_DATE';
          reply = `Proceeding without a specific vendor.\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
          quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
        } else {
          let query = msg.trim();
          if (/^yes|use /i.test(msgL) && session._suggestedVendorCode) query = session._suggestedVendorCode;
          // Handle chip format "CODE — Name" — extract code for lookup
          else if (msg.includes(' — ')) query = msg.split(' — ')[0].trim();

          const vendors = await searchVendors(sap, query);
          // A picked chip / typed code selects that exact vendor, even when other codes contain it
          const exact = vendors.find(v => v.CardCode.toUpperCase() === query.toUpperCase());
          if (!vendors.length) {
            // Not a vendor in SAP — ask again rather than posting an unknown vendor code
            const all = await searchVendors(sap, '');
            reply = `No vendor matches **"${msg.trim()}"**. Select one from the list, type another name or code, or **skip** to leave it open:`;
            quickReplies = ['Skip'];
            if (all.length) vendorComboList = all.map(v => ({ code: v.CardCode, name: v.CardName }));
          } else if (exact || vendors.length === 1) {
            const v = exact || vendors[0];
            session.vendor = { cardCode: v.CardCode, cardName: v.CardName };
            session.step = 'DUE_DATE';
            reply = `✅ Vendor: **${v.CardCode} — ${v.CardName}**\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
            quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
          } else {
            session._vendorResults = vendors;
            session.step = 'VENDOR_SELECT';
            reply = `Found **${vendors.length}** vendor(s) — select one:`;
            vendorComboList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
          }
        }
      }

      // ── VENDOR_SELECT ─────────────────────────────────────────────────────────
      else if (session.step === 'VENDOR_SELECT') {
        const vendors = session._vendorResults || [];
        let sel = null;
        const numM = msg.match(/^(\d+)$/);
        if (numM) {
          const idx = parseInt(numM[1]) - 1;
          if (idx >= 0 && idx < vendors.length) sel = vendors[idx];
        }
        // Handle chip format "CODE — Name"
        if (!sel && msg.includes(' — ')) {
          const codeFromChip = msg.split(' — ')[0].trim();
          sel = vendors.find(v => v.CardCode.toLowerCase() === codeFromChip.toLowerCase());
        }
        if (!sel) sel = vendors.find(v => v.CardCode.toLowerCase() === msgL);
        // Typed text that isn't in the current list → search all vendors again
        let fresh = null;
        if (!sel && !numM && !/skip|none|no vendor|n\/a/i.test(msgL)) {
          const q = msg.includes(' — ') ? msg.split(' — ')[0].trim() : msg.trim();
          fresh = await searchVendors(sap, q);
          sel = fresh.find(v => v.CardCode.toUpperCase() === q.toUpperCase()) || (fresh.length === 1 ? fresh[0] : null);
        }

        if (!sel && /skip|none|no vendor|n\/a/i.test(msgL)) {
          session.vendor = null;
          session.step = 'DUE_DATE';
          reply = `Proceeding without a specific vendor.\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
          quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
        } else if (!sel && fresh?.length > 1) {
          session._vendorResults = fresh;
          reply = `Found **${fresh.length}** vendor(s) matching "**${msg.trim()}**" — select one:`;
          vendorComboList = fresh.map(v => ({ code: v.CardCode, name: v.CardName }));
        } else if (sel) {
          session.vendor = { cardCode: sel.CardCode, cardName: sel.CardName };
          session.step = 'DUE_DATE';
          reply = `✅ Vendor: **${sel.CardCode} — ${sel.CardName}**\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
          quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
        } else {
          reply = `Could not find that vendor — please select from the list:`;
          vendorComboList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        }
      }

      // ── DUE_DATE ──────────────────────────────────────────────────────────────
      else if (session.step === 'DUE_DATE' && !/skip|today|now/i.test(msgL)
               && (!parseDate(msg.trim()) || isNaN(Date.parse(parseDate(msg.trim()))) || parseDate(msg.trim()) < today())) {
        // Unreadable or past date — ask again instead of silently using today
        reply = `**${msg}** is not a valid future date. Please pick a date from the calendar or type it as YYYY-MM-DD / DD-MM-YYYY:`;
        quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
      }
      else if (session.step === 'DUE_DATE') {
        session.dueDate = /skip|today|now/i.test(msgL) ? today() : parseDate(msg.trim());
        session.step = 'COMMENTS';
        reply = `Due date set to **${session.dueDate}**.\n\nAny **comments or notes** for this purchase request?\n_(type your notes or "skip")_`;
        quickReplies = ['Skip', 'Urgent — please expedite', 'Standard procurement process'];
      }

      // ── COMMENTS → review card ───────────────────────────────────────────────
      else if (session.step === 'COMMENTS') {
        session.comments = /^skip$|^none$/i.test(msgL) ? null : msg || null;
        session.step = 'CONFIRM';
        session._header = null;
        reply = `### 📋 Check the Purchase Request\n\nEdit anything on the card below — **✏️ Edit Header** for dates / comments, **✏️** on a row for quantity / warehouse, **🗑** to remove a row, **+ Add Row** to add an item — then click **✅ Post Purchase Request**.`;
        card = await reviewCard(session, sid);
        quickReplies = ['✏️ Change Vendor', '❌ Cancel'];
        meta = { prLines: session.prLines, vendor: session.vendor, dueDate: session.dueDate };
      }

      // ── CONFIRM — review card ─────────────────────────────────────────────────
      else if (session.step === 'CONFIRM') {
        let action = null;
        if (msg.startsWith('{')) { try { action = JSON.parse(msg); } catch { /* not an action */ } }

        if (action?.action === 'post_pr' && Number(action.seq) !== session.reviewSeq) {
          reply = `⚠️ That card is out of date — use this one.`;
          card = await reviewCard(session, sid);
        } else if (action?.action === 'post_pr' && session._posting) {
          reply = '⏳ This Purchase Request is already being posted — please wait.';
        } else if (action?.action === 'post_pr') {
          session._posting = true;   // before the first await, so a second click can't slip in
          try {
            const chk = await readCardPost(session, action);
            if (!chk.ok) {
              reply = `❌ ${chk.error}`;
              card = await reviewCard(session, sid, chk.header);
            } else {
              session.prLines = chk.lines;
              session._header = chk.header;
              session.dueDate = chk.header.requiredDate;
              session.comments = chk.header.comments || null;
              try {
                const result = await postPR(session);
                session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
                session.step = 'DONE';
                reply = `### ✅ Purchase Request Created!\n\n` +
                  `| Field | Value |\n|---|---|\n` +
                  `| **Document #** | ${result.DocNum} |\n` +
                  `| **Doc Entry** | ${result.DocEntry} |\n` +
                  `| **Posting Date** | ${chk.header.docDate} |\n` +
                  `| **Required By** | ${chk.header.requiredDate} |\n` +
                  `| **Preferred Vendor** | ${session.vendor ? `${session.vendor.cardCode} — ${session.vendor.cardName}` : '_(Open)_'} |\n` +
                  `| **Lines** | ${session.prLines.length} |\n\n` +
                  `[🖨️ Print Requisition](/api/pr-agent/print/${result.DocEntry})\n\n` +
                  `Would you like to create **another purchase request**?`;
                quickReplies = ['Yes, New PR', 'No, Done'];
                meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl: `/api/pr-agent/print/${result.DocEntry}` };
              } catch (e) {
                reply = `❌ **Failed to post Purchase Request**\n\nSAP Error: _${e.message}_\n\nFix it on the card below and post again, or **Cancel**.`;
                card = await reviewCard(session, sid);
                quickReplies = ['✏️ Change Vendor', '❌ Cancel'];
              }
            }
          } finally {
            session._posting = false;
          }

        } else if (action) {
          reply = `⚠️ That step is already finished — use the card below.`;
          card = await reviewCard(session, sid);
        } else if (/edit|change|modify|back|vendor|✏️/i.test(msgL) && !/cancel/i.test(msgL)) {
          session.step = 'VENDOR';
          const editVendors = await searchVendors(sap, '');
          const hint = session._suggestedVendorCode
            ? `\n\n_(Suggested: **${session._suggestedVendorCode}**)_`
            : '';
          reply = `Let's revisit the header details.\n\n**Change the vendor?**${hint}\n\nSelect from the list or type **skip**:`;
          quickReplies = session._suggestedVendorCode ? [`Use ${session._suggestedVendorCode}`, 'Skip'] : ['Skip'];
          if (editVendors.length > 0)
            vendorComboList = editVendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        } else if (/cancel|^no\b|discard/i.test(msgL)) {
          _sessions.set(sid, initSession());
          reply = `Purchase request **cancelled**. Come back anytime!\n\nType **"start"** to create a new purchase request.`;
          quickReplies = ['Start New PR'];
        } else {
          reply = /yes|post|confirm|submit|✅/i.test(msgL)
            ? `Click **✅ Post Purchase Request** on the card below to post it.`
            : `Make changes on the card below — **✏️ Edit Header**, **✏️** on a row, **+ Add Row** — or choose **Change Vendor** / **Cancel**.`;
          card = await reviewCard(session, sid);
          quickReplies = ['✏️ Change Vendor', '❌ Cancel'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|new|another|start/i.test(msgL)) {
          _sessions.set(sid, initSession());
          await startItemPick(_sessions.get(sid), `Great! Let's create a new purchase request.\n\n`);
        } else {
          reply = `Thank you! Your purchase request has been processed successfully.\n\nType **"start"** to create another purchase request anytime.`;
          quickReplies = ['Start New PR'];
        }
      }

      // ── Unknown / reset ────────────────────────────────────────────────────────
      else {
        _sessions.set(sid, initSession());
        await startItemPick(_sessions.get(sid), `Let me start over.\n\n`);
      }

      // ── Optionally enrich reply with AI narrative ──────────────────────────────
      // Only for non-critical structural steps — AI adds warmth without changing data
      const aiEnhanceable = ['ITEM_TYPE', 'ADD_MORE_ITEMS', 'DUE_DATE', 'COMMENTS', 'DONE'];
      if (aiDeps.USE_AI && aiEnhanceable.includes(session.step) && session.history.length >= 4) {
        const system = `You are a Purchase Requisition Assistant for SAP Business One. The user is creating a purchase request. Be very concise (1-2 sentences max), professional, and encouraging. Do NOT repeat factual data already shown. Just add a brief natural-language acknowledgement or tip relevant to the current step "${session.step}". Current PR has ${session.prLines.length} lines.`;
        const aiNarrative = await callAI(aiDeps, [{ role: 'user', content: msg || 'continue' }], system, 150);
        if (aiNarrative?.trim()) reply = `_${aiNarrative.trim()}_\n\n${reply}`;
      }

      // A restart above replaces the session — answer with the current one
      const cur = _sessions.get(sid) || session;
      cur.history.push({ role: 'assistant', content: reply });
      if (cur.history.length > 50) cur.history.splice(0, cur.history.length - 50);

      res.json({
        ok: true,
        reply,
        card,
        quickReplies,
        sessionId: sid,
        step: cur.step,
        prLines: cur.prLines || [],
        vendor: cur.vendor,
        dueDate: cur.dueDate,
        meta,
        itemList,
        vendorList: vendorComboList,
        warehouseList,
      });

    } catch (e) {
      console.error('[PR-Agent] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /items?q= — live item search for the item combo (full item master) ────────
  router.get('/items', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, items: [] });
    const results = await searchItems(getActiveSap(), q, 50);
    res.json({ ok: true, items: results.map(it => ({
      code: it.ItemCode, name: it.ItemName,
      onStock: Number(it.QuantityOnStock || 0),
      minStock: Number(it.MinInventory || 0),
    })) });
  });

  // GET /vendors?q= — live vendor search for the vendor combo (all vendors, not only the first 20) ─
  router.get('/vendors', requireAuth, async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, vendors: [] });
    const results = await searchVendors(getActiveSap(), q);
    res.json({ ok: true, vendors: results.map(v => ({ code: v.CardCode, name: v.CardName })) });
  });

  // POST /reset ─────────────────────────────────────────────────────────────────
  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // GET /print/:docEntry ────────────────────────────────────────────────────────
  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const { docEntry } = req.params;
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseRequests(${parseInt(docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPRPrint(doc, await requestPeople(sap, doc)));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading purchase request #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}

// ── Requester / creator names for the print ────────────────────────────────────
// Requested by: the PR's requester (SAP fills it with the posting user, or the employee chosen in SAP).
// Created by: the SAP user who added the document (UserSign).
async function sapUserName(sap, filter) {
  try {
    const r = await sap.get('/Users', { $select: 'InternalKey,UserCode,UserName', $filter: filter, $top: 1 });
    const u = r?.value?.[0];
    return u ? (u.UserName || u.UserCode || '') : '';
  } catch { return ''; }
}

async function requestPeople(sap, doc) {
  let requestedBy = doc.RequesterName || '';
  if (!requestedBy && doc.Requester) {
    // ReqType 12 = user (Requester is a user code); 171 = employee (Requester is an employee id)
    if (Number(doc.ReqType) === 171) {
      try {
        const e = await sap.get(`/EmployeesInfo(${parseInt(doc.Requester, 10)})`, { $select: 'FirstName,LastName' });
        requestedBy = [e.FirstName, e.LastName].filter(Boolean).join(' ');
      } catch { /* keep the id */ }
    } else {
      requestedBy = await sapUserName(sap, `UserCode eq '${String(doc.Requester).replace(/'/g, "''")}'`);
    }
    requestedBy = requestedBy || String(doc.Requester);
  }
  const createdBy = doc.UserSign != null ? await sapUserName(sap, `InternalKey eq ${parseInt(doc.UserSign, 10)}`) : '';
  // Preferred vendor: SAP keeps it per line (LineVendor); the header CardCode is only a fallback
  const vendorCode = doc.CardCode || (doc.DocumentLines || []).find(l => l.LineVendor)?.LineVendor || '';
  let vendorName = doc.CardName || '';
  if (vendorCode && !vendorName) {
    try { vendorName = (await sap.get(`/BusinessPartners('${String(vendorCode).replace(/'/g, "''")}')`, { $select: 'CardCode,CardName' }))?.CardName || ''; }
    catch { /* code only */ }
  }
  return { requestedBy, createdBy, email: doc.RequesterEmail || '', department: doc.RequesterDepartment ?? null, vendorCode, vendorName };
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Print HTML renderer ────────────────────────────────────────────────────────
// Internal requisition: quantities only — no unit price, totals or tax.
function renderPRPrint(doc, people = {}) {
  const company  = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines    = doc.DocumentLines || [];
  const docDate  = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate  = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const requestedBy = people.requestedBy || people.createdBy || '—';

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${escHtml(l.ItemCode)}</strong></td>
      <td>${escHtml(l.ItemDescription)}</td>
      <td style="text-align:right">${Number(l.Quantity || 0).toFixed(2)}</td>
      <td>${escHtml(l.UoMCode || l.MeasureUnit)}</td>
      <td>${escHtml(l.WarehouseCode)}</td>
      <td>${l.RequiredDate ? escHtml(String(l.RequiredDate).slice(0, 10)) : ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Purchase Requisition #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
    .print-btn{text-align:right;margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
    .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
    .btn-print{background:#354A5E;color:#fff}
    .btn-close{background:#eee;color:#333}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #354A5E}
    .co-name{font-size:20px;font-weight:700;color:#1a1d27}
    .co-sub{color:#888;font-size:11px;margin-top:2px}
    .doc-title{font-size:18px;font-weight:700;color:#354A5E;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .pr-badge{display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:700;margin-top:4px}
    .badge-open{background:#d4f4e8;color:#1a7a4a}
    .badge-closed{background:#f4d4d4;color:#7a1a1a}
    .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#354A5E}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff;letter-spacing:.03em}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#fafbfe}
    .totals{text-align:right;padding:12px 0 20px}
    .total-grand{font-size:14px;font-weight:700;color:#354A5E}
    .comments-box{border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#fffef5;font-size:11px;line-height:1.6}
    .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
    .sig-box{text-align:center}
    .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em}
    .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
    .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:80px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0;user-select:none}
    @media print{.print-btn{display:none}.watermark{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style>
</head>
<body>
<div class="watermark">REQUISITION</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>

<div class="header">
  <div>
    <div class="co-name">${company}</div>
    <div class="co-sub">SAP Business One — Internal Purchase Requisition</div>
  </div>
  <div>
    <div class="doc-title">Purchase Request</div>
    <div class="doc-num">PR # ${doc.DocNum}</div>
    <div style="text-align:right;margin-top:4px">
      <span class="pr-badge ${doc.DocumentStatus === 'bost_Open' ? 'badge-open' : 'badge-closed'}">${doc.DocumentStatus === 'bost_Open' ? 'OPEN' : 'CLOSED'}</span>
    </div>
  </div>
</div>

<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Requested By / Created</div>
    <div class="info-val">Requested by: <strong>${escHtml(requestedBy)}</strong></div>
    ${people.email ? `<div class="info-val" style="color:#666">${escHtml(people.email)}</div>` : ''}
    <div class="info-val">Created by: <strong>${escHtml(people.createdBy || requestedBy)}</strong></div>
    <div class="info-val" style="color:#666">Entry #${doc.DocEntry}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Dates</div>
    <div class="info-val">Doc Date: <strong>${docDate}</strong></div>
    <div class="info-val">Required By: <strong>${dueDate}</strong></div>
  </div>
  <div class="info-box">
    <div class="info-label">Preferred Vendor</div>
    <div class="info-val"><strong>${escHtml(people.vendorName || people.vendorCode || '—')}</strong></div>
    ${people.vendorCode ? `<div class="info-val" style="color:#666">${escHtml(people.vendorCode)}</div>` : '<div class="info-val" style="color:#aaa;font-style:italic">Not specified — open for quotation</div>'}
  </div>
</div>

${doc.Comments ? `<div class="comments-box"><strong>📝 Comments / Notes:</strong><br><br>${doc.Comments}</div>` : ''}

<table>
  <thead>
    <tr>
      <th>#</th><th>Item Code</th><th>Description</th>
      <th style="text-align:right">Quantity</th><th>Unit</th>
      <th>Warehouse</th><th>Required Date</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>

<div class="sig-section">
  <div class="sig-box">${requestedBy !== '—' ? `<div style="font-size:11px;font-weight:600">${escHtml(requestedBy)}</div>` : ''}<div class="sig-line"${requestedBy !== '—' ? ' style="margin-top:24px"' : ''}>Requested By</div></div>
  <div class="sig-box"><div class="sig-line">Approved By</div></div>
  <div class="sig-box"><div class="sig-line">Procurement Manager</div></div>
</div>

<div class="footer">
  Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 Purchase Requisition #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution
</div>
</body>
</html>`;
}
