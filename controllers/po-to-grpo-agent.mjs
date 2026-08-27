/**
 * PO-to-GRPO Agent — redesigned flow:
 *  1. Vendor list with open PO counts → user selects supplier
 *  2. PO list for that supplier → user selects one PO
 *  3. Line-entry modal → user edits qty / price per line → posts GRPO
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:           'INIT',
    history:        [],
    allPOs:         [],      // raw PO headers from SAP
    vendorGroups:   [],      // [{cardCode,cardName,poCount,totalValue,overduePOs,oldestDate,pos:[]}]
    selectedVendor: null,    // {cardCode,cardName}
    vendorPOs:      [],      // [{docEntry,docNum,docDate,dueDate,docTotal}]
    selectedPODoc:  null,    // full PO document (with lines)
    itemMgmtMap:    {},      // {itemCode: 'none'|'batch'|'serial'}
    result:         null,    // {docEntry,docNum}
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function today()    { return new Date().toISOString().slice(0, 10); }
function sapDate(s) { const d = s || today(); return d.length === 10 ? `${d}T00:00:00` : d; }

// ── SAP helpers ────────────────────────────────────────────────────────────────
async function fetchAllOpenPOs(sap) {
  // Try with $select first (headers only — much faster); fall back if SAP rejects
  const params = {
    $filter:  `DocumentStatus eq 'bost_Open'`,
    $orderby: 'DocDate asc',
    $top:     200,
  };
  try {
    const r = await sap.get('/PurchaseOrders', {
      ...params,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,DocumentStatus',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected — fall through */ }
  try {
    const r = await sap.get('/PurchaseOrders', params);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[PO-TO-GRPO] fetchAllOpenPOs error:', e.message);
    return [];
  }
}

async function fetchPOFull(sap, docEntry) {
  try {
    return await sap.get(`/PurchaseOrders(${parseInt(docEntry, 10)})`);
  } catch { return null; }
}

// Fetch batch/serial management type for a list of item codes
async function fetchItemManagement(sap, itemCodes) {
  const unique = [...new Set((itemCodes || []).filter(Boolean))];
  if (!unique.length) return {};
  const map = {};
  for (let i = 0; i < unique.length; i += 15) {
    const chunk = unique.slice(i, i + 15);
    const filter = chunk.map(c => `ItemCode eq '${c.replace(/'/g, "''")}'`).join(' or ');
    try {
      const r = await sap.get('/Items', {
        $select: 'ItemCode,ManageBatchNumbers,ManageSerialNumbers',
        $filter: filter,
        $top: chunk.length,
      });
      for (const item of (r.value || [])) {
        if (item.ManageSerialNumbers === 'tYES') map[item.ItemCode] = 'serial';
        else if (item.ManageBatchNumbers === 'tYES') map[item.ItemCode] = 'batch';
        else map[item.ItemCode] = 'none';
      }
    } catch (e) {
      console.error('[PO-TO-GRPO] fetchItemManagement error:', e.message);
    }
  }
  return map;
}

// ── Group by vendor ────────────────────────────────────────────────────────────
function groupByVendor(pos) {
  const map = {};
  const tod = today();
  pos.forEach(p => {
    const key = p.CardCode || '__NONE__';
    if (!map[key]) map[key] = {
      cardCode: p.CardCode || null, cardName: p.CardName || null,
      pos: [], totalValue: 0, overduePOs: 0, oldestDate: null,
    };
    map[key].pos.push(p);
    map[key].totalValue += Number(p.DocTotal || 0);
    const due = p.DocDueDate ? p.DocDueDate.slice(0, 10) : null;
    if (due && due < tod) map[key].overduePOs++;
    const dt  = p.DocDate   ? p.DocDate.slice(0, 10)    : null;
    if (dt && (!map[key].oldestDate || dt < map[key].oldestDate)) map[key].oldestDate = dt;
  });
  return Object.values(map)
    .map(g => ({ ...g, poCount: g.pos.length }))
    .sort((a, b) => b.poCount - a.poCount);
}

