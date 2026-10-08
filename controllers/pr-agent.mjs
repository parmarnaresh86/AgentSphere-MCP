/**
 * Purchase Request Chat Agent
 * Mounted at /api/pr-agent by chat-server.mjs
 *
 * State machine flow:
 *  INIT → ITEM_TYPE → ITEM_SEARCH → ITEM_SELECT → QTY_ANALYSIS → WAREHOUSE → ADD_MORE_ITEMS
 *                   ↘ NEW_ITEM_CODE → NEW_ITEM_NAME → NEW_ITEM_QTY → NEW_ITEM_WAREHOUSE ↗
 *                                                               (loop) ↓ proceed
 *                                                         VENDOR → VENDOR_SELECT?
 *                                                               ↓
 *                                              DUE_DATE → COMMENTS → CONFIRM → POSTING → DONE
 */
import { Router } from 'express';

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
// SAP Service Layer string filters are case-sensitive and tolower() is not supported,
// so search the common casings: as typed, UPPER, lower, Title
function caseVariants(q) {
  const title = q.charAt(0).toUpperCase() + q.slice(1).toLowerCase();
  return [...new Set([q, q.toUpperCase(), q.toLowerCase(), title])];
}

async function searchItems(sap, query, top = 15) {
  const q = (query || '').trim();
  const baseFilter = `ItemType eq 'itItems' and Frozen eq 'tNO'`;
  const anyOf = fn => `(${caseVariants(q).map(v => fn(v.replace(/'/g, "''"))).join(' or ')}) and ${baseFilter}`;
  const fetchItems = async filter => {
    const r = await sap.get('/Items', {
      $select: 'ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,PurchaseUnit,SalesUnit',
      $filter: filter,
      $top: top,
      $orderby: 'ItemName asc',
    });
    return Array.isArray(r.value) ? r.value : [];
  };
  try {
    if (!q) return await fetchItems(baseFilter);
    // Code/name starting with the text first (so "B" finds "Batch01"), then "contains" matches.
    // One query per field: Service Layer drops rows when ItemCode and ItemName conditions are OR-ed together.
    const lists = await Promise.all([
      fetchItems(anyOf(e => `ItemCode eq '${e}'`)),
      fetchItems(anyOf(e => `startswith(ItemCode,'${e}')`)),
      fetchItems(anyOf(e => `startswith(ItemName,'${e}')`)),
      fetchItems(anyOf(e => `contains(ItemCode,'${e}')`)),
      fetchItems(anyOf(e => `contains(ItemName,'${e}')`)),
    ]);
    const seen = new Set();
    return lists.flat()
      .filter(it => !seen.has(it.ItemCode) && seen.add(it.ItemCode))
      .slice(0, top);
  } catch (e) {
    console.error('[PR-Agent] item search error:', e.message);
    return [];
  }
}

async function getItemDetails(sap, itemCode) {
  try {
    const esc = encodeURIComponent(itemCode);
    return await sap.get(`/Items('${esc}')`, {
      $select: 'ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,QuantityOrderedFromVendors,MinInventory,PurchaseUnit,SalesUnit,DefaultWarehouse',
    });
  } catch {
    return null;
  }
}

// Case-insensitive lookup by item code (e.g. "BATCH01" finds "Batch01")
async function findItemByCode(sap, itemCode) {
  const exact = await getItemDetails(sap, itemCode);
  if (exact?.ItemCode) return exact;
  const hit = (await searchItems(sap, itemCode))
    .find(r => r.ItemCode.toUpperCase() === itemCode.toUpperCase());
  return hit ? (await getItemDetails(sap, hit.ItemCode) || hit) : null;
}

