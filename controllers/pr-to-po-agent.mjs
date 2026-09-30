/**
 * PR-to-PO Chat Agent — converts open Purchase Requests into a Purchase Order
 * Mounted at /api/pr-to-po by chat-server.mjs
 *
 * Flow: INIT → SELECT_PRS → CONFIRM_VENDOR? → CONFIRM_DATE → CONFIRM_COMMENTS → REVIEW → POSTING → DONE
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:            'INIT',
    history:         [],
    openPRs:         [],   // { docEntry, docNum, docDate, reqDate, cardCode, cardName, selected }
    selectedEntries: [],   // docEntry numbers user has chosen
    mergedLines:     [],   // PO lines accumulated from selected PRs
    vendor:          null, // { cardCode, cardName }
    dueDate:         null,
    comments:        null,
    result:          null,
    _vendorResults:  null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function today()        { return new Date().toISOString().slice(0, 10); }
function sapDate(s)     { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }
function datePlusDays(n){ const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
// Live SAP item-master fallback for UoMCode when a PR line didn't carry one —
// mirrors the same fix applied in po-agent.mjs for the standalone PO Agent.
async function getDefaultUoMCode(itemCode, sap) {
  try {
    const item = await sap.get(`/Items('${itemCode}')`, { $select: 'ItemCode,PurchaseUnit,InventoryUOM,SalesUnit' });
    return item?.PurchaseUnit || item?.InventoryUOM || item?.SalesUnit || undefined;
  } catch {
    return undefined;
  }
}
function parseDate(str) {
  if (!str) return null;
  const s = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

// ── AI helper ──────────────────────────────────────────────────────────────────
async function callAI(aiDeps, messages, system, maxTokens = 400) {
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
  } catch (e) { console.error('[PR-TO-PO] AI error:', e.message); }
  return null;
}

// ── SAP helpers ────────────────────────────────────────────────────────────────
async function fetchOpenPRHeaders(sap) {
  try {
    // No $select — CardCode/CardName are invalid $select fields on PurchaseRequests
    const r = await sap.get('/PurchaseRequests', {
      $filter: `DocumentStatus eq 'bost_Open'`,
      $orderby: 'DocDate asc',
      $top: 100,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[PR-TO-PO] fetchOpenPRHeaders error:', e.message);
    return [];
  }
}

async function fetchPRFull(sap, docEntry) {
  try {
    return await sap.get(`/PurchaseRequests(${parseInt(docEntry, 10)})`);
  } catch { return null; }
}

async function searchVendors(sap, query) {
  const esc = (query || '').replace(/'/g, "''");
  const base = `CardType eq 'cSupplier' and Frozen eq 'tNO'`;
  const filter = esc
    ? `(CardCode eq '${esc}' or contains(CardName,'${esc}')) and ${base}`
    : base;
  try {
    const r = await sap.get('/BusinessPartners', {
      $select: 'CardCode,CardName', $filter: filter, $top: 20, $orderby: 'CardName asc',
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch { return []; }
}

// ── Analysis builder ───────────────────────────────────────────────────────────
function buildPRAnalysis(prs) {
  if (!prs.length) {
    return `## 🔄 PR → PO Conversion Agent\n\n> ✅ **No open Purchase Requests** found in SAP B1. All PRs have been fulfilled or closed.`;
  }

  // Group by vendor
  const byVendor = {};
  prs.forEach(p => {
    const key = p.cardCode || '__NONE__';
    if (!byVendor[key]) byVendor[key] = { cardCode: p.cardCode, cardName: p.cardName, prs: [] };
    byVendor[key].prs.push(p);
  });

  const tod = today();
  const overduePRs  = prs.filter(p => p.reqDate && p.reqDate < tod);
  const oldestDays  = prs.map(p => daysSince(p.docDate)).filter(n => n !== null).reduce((a, b) => Math.max(a, b), 0);
  const withVendor  = prs.filter(p => p.cardCode).length;
  const noVendor    = prs.length - withVendor;

  let text = `## 🔄 PR → PO Conversion Agent\n\n`;
  text += `**${prs.length} open Purchase Request${prs.length !== 1 ? 's' : ''}** across **${Object.keys(byVendor).length} vendor group${Object.keys(byVendor).length !== 1 ? 's' : ''}**`;
  if (oldestDays > 0) text += ` | Oldest: **${oldestDays}d ago**`;
  if (overduePRs.length > 0) text += ` | ⚠️ **${overduePRs.length} overdue**`;
  text += `\n\n`;

  // Vendor breakdown
  text += `### 📊 Pending PRs by Vendor\n\n`;
  text += `| Vendor | Code | PRs | Oldest | Overdue |\n|---|---|---|---|---|\n`;

  const sorted = Object.keys(byVendor).sort((a, b) => {
    if (a === '__NONE__') return 1;
    if (b === '__NONE__') return -1;
    return byVendor[b].prs.length - byVendor[a].prs.length;
  });

  sorted.forEach(key => {
    const vg = byVendor[key];
    const oldest  = vg.prs.map(p => daysSince(p.docDate)).filter(n => n !== null).reduce((a,b) => Math.max(a,b), 0);
    const ovCount = vg.prs.filter(p => p.reqDate && p.reqDate < tod).length;
    const vendorDisplay = key === '__NONE__' ? '_(No Vendor — open for quotation)_' : (vg.cardName || key);
    const codeDisplay   = key === '__NONE__' ? '—' : (vg.cardCode || '—');
    text += `| ${vendorDisplay} | ${codeDisplay} | **${vg.prs.length}** | ${oldest > 0 ? `${oldest}d` : '—'} | ${ovCount > 0 ? `⚠️ ${ovCount}` : '✅ None'} |\n`;
  });

  text += `\n`;
  if (withVendor > 0) text += `✅ **${withVendor} PR${withVendor !== 1 ? 's' : ''}** with assigned vendor — ready for direct conversion\n`;
  if (noVendor  > 0) text += `⚠️ **${noVendor} PR${noVendor  !== 1 ? 's' : ''}** without vendor — you will assign one during PO creation\n`;
  text += `\n**Select PR(s) from the list** (PRs with the same vendor can be merged into one PO). Click **Proceed** when ready.`;

  return text;
}

// ── PO summary ─────────────────────────────────────────────────────────────────
function buildPOSummary(session) {
  const { mergedLines, vendor, dueDate, comments, selectedEntries, openPRs } = session;
  const srcNums = openPRs.filter(p => selectedEntries.includes(p.docEntry)).map(p => `PR#${p.docNum}`).join(', ');

  let out = `### 📦 Purchase Order Preview\n\n`;
  out += `| Field | Value |\n|---|---|\n`;
  out += `| **Source PRs** | ${srcNums || '—'} |\n`;
  out += `| **Order Date** | ${today()} |\n`;
  out += `| **Required By** | ${dueDate || today()} |\n`;
  out += `| **Vendor** | ${vendor ? `${vendor.cardCode} — ${vendor.cardName}` : '_(Open — not specified)_'} |\n`;
  out += `| **Comments** | ${comments || '_(None)_'} |\n\n`;

  out += `#### Lines (${mergedLines.length})\n\n`;
  out += `| # | Item Code | Description | Qty | Unit | Unit Price | Total | Whs |\n`;
  out += `|---|---|---|---|---|---|---|---|\n`;
  let grand = 0;
  mergedLines.forEach((l, i) => {
    const lt = (l.qty || 0) * (l.unitPrice || 0);
    grand += lt;
    // Raw <input> tags — marked passes inline HTML through unmodified, so these render as
    // real editable fields right in the chat table, wired to the same ptpoEditLine()/
    // ptpoSyncLine() the PO Builder sidebar cards use (shared by index via data-idx).
    const priceInput = `<input type="number" class="ptpo-price-input" data-idx="${i}" min="0" step="0.01" value="${l.unitPrice || ''}" placeholder="0.00" oninput="ptpoEditLine(${i},'unitPrice',this.value,false)" onchange="ptpoEditLine(${i},'unitPrice',this.value,true)" style="width:70px;padding:2px 5px;font-size:12px;border:1px solid ${l.unitPrice > 0 ? '#ccc' : '#f59e0b'};border-radius:4px;text-align:right">`;
    const whInput    = `<input type="text" class="ptpo-wh-input" data-idx="${i}" value="${String(l.warehouseCode || '').replace(/"/g, '&quot;')}" placeholder="Whs" onchange="ptpoEditLine(${i},'warehouseCode',this.value,true)" style="width:50px;padding:2px 5px;font-size:12px;border:1px solid #ccc;border-radius:4px">`;
    out += `| ${i+1} | **${l.itemCode}** | ${l.itemName || '—'} | ${fmtN(l.qty,0)} | ${l.unit||'EA'} | ${priceInput} | <span data-lt="${i}">${lt > 0 ? fmtN(lt) : '—'}</span> | ${whInput} |\n`;
  });
  out += `\n**Estimated Total: <span data-grand-total>${fmtN(grand)}</span>**`;
  const missing = mergedLines.filter(l => !(l.unitPrice > 0)).length;
  if (missing > 0) out += `\n\n⚠️ **${missing} line(s)** have no unit price carried over from the PR — enter one in the table above.`;
  return out;
}

// ── Main router factory ────────────────────────────────────────────────────────
export function createPRtoPOAgentRouter(deps) {
  const { requireAuth, printAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `ptpo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap = getActiveSap();
      const msg  = message.trim();
      const msgL = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply       = '';
      let quickReplies = [];
      let meta        = {};
      let prList      = null;
      let vendorList  = null;

      // ── JSON actions — silent line edits from the summary panel ─────────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch {}
        if (action?.action === 'update_line') {
          const { idx, field } = action;
          if (Number.isInteger(idx) && session.mergedLines[idx] && ['unitPrice', 'warehouseCode', 'qty'].includes(field)) {
            session.mergedLines[idx][field] = field === 'warehouseCode'
              ? String(action.value ?? '')
              : (Number(action.value) || 0);
          }
        }
        reply = '';
      }

      // ── INIT / fresh load ────────────────────────────────────────────────────
      else if (session.step === 'INIT' || (!msg && session.step === 'INIT')) {
        const headers = await fetchOpenPRHeaders(sap);
        session.openPRs = headers.map(p => ({
          docEntry: p.DocEntry,
          docNum:   p.DocNum,
          docDate:  p.DocDate   ? p.DocDate.slice(0, 10)   : null,
          reqDate:  p.DocDueDate ? p.DocDueDate.slice(0, 10) : null,
          cardCode: p.CardCode || null,
          cardName: p.CardName || null,
          selected: false,
        }));
        session.step = 'SELECT_PRS';
        reply = buildPRAnalysis(session.openPRs);
        if (session.openPRs.length > 0) {
          prList = session.openPRs.map(p => ({ ...p }));
        } else {
          quickReplies = ['Refresh'];
        }
      }

      // ── SELECT_PRS ────────────────────────────────────────────────────────────
      else if (session.step === 'SELECT_PRS') {
        const isProceed  = /^(proceed|done|convert|next|→|continue|yes)/i.test(msgL);
        const isClear    = /clear|reset|deselect all/i.test(msgL);
        const prNumMatch = msg.match(/PR#(\d+)/i) || (!isProceed && msg.match(/^(\d+)$/));

        if (isClear) {
          session.selectedEntries = [];
          session.openPRs.forEach(p => { p.selected = false; });
          reply = `Selection cleared. **${session.openPRs.length}** open PRs available — select again:`;
          prList = session.openPRs.map(p => ({ ...p, selected: false }));

        } else if (prNumMatch && !isProceed) {
          const docNum = parseInt(prNumMatch[1]);
          const pr = session.openPRs.find(p => p.docNum === docNum);
          if (!pr) {
            reply = `PR#${docNum} not found. Please select from the list:`;
            prList = session.openPRs.map(p => ({ ...p, selected: session.selectedEntries.includes(p.docEntry) }));
          } else {
            const already = session.selectedEntries.includes(pr.docEntry);
            if (already) {
              // Deselect
              session.selectedEntries = session.selectedEntries.filter(e => e !== pr.docEntry);
              pr.selected = false;
              reply = `PR#${pr.docNum} removed. **${session.selectedEntries.length}** PR(s) selected.`;
            } else {
              // Check vendor conflict warning
              const existingCodes = new Set(
                session.openPRs.filter(p => session.selectedEntries.includes(p.docEntry)).map(p => p.cardCode || null)
              );
              const newCode = pr.cardCode || null;
              const hasConflict = existingCodes.size > 0 && newCode && !existingCodes.has(newCode)
                && !Array.from(existingCodes).every(c => c === null);

              session.selectedEntries.push(pr.docEntry);
              pr.selected = true;

              if (hasConflict) {
                reply = `⚠️ **Mixed vendors:** PR#${pr.docNum} has a different vendor (${pr.cardName || 'No vendor'}). You will specify a single vendor for the combined PO.\n\n**${session.selectedEntries.length}** PR(s) selected.`;
              } else {
                reply = `✅ **PR#${pr.docNum}** added (${pr.cardName || 'No vendor'}). **${session.selectedEntries.length}** PR(s) selected.`;
              }
            }
            prList = session.openPRs.map(p => ({ ...p, selected: session.selectedEntries.includes(p.docEntry) }));
            if (session.selectedEntries.length > 0)
              quickReplies = [`Proceed with ${session.selectedEntries.length} PR(s) →`, 'Clear Selection'];
          }

        } else if (isProceed || (session.selectedEntries.length > 0 && msg === '')) {
          if (!session.selectedEntries.length) {
            reply = `Please select at least one PR first.`;
            prList = session.openPRs.map(p => ({ ...p, selected: false }));
          } else {
            // Fetch full details + merge lines
            const merged = [];
            let autoVendorCode = null; let autoVendorName = null; let mixedVendors = false;

            for (const de of session.selectedEntries) {
              const full = await fetchPRFull(sap, de);
              if (!full) continue;
              for (const line of (full.DocumentLines || [])) {
                if (line.LineStatus !== 'bost_Closed' && line.ItemCode) {
                  merged.push({
                    itemCode:      line.ItemCode,
                    itemName:      line.ItemDescription || line.ItemCode,
                    qty:           Number(line.Quantity || 1),
                    unit:          line.UoMCode || line.MeasureUnit || 'EA',
                    uomCode:       line.UoMCode || line.MeasureUnit || '',
                    unitPrice:     Number(line.UnitPrice || line.Price || 0),
                    warehouseCode: line.WarehouseCode || '',
                    sourcePR:      full.DocNum,
                    // Needed to "Copy From" link the PO line back to its PR line — without this,
                    // SAP never marks the PR line as drawn, so the PR stays open and reappears
                    // in the list, letting the same PR be converted again and again.
                    baseEntry:     full.DocEntry,
                    baseLine:      line.LineNum,
                  });
                }
              }
              // Vendor tracking
              if (full.CardCode) {
                if (autoVendorCode === null) { autoVendorCode = full.CardCode; autoVendorName = full.CardName; }
                else if (autoVendorCode !== full.CardCode) mixedVendors = true;
              }
            }

            session.mergedLines = merged;
            const selNums = session.openPRs.filter(p => session.selectedEntries.includes(p.docEntry)).map(p => `PR#${p.docNum}`).join(', ');

            if (merged.length === 0) {
              reply = `No open lines found in the selected PRs. They may already be fully closed. Please select different PRs.`;
              prList = session.openPRs.map(p => ({ ...p, selected: session.selectedEntries.includes(p.docEntry) }));
              quickReplies = ['Clear Selection'];
            } else if (mixedVendors || (!autoVendorCode)) {
              // Need vendor
              const vendors = await searchVendors(sap, '');
              session.vendor = null;
              session.step = 'CONFIRM_VENDOR';
              const reason = mixedVendors ? 'The selected PRs have **different vendors**' : 'The selected PRs have **no vendor assigned**';
              reply = `Collected **${merged.length} line(s)** from **${selNums}**.\n\n${reason} — please select a vendor for this PO:`;
              quickReplies = ['Skip (Open Order)'];
              if (vendors.length > 0) vendorList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
            } else {
              // Single consistent vendor
              session.vendor = { cardCode: autoVendorCode, cardName: autoVendorName || autoVendorCode };
              session.step = 'CONFIRM_DATE';
              reply = `✅ **${merged.length} line(s)** from **${selNums}**.\n\n**Vendor**: ${autoVendorCode} — ${autoVendorName}\n\n**When is this order required by?**`;
              quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
            }
          }

        } else {
          reply = `Please select PR(s) from the list, or say **"proceed"** to continue (${session.selectedEntries.length} selected so far).`;
          prList = session.openPRs.map(p => ({ ...p, selected: session.selectedEntries.includes(p.docEntry) }));
          if (session.selectedEntries.length > 0)
            quickReplies = [`Proceed with ${session.selectedEntries.length} PR(s) →`, 'Clear Selection'];
        }
      }

      // ── CONFIRM_VENDOR ────────────────────────────────────────────────────────
      else if (session.step === 'CONFIRM_VENDOR') {
        if (/skip|none|open|no vendor/i.test(msgL)) {
          session.vendor = null;
          session.step = 'CONFIRM_DATE';
          reply = `Proceeding without a specific vendor (open order).\n\n**When is this order required by?**`;
          quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
        } else {
          let query = msg.trim();
          if (msg.includes(' — ')) query = msg.split(' — ')[0].trim();
          const vendors = await searchVendors(sap, query);
          if (!vendors.length) {
            session.vendor = { cardCode: msg.trim().toUpperCase(), cardName: msg.trim() };
            session.step = 'CONFIRM_DATE';
            reply = `Vendor set to **${session.vendor.cardCode}**.\n\n**When is this order required by?**`;
            quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
          } else if (vendors.length === 1) {
            session.vendor = { cardCode: vendors[0].CardCode, cardName: vendors[0].CardName };
            session.step = 'CONFIRM_DATE';
            reply = `✅ Vendor: **${vendors[0].CardCode} — ${vendors[0].CardName}**\n\n**When is this order required by?**`;
            quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
          } else {
            session._vendorResults = vendors;
            session.step = 'VENDOR_SELECT';
            reply = `Found **${vendors.length}** vendor(s) — select one:`;
            vendorList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
          }
        }
      }

      // ── VENDOR_SELECT ─────────────────────────────────────────────────────────
      else if (session.step === 'VENDOR_SELECT') {
        const vendors = session._vendorResults || [];
        let sel = null;
        const numM = msg.match(/^(\d+)$/);
        if (numM) { const i = parseInt(numM[1]) - 1; if (i >= 0 && i < vendors.length) sel = vendors[i]; }
        if (!sel && msg.includes(' — ')) {
          const code = msg.split(' — ')[0].trim();
          sel = vendors.find(v => v.CardCode.toLowerCase() === code.toLowerCase());
        }
        if (!sel) sel = vendors.find(v => v.CardCode.toLowerCase() === msgL);
        if (sel) {
          session.vendor = { cardCode: sel.CardCode, cardName: sel.CardName };
          session.step = 'CONFIRM_DATE';
          reply = `✅ Vendor: **${sel.CardCode} — ${sel.CardName}**\n\n**When is this order required by?**`;
          quickReplies = [datePlusDays(7), datePlusDays(14), 'Skip (today)'];
        } else {
          reply = `Could not find that vendor — please select from the list:`;
          vendorList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        }
      }

      // ── CONFIRM_DATE ──────────────────────────────────────────────────────────
      else if (session.step === 'CONFIRM_DATE') {
        session.dueDate = /skip|today|now/i.test(msgL) ? today() : (parseDate(msg) || today());
        session.step = 'CONFIRM_COMMENTS';
        reply = `Due date: **${session.dueDate}**\n\nAny **comments** for this Purchase Order? _(or "skip")_`;
        quickReplies = ['Skip', 'Urgent — please expedite delivery', 'Standard procurement order'];
      }

      // ── CONFIRM_COMMENTS ──────────────────────────────────────────────────────
      else if (session.step === 'CONFIRM_COMMENTS') {
        session.comments = /^skip$|^none$/i.test(msgL) ? null : msg || null;
        session.step = 'REVIEW';
        const summary = buildPOSummary(session);
        reply = `${summary}\n\n---\n\n**Ready to post this Purchase Order to SAP B1?**`;
        quickReplies = ['✅ Yes, Post PO to SAP', '❌ Cancel', '✏️ Edit Vendor'];
        meta = { mergedLines: session.mergedLines, vendor: session.vendor, dueDate: session.dueDate };
      }

      // ── REVIEW ────────────────────────────────────────────────────────────────
      else if (session.step === 'REVIEW') {
        if (/yes|post|confirm|submit|✅/i.test(msgL) && !/no|cancel/i.test(msgL)) {
          session.step = 'POSTING';
          try {
            const uomCodes = await Promise.all(session.mergedLines.map(l =>
              l.uomCode ? Promise.resolve(l.uomCode) : getDefaultUoMCode(l.itemCode, sap)));
            const poPayload = {
              DocDate:    sapDate(today()),
              DocDueDate: sapDate(session.dueDate || today()),
              ...(session.vendor?.cardCode ? { CardCode: session.vendor.cardCode } : {}),
              ...(session.comments         ? { Comments: session.comments }         : {}),
              DocumentLines: session.mergedLines.map((l, i) => ({
                ItemCode:  l.itemCode,
                Quantity:  l.qty,
                ShipDate:  sapDate(session.dueDate || today()),
                ...(l.unitPrice > 0 ? { UnitPrice:     l.unitPrice     } : {}),
                ...(l.warehouseCode ? { WarehouseCode: l.warehouseCode } : {}),
                ...(uomCodes[i]     ? { UoMCode:        uomCodes[i]     } : {}),
                // "Copy From" link back to the source PR line — this is what makes SAP mark
                // the PR line as drawn/closed once the PO posts, instead of leaving the PR open.
                ...(l.baseEntry != null && l.baseLine != null
                  ? { BaseType: 1470000113, BaseEntry: Number(l.baseEntry), BaseLine: Number(l.baseLine) }
                  : {}),
              })),
            };

            const result = await sap.post('/PurchaseOrders', poPayload);
            session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
            session.step = 'DONE';

            const srcNums = session.openPRs
              .filter(p => session.selectedEntries.includes(p.docEntry))
              .map(p => `PR#${p.docNum}`).join(', ');

            reply = `### ✅ Purchase Order Created!\n\n` +
              `| Field | Value |\n|---|---|\n` +
              `| **PO Number** | ${result.DocNum} |\n` +
              `| **Doc Entry** | ${result.DocEntry} |\n` +
              `| **Order Date** | ${today()} |\n` +
              `| **Required By** | ${session.dueDate || today()} |\n` +
              `| **Vendor** | ${session.vendor ? `${session.vendor.cardCode} — ${session.vendor.cardName}` : '_(Open)_'} |\n` +
              `| **Lines** | ${session.mergedLines.length} |\n` +
              `| **Source PRs** | ${srcNums} |\n\n` +
              `[🖨️ Print Purchase Order](/api/pr-to-po/print/${result.DocEntry}){:target="_blank"}\n\n` +
              `Would you like to **convert more PRs**?`;
            quickReplies = ['Yes, Convert More PRs', 'No, Done'];
            meta = { docEntry: result.DocEntry, docNum: result.DocNum, printUrl: `/api/pr-to-po/print/${result.DocEntry}` };

          } catch (e) {
            session.step = 'REVIEW';
            reply = `❌ **Failed to post Purchase Order**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
            quickReplies = ['✅ Yes, Post PO to SAP', '❌ Cancel'];
          }

        } else if (/edit|vendor|change|✏️/i.test(msgL)) {
          const vendors = await searchVendors(sap, '');
          session.step = 'CONFIRM_VENDOR';
          reply = `Let's update the vendor.\n\nCurrent: **${session.vendor ? `${session.vendor.cardCode} — ${session.vendor.cardName}` : 'Not set'}**\n\nSelect from the list or type to search:`;
          quickReplies = ['Skip (Open Order)'];
          if (vendors.length > 0) vendorList = vendors.map(v => ({ code: v.CardCode, name: v.CardName }));
        } else {
          _sessions.set(sid, initSession());
          reply = `Purchase order **cancelled**.\n\nSay **"start"** to begin a new conversion.`;
          quickReplies = ['Start New Conversion'];
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|more|another|convert|start/i.test(msgL)) {
          const newSession = initSession();
          const headers = await fetchOpenPRHeaders(sap);
          newSession.openPRs = headers.map(p => ({
            docEntry: p.DocEntry, docNum: p.DocNum,
            docDate:  p.DocDate  ? p.DocDate.slice(0,10) : null,
            reqDate:  (p.RequriedDate || p.DocDueDate) ? (p.RequriedDate || p.DocDueDate).slice(0,10) : null,
            cardCode: p.CardCode || null, cardName: p.CardName || null, selected: false,
          }));
          newSession.step = 'SELECT_PRS';
          _sessions.set(sid, newSession);
          reply = buildPRAnalysis(newSession.openPRs);
          if (newSession.openPRs.length > 0) prList = newSession.openPRs.map(p => ({ ...p }));
          else quickReplies = ['Refresh'];
        } else {
          reply = `Your purchase workflow is complete. Say **"start"** to convert more PRs anytime.`;
          quickReplies = ['Start New Conversion'];
        }
      }

      // ── Unknown / reset ────────────────────────────────────────────────────────
      else {
        const newSession = initSession();
        const headers = await fetchOpenPRHeaders(sap);
        newSession.openPRs = headers.map(p => ({
          docEntry: p.DocEntry, docNum: p.DocNum,
          docDate:  p.DocDate  ? p.DocDate.slice(0,10) : null,
          reqDate:  (p.RequriedDate || p.DocDueDate) ? (p.RequriedDate || p.DocDueDate).slice(0,10) : null,
          cardCode: p.CardCode || null, cardName: p.CardName || null, selected: false,
        }));
        newSession.step = 'SELECT_PRS';
        _sessions.set(sid, newSession);
        reply = buildPRAnalysis(newSession.openPRs);
        if (newSession.openPRs.length > 0) prList = newSession.openPRs.map(p => ({ ...p }));
      }

      const currentSession = _sessions.get(sid);
      currentSession.history.push({ role: 'assistant', content: reply });
      if (currentSession.history.length > 40)
        currentSession.history.splice(0, currentSession.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step:          currentSession.step,
        selectedCount: currentSession.selectedEntries.length,
        mergedLines:   currentSession.mergedLines || [],
        vendor:        currentSession.vendor,
        dueDate:       currentSession.dueDate,
        meta, prList, vendorList,
      });

    } catch (e) {
      console.error('[PR-TO-PO] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /detail/:docEntry — return PR header + lines for the popup ──────────────
  router.get('/detail/:docEntry', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await fetchPRFull(sap, req.params.docEntry);
      if (!doc) return res.status(404).json({ ok: false, error: 'PR not found' });
      res.json({
        ok:       true,
        docEntry: doc.DocEntry,
        docNum:   doc.DocNum,
        docDate:  doc.DocDate    ? doc.DocDate.slice(0, 10)    : null,
        dueDate:  doc.DocDueDate ? doc.DocDueDate.slice(0, 10) : null,
        cardCode: doc.CardCode   || null,
        cardName: doc.CardName   || null,
        comments: doc.Comments   || null,
        status:   doc.DocumentStatus,
        lines: (doc.DocumentLines || []).map(l => ({
          lineNum:    l.LineNum,
          itemCode:   l.ItemCode       || '',
          itemName:   l.ItemDescription || '',
          qty:        Number(l.Quantity  || 0),
          unit:       l.UoMCode || l.MeasureUnit || 'EA',
          unitPrice:  Number(l.UnitPrice || l.Price || 0),
          lineTotal:  Number(l.LineTotal || 0),
          warehouse:  l.WarehouseCode  || '',
          lineStatus: l.LineStatus     || '',
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // POST /reset ──────────────────────────────────────────────────────────────────
  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // GET /print/:docEntry ─────────────────────────────────────────────────────────
  router.get('/print/:docEntry', printAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseOrders(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderPOPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading PO #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}

// ── Print HTML renderer ────────────────────────────────────────────────────────
function renderPOPrint(doc) {
  const company    = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines      = doc.DocumentLines || [];
  const docDate    = doc.DocDate    ? doc.DocDate.slice(0,10)    : '—';
  const dueDate    = doc.DocDueDate ? doc.DocDueDate.slice(0,10) : '—';
  const printedOn  = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
  const grandTotal = lines.reduce((s, l) => s + Number(l.LineTotal || 0), 0);

  const linesHtml = lines.map((l, i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${l.ItemCode||''}</strong></td>
      <td>${l.ItemDescription||''}</td>
      <td style="text-align:right">${Number(l.Quantity||0).toFixed(2)}</td>
      <td>${l.UoMCode||l.MeasureUnit||''}</td>
      <td style="text-align:right">${Number(l.UnitPrice||0) > 0 ? Number(l.UnitPrice).toFixed(2) : '—'}</td>
      <td style="text-align:right">${Number(l.LineTotal||0) > 0 ? Number(l.LineTotal).toFixed(2) : '—'}</td>
      <td>${l.WarehouseCode||''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Purchase Order #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
    .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
    .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
    .btn-print{background:#1a5c2e;color:#fff} .btn-close{background:#eee;color:#333}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #1a5c2e}
    .co-name{font-size:20px;font-weight:700;color:#1a1d27}
    .doc-title{font-size:18px;font-weight:700;color:#1a5c2e;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#1a5c2e}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#f7faf7}
    .totals{text-align:right;padding:12px 0 20px}
    .total-grand{font-size:14px;font-weight:700;color:#1a5c2e}
    .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
    .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:center}
    .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
    .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:70px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
    @media print{.print-btn{display:none}}
  </style>
</head>
<body>
<div class="watermark">PURCHASE ORDER</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.parent!==window ? window.parent.postMessage({type:'poa-print-close'},'*') : window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${company}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Purchase Order (from PR Conversion)</div>
  </div>
  <div>
    <div class="doc-title">Purchase Order</div>
    <div class="doc-num">PO # ${doc.DocNum}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${doc.CardName||'—'}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${doc.CardCode}</div>` : '<div class="info-val" style="color:#aaa;font-style:italic">Open order</div>'}
  </div>
  <div class="info-box">
    <div class="info-label">Dates</div>
    <div class="info-val">Order Date: <strong>${docDate}</strong></div>
    <div class="info-val">Required By: <strong>${dueDate}</strong></div>
  </div>
  <div class="info-box">
    <div class="info-label">Reference</div>
    <div class="info-val">PO # <strong>${doc.DocNum}</strong></div>
    <div class="info-val" style="color:#666">Entry # ${doc.DocEntry}</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#fffef5;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong><br><br>${doc.Comments}</div>` : ''}
<table>
  <thead>
    <tr>
      <th>#</th><th>Item Code</th><th>Description</th>
      <th style="text-align:right">Qty</th><th>Unit</th>
      <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
      <th>Warehouse</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>
${grandTotal > 0 ? `<div class="totals"><div class="total-grand">Total: ${grandTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>` : ''}
<div class="sig-section">
  <div><div class="sig-line">Ordered By</div></div>
  <div><div class="sig-line">Approved By</div></div>
  <div><div class="sig-line">Received By</div></div>
</div>
<div class="footer">
  Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 Purchase Order #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution
</div>
</body>
</html>`;
}