// ── Build poDetail from full PO document ───────────────────────────────────────
function buildPODetail(full, mgmtMap = {}) {
  return {
    docEntry: full.DocEntry,
    docNum:   full.DocNum,
    docDate:  full.DocDate    ? full.DocDate.slice(0, 10)    : null,
    dueDate:  full.DocDueDate ? full.DocDueDate.slice(0, 10) : null,
    cardCode: full.CardCode   || null,
    cardName: full.CardName   || null,
    comments: full.Comments   || null,
    lines: (full.DocumentLines || [])
      .filter(l => l.LineStatus !== 'bost_Closed' && l.ItemCode && Number(l.RemainingOpenQuantity || 0) > 0)
      .map(l => ({
        lineNum:    l.LineNum,
        baseLine:   l.LineNum,
        itemCode:   l.ItemCode,
        itemName:   l.ItemDescription || l.ItemCode,
        orderedQty: Number(l.Quantity              || 0),
        openQty:    Number(l.RemainingOpenQuantity || 0),
        unit:       l.UoMCode || l.MeasureUnit || 'EA',
        unitPrice:  Number(l.UnitPrice || l.Price || 0),
        warehouse:  l.WarehouseCode || '',
        managedBy:  mgmtMap[l.ItemCode] || 'none',
      })),
  };
}

// ── Vendor summary text ────────────────────────────────────────────────────────
function buildVendorSummaryText(groups, totalPOs) {
  const tod = today();
  const totalOverdue = groups.reduce((s, g) => s + g.overduePOs, 0);
  let t = `## 📦 PO → GRPO Receipt Agent\n\n`;
  t += `**${groups.length} supplier${groups.length !== 1 ? 's' : ''}** with **${totalPOs} open PO${totalPOs !== 1 ? 's' : ''}** pending receipt`;
  if (totalOverdue > 0) t += ` | ⚠️ **${totalOverdue} overdue**`;
  t += `\n\n### By Supplier\n\n`;
  t += `| Supplier | Code | Open POs | Open Value | Overdue |\n|---|---|---:|---:|---:|\n`;
  groups.forEach(g => {
    const name = g.cardName || '_(No Vendor)_';
    const code = g.cardCode || '—';
    t += `| ${name} | ${code} | **${g.poCount}** | ${fmtN(g.totalValue)} | ${g.overduePOs > 0 ? `⚠️ ${g.overduePOs}` : '✅ 0'} |\n`;
  });
  t += `\n**Click a supplier** below to view their open Purchase Orders:`;
  return t;
}