// Create a new item in SAP B1 item master (used by the "New Item" flow)
async function createItemMaster(sap, line) {
  return sap.post('/Items', {
    ItemCode:      line.itemCode,
    ItemName:      line.itemName || line.itemCode,
    ItemType:      'itItems',
    InventoryItem: 'tYES',
    SalesItem:     'tYES',
    PurchaseItem:  'tYES',
    ...(line.warehouseCode ? { DefaultWarehouse: line.warehouseCode } : {}),
  });
}

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
  const esc = (query || '').replace(/'/g, "''");
  const baseFilter = `CardType eq 'cSupplier' and Frozen eq 'tNO'`;
  const filter = esc
    ? `(CardCode eq '${esc}' or contains(CardName,'${esc}')) and ${baseFilter}`
    : baseFilter;
  try {
    const r = await sap.get('/BusinessPartners', {
      $select: 'CardCode,CardName',
      $filter: filter,
      $top: 20,
      $orderby: 'CardName asc',
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch {
    return [];
  }
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

// ── PR summary builder ─────────────────────────────────────────────────────────
function buildPRSummary(session) {
  const { prLines, vendor, dueDate, comments } = session;
  let out = `### 📋 Purchase Request Summary\n\n`;
  out += `| Field | Value |\n|---|---|\n`;
  out += `| **Date** | ${today()} |\n`;
  out += `| **Required By** | ${dueDate || today()} |\n`;
  out += `| **Vendor** | ${vendor ? `${vendor.cardCode} — ${vendor.cardName}` : '_(Open — not specified)_'} |\n`;
  out += `| **Comments** | ${comments || '_(None)_'} |\n\n`;
  out += `#### Items (${prLines.length} line${prLines.length !== 1 ? 's' : ''})\n\n`;
  out += `| # | Item Code | Description | Qty | Unit | Unit Price | Total | Warehouse |\n`;
  out += `|---|---|---|---|---|---|---|---|\n`;
  let grand = 0;
  prLines.forEach((l, i) => {
    const lineTotal = (l.qty || 0) * (l.unitPrice || 0);
    grand += lineTotal;
    out += `| ${i + 1} | **${l.itemCode}** | ${l.itemName || '—'} | ${fmtN(l.qty, 0)} | ${l.unit || 'EA'} | ${l.unitPrice > 0 ? fmtN(l.unitPrice) : '—'} | ${lineTotal > 0 ? fmtN(lineTotal) : '—'} | ${l.warehouseCode || '—'} |\n`;
  });
  if (grand > 0) out += `\n**Estimated Grand Total: ${fmtN(grand)}**`;
  return out;
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

      // ── INIT ──────────────────────────────────────────────────────────────────
      if (session.step === 'INIT' || !msg) {
        reply = `Let's start with the item. Is this for a **new item** (not yet in SAP item master) or an **existing item** (already in SAP)?`;
        quickReplies = ['Existing Item', 'New Item'];
        session.step = 'ITEM_TYPE';
      }

      // ── ITEM_TYPE ─────────────────────────────────────────────────────────────
      else if (session.step === 'ITEM_TYPE') {
        if (/\bnew\b|create|fresh|not.*(in|exist)/i.test(msgL)) {
          session.step = 'NEW_ITEM_CODE';
          reply = `Got it — you want to request a **new item**.\n\n> ℹ️ If this item code is not yet in the SAP B1 item master, it will be **created automatically** when the PR is posted.\n\nPlease enter the **Item Code**:`;
        } else {
          session.step = 'ITEM_SEARCH';
          // Pre-fetch top items so user can click directly without typing
          const topItems = await searchItems(sap, '');
          if (topItems.length > 0) {
            session.currentItem = { searchResults: topItems };
            reply = `Select an item from the list, or type a name/code to filter:`;
            itemList = topItems.map(it => ({
              code: it.ItemCode, name: it.ItemName,
              onStock: Number(it.QuantityOnStock || 0),
              minStock: Number(it.MinInventory || 0),
            }));
          } else {
            reply = `Please enter the **item name or code** to search for (e.g. "pump", "A1001"):`;
          }
        }
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
              itemList = prev.map(it => ({
                code: it.ItemCode, name: it.ItemName,
                onStock: Number(it.QuantityOnStock || 0),
                minStock: Number(it.MinInventory || 0),
              }));
            } else {
              reply += ` Please try a different search term.`;
              quickReplies = ['Search again', 'New Item'];
            }
          } else {
            session.currentItem = { searchResults: results };
            reply = `Found **${results.length}** item(s) matching "**${msg}**" — select one:`;
            session.step = 'ITEM_SELECT';
            itemList = results.map(it => ({
              code: it.ItemCode, name: it.ItemName,
              onStock: Number(it.QuantityOnStock || 0),
              minStock: Number(it.MinInventory || 0),
            }));
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
            itemList = fresh.map(it => ({
              code: it.ItemCode, name: it.ItemName,
              onStock: Number(it.QuantityOnStock || 0),
              minStock: Number(it.MinInventory || 0),
            }));
          }
        }

        if (itemList) { /* fresh search results already shown */ }
        else if (!selected) {
          reply = `Could not find that item — please select from the list:`;
          itemList = results.map(it => ({
            code: it.ItemCode, name: it.ItemName,
            onStock: Number(it.QuantityOnStock || 0),
            minStock: Number(it.MinInventory || 0),
          }));
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
          const defWhs = it.DefaultWarehouse || '';
          session._warehouses = await getWarehouses(sap, defWhs);
          warehouseList = session._warehouses;
          reply = `**${qty} ${session.currentItem.unit}** noted.\n\n**Select the warehouse** this should be requested for, or choose **Skip**:${defWhs ? `\n\n_(Default warehouse for this item: **${defWhs}**)_` : ''}`;
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
        const whs = /skip|none|n\/a/i.test(msgL) ? null : resolveWarehouse(msg, session._warehouses || []);
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
        reply = `✅ Item added to the purchase request.\n\n**Current PR (${session.prLines.length} line${session.prLines.length !== 1 ? 's' : ''}):**\n` +
          session.prLines.map((l, i) => `${i + 1}. **${l.itemCode}** — ${l.itemName} — Qty: ${fmtN(l.qty, 0)} ${l.unit}${l.warehouseCode ? ` — Whs: ${l.warehouseCode}` : ''}`).join('\n') +
          `\n\nWould you like to **add another item** or **proceed to vendor/header details**?`;
        quickReplies = ['Add Another Item', 'Proceed to Header'];
      }

      // ── ADD_MORE_ITEMS ────────────────────────────────────────────────────────
      else if (session.step === 'ADD_MORE_ITEMS') {
        if (/add|another|more item|new line/i.test(msgL) && !/proceed|vendor|header|done|finish|no\b/i.test(msgL)) {
          session.step = 'ITEM_TYPE';
          reply = `Great! Let's add another item.\n\nIs this for a **new item** or an **existing item**?`;
          quickReplies = ['Existing Item', 'New Item'];
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

      // ── NEW_ITEM_CODE ─────────────────────────────────────────────────────────
      else if (session.step === 'NEW_ITEM_CODE') {
        const code = msg.trim().toUpperCase();
        if (!code) { reply = 'Please enter the item code:'; }
        else {
          const existing = await findItemByCode(sap, code);
          if (existing?.ItemCode) {
            // Already in item master — treat as existing, skip name entry
            session.currentItem = { isNew: false, itemCode: existing.ItemCode, itemName: existing.ItemName };
            session.step = 'NEW_ITEM_QTY';
            reply = `Item **${existing.ItemCode}** — ${existing.ItemName} already exists in SAP, so it will be used as is.\n\nHow many units do you want to request?`;
          } else {
            session.currentItem = { isNew: true, itemCode: code };
            session.step = 'NEW_ITEM_NAME';
            reply = `Item code: **${code}** _(new — will be created in SAP on posting)_\n\nPlease enter the **item name / description**:`;
          }
        }
      }

      // ── NEW_ITEM_NAME ─────────────────────────────────────────────────────────
      else if (session.step === 'NEW_ITEM_NAME') {
        const name = msg.trim();
        if (!name) { reply = 'Please enter the item name:'; }
        else {
          session.currentItem.itemName = name;
          session.step = 'NEW_ITEM_QTY';
          reply = `Item: **${session.currentItem.itemCode}** — ${name}\n\nHow many units do you want to request?`;
        }
      }

      // ── NEW_ITEM_QTY ──────────────────────────────────────────────────────────
      else if (session.step === 'NEW_ITEM_QTY') {
        const qtyRaw = msg.replace(/,/g, '').match(/[\d.]+/);
        const qty = qtyRaw ? parseFloat(qtyRaw[0]) : NaN;
        if (!qty || qty <= 0 || isNaN(qty)) {
          reply = 'Please enter a valid quantity (e.g. 20):';
        } else {
          session.currentItem.qty = qty;
          session.currentItem.unit = 'EA';
          session.currentItem.unitPrice = 0;
          session.step = 'NEW_ITEM_WAREHOUSE';
          session._warehouses = await getWarehouses(sap);
          warehouseList = session._warehouses;
          reply = `**${qty} units** noted.\n\n**Select the warehouse** this should be requested for, or choose **Skip**:`;
          quickReplies = ['Skip'];
        }
      }

      // ── NEW_ITEM_WAREHOUSE ────────────────────────────────────────────────────
      else if (session.step === 'NEW_ITEM_WAREHOUSE' && !/skip|none/i.test(msgL)
               && resolveWarehouse(msg, session._warehouses || []) === undefined) {
        reply = `Warehouse **${msg}** was not found — please select one from the list:`;
        warehouseList = session._warehouses;
      }
      else if (session.step === 'NEW_ITEM_WAREHOUSE') {
        const whs = /skip|none/i.test(msgL) ? null : resolveWarehouse(msg, session._warehouses || []);

        session.prLines.push({
          itemCode:      session.currentItem.itemCode,
          itemName:      session.currentItem.itemName,
          qty:           session.currentItem.qty,
          unit:          'EA',
          unitPrice:     0,
          warehouseCode: whs || '',
          isNew:         session.currentItem.isNew !== false,
        });
        session.currentItem = null;

        session.step = 'ADD_MORE_ITEMS';
        reply = `✅ Item added.\n\n**Current PR (${session.prLines.length} line${session.prLines.length !== 1 ? 's' : ''}):**\n` +
          session.prLines.map((l, i) => `${i + 1}. **${l.itemCode}** — ${l.itemName} — Qty: ${fmtN(l.qty, 0)} ${l.unit}${l.warehouseCode ? ` — Whs: ${l.warehouseCode}` : ''}`).join('\n') +
          `\n\nWould you like to **add another item** or **proceed to vendor/header details**?`;
        quickReplies = ['Add Another Item', 'Proceed to Header'];
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
          if (!vendors.length) {
            session.vendor = { cardCode: msg.trim().toUpperCase(), cardName: msg.trim() };
            session.step = 'DUE_DATE';
            reply = `Vendor set to **${msg.trim().toUpperCase()}**.\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
            quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
          } else if (vendors.length === 1) {
            session.vendor = { cardCode: vendors[0].CardCode, cardName: vendors[0].CardName };
            session.step = 'DUE_DATE';
            reply = `✅ Vendor: **${vendors[0].CardCode} — ${vendors[0].CardName}**\n\n**When is this required by?** (e.g. ${datePlusDays(7)} or "skip" for today):`;
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

        if (sel) {
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

      // ── COMMENTS ─────────────────────────────────────────────────────────────
      else if (session.step === 'COMMENTS') {
        session.comments = /^skip$|^none$/i.test(msgL) ? null : msg || null;
        session.step = 'CONFIRM';
        const summary = buildPRSummary(session);
        reply = `${summary}\n\n---\n\n**Would you like to post this Purchase Request to SAP B1?**`;
        quickReplies = ['✅ Yes, Post to SAP', '❌ Cancel', '✏️ Edit'];
        meta = { prLines: session.prLines, vendor: session.vendor, dueDate: session.dueDate };
      }

      // ── CONFIRM ───────────────────────────────────────────────────────────────
      else if (session.step === 'CONFIRM') {
        if (/yes|post|confirm|submit|✅/i.test(msgL) && !/no|cancel/i.test(msgL)) {
          session.step = 'POSTING';
          try {
            // Create any new items in the item master first, otherwise SAP rejects the PR lines
            const created = [];
            for (const l of session.prLines.filter(x => x.isNew && !x._created)) {
              const exists = await findItemByCode(sap, l.itemCode);
              if (exists?.ItemCode) {
                l.itemCode = exists.ItemCode; // use SAP's exact casing
              } else {
                try {
                  await createItemMaster(sap, l);
                  created.push(l.itemCode);
                } catch (e) {
                  throw new Error(`Could not create new item ${l.itemCode} in item master: ${e.message}`);
                }
              }
              l._created = true;
            }

            const prPayload = {
              DocDate:      sapDate(today()),
              DocDueDate:   sapDate(session.dueDate || today()),
              RequriedDate: sapDate(session.dueDate || today()), // SAP B1 typo — "RequriedDate"
              ...(session.vendor?.cardCode ? { CardCode: session.vendor.cardCode } : {}),
              ...(session.comments         ? { Comments: session.comments }         : {}),
              DocumentLines: session.prLines.map(l => ({
                ItemCode:     l.itemCode,
                Quantity:     l.qty,
                RequiredDate: sapDate(session.dueDate || today()),
                ...(l.unitPrice > 0 ? { UnitPrice:     l.unitPrice     } : {}),
                ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
              })),
            };
            const result = await sap.post('/PurchaseRequests', prPayload);
            session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
            session.step = 'DONE';

            reply = `### ✅ Purchase Request Created!\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **Document #** | ${result.DocNum} |\n` +
              `| **Doc Entry** | ${result.DocEntry} |\n` +
              `| **Date** | ${today()} |\n` +
              `| **Required By** | ${session.dueDate || today()} |\n` +
              `| **Vendor** | ${session.vendor ? `${session.vendor.cardCode} — ${session.vendor.cardName}` : '_(Open)_'} |\n` +
              `| **Lines** | ${session.prLines.length} |\n\n` +
              (created.length ? `🆕 New item(s) created in item master: **${created.join(', ')}**\n\n` : '') +
              `[🖨️ Print Requisition](/api/pr-agent/print/${result.DocEntry}){:target="_blank"}\n\n` +
              `Would you like to create **another purchase request**?`;
            quickReplies = ['Yes, New PR', 'No, Done'];
            meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl: `/api/pr-agent/print/${result.DocEntry}` };

          } catch (e) {
            session.step = 'CONFIRM';
            reply = `❌ **Failed to post Purchase Request**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
            quickReplies = ['✅ Yes, Post to SAP', '❌ Cancel'];
          }

        } else if (/edit|change|modify|back|✏️/i.test(msgL)) {
          session.step = 'VENDOR';
          const editVendors = await searchVendors(sap, '');
          const hint = session._suggestedVendorCode
            ? `\n\n_(Suggested: **${session._suggestedVendorCode}**)_`
            : '';
          reply = `Let's revisit the header details.\n\n**Change the vendor?**${hint}\n\nSelect from the list or type **skip**:`;
          quickReplies = session._suggestedVendorCode ? [`Use ${session._suggestedVendorCode}`, 'Skip'] : ['Skip'];
          if (editVendors.length > 0)
            vendorComboList = editVendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        } else {
          _sessions.set(sid, initSession());
          reply = `Purchase request **cancelled**. Come back anytime!\n\nType **"start"** to create a new purchase request.`;
          quickReplies = ['Start New PR'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|new|another|start/i.test(msgL)) {
          _sessions.set(sid, initSession());
          const fresh = _sessions.get(sid);
          fresh.step = 'ITEM_TYPE';
          reply = `Great! Let's create a new purchase request.\n\nIs this for a **new item** or an **existing item**?`;
          quickReplies = ['Existing Item', 'New Item'];
        } else {
          reply = `Thank you! Your purchase request has been processed successfully.\n\nType **"start"** to create another purchase request anytime.`;
          quickReplies = ['Start New PR'];
        }
      }

      // ── Unknown / reset ────────────────────────────────────────────────────────
      else {
        _sessions.set(sid, initSession());
        const fresh = _sessions.get(sid);
        fresh.step = 'ITEM_TYPE';
        reply = `Let me start over.\n\nIs this for a **new item** or an **existing item**?`;
        quickReplies = ['Existing Item', 'New Item'];
      }

      // ── Optionally enrich reply with AI narrative ──────────────────────────────
      // Only for non-critical structural steps — AI adds warmth without changing data
      const aiEnhanceable = ['ITEM_TYPE', 'ADD_MORE_ITEMS', 'DUE_DATE', 'COMMENTS', 'DONE'];
      if (aiDeps.USE_AI && aiEnhanceable.includes(session.step) && session.history.length >= 4) {
        const system = `You are a Purchase Requisition Assistant for SAP Business One. The user is creating a purchase request. Be very concise (1-2 sentences max), professional, and encouraging. Do NOT repeat factual data already shown. Just add a brief natural-language acknowledgement or tip relevant to the current step "${session.step}". Current PR has ${session.prLines.length} lines.`;
        const aiNarrative = await callAI(aiDeps, [{ role: 'user', content: msg || 'continue' }], system, 150);
        if (aiNarrative?.trim()) reply = `_${aiNarrative.trim()}_\n\n${reply}`;
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 50) session.history.splice(0, session.history.length - 50);

      res.json({
        ok: true,
        reply,
        quickReplies,
        sessionId: sid,
        step: session.step,
        prLines: session.prLines || [],
        vendor: session.vendor,
        dueDate: session.dueDate,
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
      res.send(renderPRPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading purchase request #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}

// ── Print HTML renderer ────────────────────────────────────────────────────────
function renderPRPrint(doc) {
  const company  = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines    = doc.DocumentLines || [];
  const docDate  = doc.DocDate    ? doc.DocDate.slice(0, 10)    : '—';
  const dueDate  = doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : '—';
  const printedOn = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong>${l.ItemCode || ''}</strong></td>
      <td>${l.ItemDescription || ''}</td>
      <td style="text-align:right">${Number(l.Quantity || 0).toFixed(2)}</td>
      <td>${l.UoMCode || l.MeasureUnit || ''}</td>
      <td style="text-align:right">${Number(l.UnitPrice || 0) > 0 ? Number(l.UnitPrice).toFixed(2) : '—'}</td>
      <td style="text-align:right">${Number(l.LineTotal || 0) > 0 ? Number(l.LineTotal).toFixed(2) : '—'}</td>
      <td>${l.WarehouseCode || ''}</td>
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
    <div class="info-val"><strong>${doc.Creator || '—'}</strong></div>
    <div class="info-val" style="color:#666">Entry #${doc.DocEntry}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Dates</div>
    <div class="info-val">Doc Date: <strong>${docDate}</strong></div>
    <div class="info-val">Required By: <strong>${dueDate}</strong></div>
  </div>
  <div class="info-box">
    <div class="info-label">Preferred Vendor</div>
    <div class="info-val"><strong>${doc.CardName || '—'}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${doc.CardCode}</div>` : '<div class="info-val" style="color:#aaa;font-style:italic">Not specified — open for quotation</div>'}
  </div>
</div>

${doc.Comments ? `<div class="comments-box"><strong>📝 Comments / Notes:</strong><br><br>${doc.Comments}</div>` : ''}

<table>
  <thead>
    <tr>
      <th>#</th><th>Item Code</th><th>Description</th>
      <th style="text-align:right">Quantity</th><th>Unit</th>
      <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
      <th>Warehouse</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>

${grandTotal > 0 ? `
<div class="totals">
  <div class="total-grand">Estimated Total: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
</div>` : ''}

<div class="sig-section">
  <div class="sig-box"><div class="sig-line">Requested By</div></div>
  <div class="sig-box"><div class="sig-line">Approved By</div></div>
  <div class="sig-box"><div class="sig-line">Procurement Manager</div></div>
</div>

<div class="footer">
  Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 Purchase Requisition #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution
</div>
</body>
</html>`;
}