// ── Main router factory ────────────────────────────────────────────────────────
export function createPOtoGRPOAgentRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `grpo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap  = getActiveSap();
      const msg  = message.trim();
      const msgL = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply        = '';
      let quickReplies = [];
      let meta         = {};
      let vendorList   = null;
      let poList       = null;
      let poDetail     = null;

      // ── JSON action (post_grpo) ── checked first regardless of step ──────────
      if (msg.startsWith('{')) {
        let action = null;
        try { action = JSON.parse(msg); } catch (e) { /* fall through */ }

        if (action?.action === 'post_grpo' && session.selectedPODoc) {
          const full = session.selectedPODoc;
          const lines = action.lines || [];
          if (!lines.length) {
            reply = `❌ No lines to receive. Please enter quantities in the form.`;
            quickReplies = ['Retry', 'Cancel'];
          } else {
            try {
              const grpoPayload = {
                DocDate:    sapDate(action.receiptDate || today()),
                DocDueDate: sapDate(action.receiptDate || today()),
                ...(full.CardCode      ? { CardCode:  full.CardCode      } : {}),
                ...(action.numAtCard   ? { NumAtCard: action.numAtCard   } : {}),
                ...(action.comments    ? { Comments:  action.comments    } : {}),
                DocumentLines: lines.map(l => ({
                  BaseType:  22,
                  BaseEntry: Number(l.baseEntry),
                  BaseLine:  Number(l.baseLine),
                  Quantity:  Number(l.qty),
                  ...(Number(l.price) > 0 ? { UnitPrice: Number(l.price) } : {}),
                  ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
                  ...(l.batchNumbers?.length  ? { BatchNumbers:  l.batchNumbers  } : {}),
                  ...(l.serialNumbers?.length ? { SerialNumbers: l.serialNumbers } : {}),
                })),
              };
              const result = await sap.post('/PurchaseDeliveryNotes', grpoPayload);
              session.result = { docEntry: result.DocEntry, docNum: result.DocNum };
              session.step   = 'DONE';

              reply = `### ✅ Goods Receipt PO Created!\n\n` +
                `| Field | Value |\n|---|---|\n` +
                `| **GRPO Number** | ${result.DocNum} |\n` +
                `| **Doc Entry** | ${result.DocEntry} |\n` +
                `| **Receipt Date** | ${action.receiptDate || today()} |\n` +
                `| **Vendor** | ${full.CardName || full.CardCode || '—'} |\n` +
                `| **Lines Received** | ${lines.length} |\n` +
                `| **Source PO** | PO#${full.DocNum} |\n\n` +
                `[🖨️ Print Goods Receipt](/api/po-to-grpo/print/${result.DocEntry})\n\nWould you like to receive more POs?`;
              quickReplies = ['Yes, Receive More', 'No, Done'];
              meta = {
                docEntry:    result.DocEntry,
                docNum:      result.DocNum,
                printUrl:    `/api/po-to-grpo/print/${result.DocEntry}`,
                vendor:      { cardCode: full.CardCode, cardName: full.CardName },
                receiptDate: action.receiptDate || today(),
                lineCount:   lines.length,
              };
            } catch (e) {
              reply = `❌ **Failed to post Goods Receipt PO**\n\nSAP Error: _${e.message}_\n\nWould you like to **retry** or **cancel**?`;
              quickReplies = ['Retry', 'Cancel'];
            }
          }
        } else {
          reply = 'Please select a PO from the list.';
          poList = session.vendorPOs.map(p => ({ ...p, cardCode: session.selectedVendor?.cardCode, cardName: session.selectedVendor?.cardName }));
        }
      }

      // ── INIT ──────────────────────────────────────────────────────────────────
      else if (session.step === 'INIT') {
        const pos = await fetchAllOpenPOs(sap);
        session.allPOs = pos;
        const groups = groupByVendor(pos);
        session.vendorGroups = groups;

        if (!groups.length) {
          reply = `## 📦 PO → GRPO Receipt Agent\n\n> ✅ **No open Purchase Orders** pending receipt in SAP B1.`;
          quickReplies = ['Refresh'];
        } else {
          reply = buildVendorSummaryText(groups, pos.length);
          vendorList = groups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
            ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));
          session.step = 'SELECT_VENDOR';
        }
      }

      // ── SELECT_VENDOR ─────────────────────────────────────────────────────────
      else if (session.step === 'SELECT_VENDOR') {
        if (/refresh|reload/i.test(msgL)) {
          const pos = await fetchAllOpenPOs(sap);
          session.allPOs = pos;
          const groups = groupByVendor(pos);
          session.vendorGroups = groups;
          reply = buildVendorSummaryText(groups, pos.length);
          vendorList = groups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
            ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));
        } else {
          const vendorCode = msg.startsWith('VENDOR:') ? msg.slice(7).trim() : msg.trim();
          const group = session.vendorGroups.find(g =>
            (g.cardCode || '').toLowerCase() === vendorCode.toLowerCase() ||
            (g.cardName || '').toLowerCase() === vendorCode.toLowerCase()
          );
          if (!group) {
            reply = 'Please select a supplier from the list:';
            vendorList = session.vendorGroups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
              ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));
          } else {
            session.selectedVendor = { cardCode: group.cardCode, cardName: group.cardName };
            const tod = today();
            session.vendorPOs = group.pos.map(p => ({
              docEntry: p.DocEntry, docNum: p.DocNum,
              docDate:  p.DocDate    ? p.DocDate.slice(0, 10)    : null,
              dueDate:  p.DocDueDate ? p.DocDueDate.slice(0, 10) : null,
              docTotal: Number(p.DocTotal || 0),
            }));
            session.step = 'SELECT_PO';
            const overdue = session.vendorPOs.filter(p => p.dueDate && p.dueDate < tod).length;
            reply = `### ${group.cardName || group.cardCode} — Open POs\n\n**${session.vendorPOs.length} Purchase Order${session.vendorPOs.length !== 1 ? 's' : ''}** pending receipt${overdue > 0 ? ` | ⚠️ **${overdue} overdue**` : ''}\n\nSelect a PO to open the receipt entry form:`;
            poList = session.vendorPOs.map(p => ({ ...p, cardCode: group.cardCode, cardName: group.cardName }));
          }
        }
      }

      // ── SELECT_PO ─────────────────────────────────────────────────────────────
      else if (session.step === 'SELECT_PO') {
        if (/^(back|change|supplier|vendor)/i.test(msgL)) {
          session.step = 'SELECT_VENDOR';
          session.selectedVendor  = null;
          session.selectedPODoc   = null;
          reply = buildVendorSummaryText(session.vendorGroups, session.allPOs.length);
          vendorList = session.vendorGroups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
            ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));

        } else if (/retry/i.test(msgL) && session.selectedPODoc) {
          reply = `Re-opening PO #${session.selectedPODoc.DocNum} — enter quantities:`;
          poDetail = buildPODetail(session.selectedPODoc, session.itemMgmtMap);

        } else if (/cancel/i.test(msgL)) {
          session.selectedPODoc = null;
          reply = 'Cancelled. Select a PO to receive:';
          poList = session.vendorPOs.map(p => ({ ...p, cardCode: session.selectedVendor?.cardCode, cardName: session.selectedVendor?.cardName }));

        } else {
          const poNumMatch = msg.match(/^PO#?(\d+)$/i) || msg.match(/^(\d+)$/);
          if (poNumMatch) {
            const docNum = parseInt(poNumMatch[1]);
            const po = session.vendorPOs.find(p => p.docNum === docNum);
            if (!po) {
              reply = `PO#${docNum} not found. Select from the list:`;
              poList = session.vendorPOs.map(p => ({ ...p, cardCode: session.selectedVendor?.cardCode, cardName: session.selectedVendor?.cardName }));
            } else {
              const full = await fetchPOFull(sap, po.docEntry);
              if (!full) {
                reply = `Could not load PO#${docNum}. Please try again.`;
                poList = session.vendorPOs.map(p => ({ ...p, cardCode: session.selectedVendor?.cardCode, cardName: session.selectedVendor?.cardName }));
              } else {
                session.selectedPODoc = full;
                const itemCodes = (full.DocumentLines || []).map(l => l.ItemCode).filter(Boolean);
                session.itemMgmtMap = await fetchItemManagement(sap, itemCodes);
                const detail = buildPODetail(full, session.itemMgmtMap);
                const batchCount  = detail.lines.filter(l => l.managedBy === 'batch').length;
                const serialCount = detail.lines.filter(l => l.managedBy === 'serial').length;
                const mgmtNote = (batchCount || serialCount)
                  ? ` _(${[batchCount ? `${batchCount} batch` : '', serialCount ? `${serialCount} serial` : ''].filter(Boolean).join(', ')} managed)_`
                  : '';
                reply = `**PO #${full.DocNum}** — ${full.CardName || full.CardCode || '—'}\n\n${detail.lines.length} open line${detail.lines.length !== 1 ? 's' : ''}${mgmtNote} ready to receive. Complete the entry form:`;
                poDetail = detail;
              }
            }
          } else {
            reply = 'Please select a PO from the list:';
            poList = session.vendorPOs.map(p => ({ ...p, cardCode: session.selectedVendor?.cardCode, cardName: session.selectedVendor?.cardName }));
          }
        }
      }

      // ── DONE ──────────────────────────────────────────────────────────────────
      else if (session.step === 'DONE') {
        if (/yes|more|another|receive|start/i.test(msgL)) {
          const pos = await fetchAllOpenPOs(sap);
          session.allPOs = pos;
          const groups = groupByVendor(pos);
          session.vendorGroups = groups;
          session.selectedVendor = null;
          session.vendorPOs      = [];
          session.selectedPODoc  = null;
          session.result         = null;
          session.step           = 'SELECT_VENDOR';
          reply = buildVendorSummaryText(groups, pos.length);
          vendorList = groups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
            ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));
          if (!groups.length) {
            reply = `## 📦 PO → GRPO Receipt Agent\n\n> ✅ **No open Purchase Orders** pending receipt.`;
            quickReplies = ['Refresh'];
            vendorList = null;
          }
        } else {
          const r = session.result;
          reply = `Workflow complete.\n\n${r ? `[🖨️ Print GRPO #${r.docNum}](/api/po-to-grpo/print/${r.docEntry})` : ''}`;
          quickReplies = ['Start New Receipt'];
        }
      }

      // ── Fallback ──────────────────────────────────────────────────────────────
      else {
        session.step = 'INIT';
        const pos = await fetchAllOpenPOs(sap);
        session.allPOs = pos;
        const groups = groupByVendor(pos);
        session.vendorGroups = groups;
        reply = buildVendorSummaryText(groups, pos.length);
        vendorList = groups.map(({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }) =>
          ({ cardCode, cardName, poCount, totalValue, overduePOs, oldestDate }));
        session.step = 'SELECT_VENDOR';
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step:           session.step,
        selectedVendor: session.selectedVendor,
        meta, vendorList, poList, poDetail,
      });

    } catch (e) {
      console.error('[PO-TO-GRPO] chat error:', e);
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
  router.get('/print/:docEntry', async (req, res) => {
    try {
      const sap = getActiveSap();
      const doc = await sap.get(`/PurchaseDeliveryNotes(${parseInt(req.params.docEntry, 10)})`);
      res.setHeader('Content-Type', 'text/html');
      res.send(renderGRPOPrint(doc));
    } catch (e) {
      res.status(500).send(`<pre style="color:red">Error loading GRPO #${req.params.docEntry}: ${e.message}</pre>`);
    }
  });

  return router;
}

// ── Print HTML renderer ────────────────────────────────────────────────────────
function renderGRPOPrint(doc) {
  const company   = process.env.SAP_B1_COMPANY || process.env.SL_COMPANY || 'Company';
  const lines     = doc.DocumentLines || [];
  const docDate   = doc.DocDate ? doc.DocDate.slice(0, 10) : '—';
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
  <title>Goods Receipt PO #${doc.DocNum}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#222;padding:28px 36px;max-width:980px;margin:auto}
    .print-btn{margin-bottom:16px;display:flex;gap:8px;justify-content:flex-end}
    .print-btn button{padding:8px 18px;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600}
    .btn-print{background:#0f766e;color:#fff}.btn-close{background:#eee;color:#333}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;padding-bottom:16px;border-bottom:3px solid #0f766e}
    .co-name{font-size:20px;font-weight:700;color:#1a1d27}
    .doc-title{font-size:18px;font-weight:700;color:#0f766e;text-align:right}
    .doc-num{font-size:13px;color:#444;text-align:right;margin-top:2px}
    .info-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px}
    .info-box{border:1px solid #ddd;border-radius:6px;padding:12px}
    .info-label{font-size:9px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:.06em;margin-bottom:6px}
    .info-val{font-size:12px;color:#222;margin-bottom:2px}
    table{width:100%;border-collapse:collapse;margin-bottom:16px}
    thead tr{background:#0f766e}
    th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#fff}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:11px}
    tr:nth-child(even) td{background:#f0fdf9}
    .totals{text-align:right;padding:12px 0 20px}
    .total-grand{font-size:14px;font-weight:700;color:#0f766e}
    .sig-section{display:grid;grid-template-columns:1fr 1fr 1fr;gap:32px;margin-top:48px}
    .sig-line{border-top:1px solid #333;margin-top:40px;padding-top:6px;font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.04em;text-align:center}
    .footer{text-align:center;margin-top:24px;font-size:9px;color:#aaa;border-top:1px solid #eee;padding-top:12px}
    .watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:60px;color:rgba(0,0,0,.04);font-weight:900;pointer-events:none;z-index:0}
    @media print{.print-btn{display:none}}
  </style>
</head>
<body>
<div class="watermark">GOODS RECEIPT</div>
<div class="print-btn">
  <button class="btn-close" onclick="window.close()">✕ Close</button>
  <button class="btn-print" onclick="window.print()">🖨️ Print</button>
</div>
<div class="header">
  <div>
    <div class="co-name">${company}</div>
    <div style="color:#888;font-size:11px;margin-top:2px">SAP Business One — Goods Receipt PO</div>
  </div>
  <div>
    <div class="doc-title">Goods Receipt PO</div>
    <div class="doc-num">GRPO # ${doc.DocNum}</div>
  </div>
</div>
<div class="info-grid">
  <div class="info-box">
    <div class="info-label">Vendor</div>
    <div class="info-val"><strong>${doc.CardName || '—'}</strong></div>
    ${doc.CardCode ? `<div class="info-val" style="color:#666">${doc.CardCode}</div>` : ''}
  </div>
  <div class="info-box">
    <div class="info-label">Receipt Date</div>
    <div class="info-val"><strong>${docDate}</strong></div>
    <div class="info-val" style="color:#666">Entry # ${doc.DocEntry}</div>
  </div>
  <div class="info-box">
    <div class="info-label">Reference</div>
    <div class="info-val">GRPO # <strong>${doc.DocNum}</strong></div>
    <div class="info-val" style="color:#666">Received into stock</div>
  </div>
</div>
${doc.Comments ? `<div style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:20px;background:#f0fdf9;font-size:11px;line-height:1.6"><strong>📝 Comments:</strong><br><br>${doc.Comments}</div>` : ''}
<table>
  <thead>
    <tr>
      <th>#</th><th>Item Code</th><th>Description</th>
      <th style="text-align:right">Qty Received</th><th>Unit</th>
      <th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th>
      <th>Warehouse</th>
    </tr>
  </thead>
  <tbody>${linesHtml}</tbody>
</table>
${grandTotal > 0 ? `<div class="totals"><div class="total-grand">Total Receipt Value: ${grandTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>` : ''}
<div class="sig-section">
  <div><div class="sig-line">Received By</div></div>
  <div><div class="sig-line">Verified By</div></div>
  <div><div class="sig-line">Entered By</div></div>
</div>
<div class="footer">
  Printed on ${printedOn} &nbsp;|&nbsp; ${company} — SAP B1 Goods Receipt PO #${doc.DocNum} &nbsp;|&nbsp; Powered by Henny AI Solution
</div>
</body>
</html>`;
}
