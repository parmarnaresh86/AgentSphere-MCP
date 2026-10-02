/**
 * Mail-PO→SO Agent — the IMAP-polling counterpart to the upload-driven PO
 * Agentic Workflow (controllers/po-workflow-agent.mjs). Watches an inbox for
 * purchase-order PDF attachments, parses them with AI, matches the buyer to
 * a SAP customer, checks credit/ATP, and creates the Sales Order — either
 * automatically (mailPo.setOnPdf callback, registered at module load) or
 * step-by-step via the /open → /extract → /create-so-mail routes the UI
 * drives for manual review.
 *
 * Extracted from chat-server.mjs (was ~440 inline lines under
 * "Mail-PO→SO routes") as part of splitting that file into per-agent
 * modules, following the same createXRouter(deps) factory pattern already
 * used by production-agent.mjs / mrp-agent.mjs / po-workflow-agent.mjs.
 *
 * createSoDirect/callAiText come from lib/sap-order-helpers.mjs, shared with
 * po-workflow-agent.mjs — both turn a parsed PO into a live SAP Sales Order
 * via the same call.
 */
import { Router } from 'express';
import { createRequire } from 'module';
import * as mailPo from '../mail-po.mjs';
import { mailConfigRepo } from '../db.mjs';
import { createSoDirect, callAiText as callAiTextShared } from '../lib/sap-order-helpers.mjs';
import { searchPartners, matchPartner, searchItems, matchItem, getWarehouses } from '../lib/ocr-sap-match.mjs';
import { runVisionExtraction, nameSimilarity } from '../lib/ocr-extract.mjs';

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch (e) { console.warn('pdf-parse load failed:', e.message); pdfParse = null; }

const esc = s => String(s || '').replace(/'/g, "''");

// ── Our own company (the seller) ────────────────────────────────────────────
// Every incoming PO is addressed TO us, so our name sits in its Vendor/Supplier
// block — it must never be taken as the customer. Cached per SAP client.
const _ownCompany = new WeakMap();
async function getOwnCompany(sap) {
  if (_ownCompany.has(sap)) return _ownCompany.get(sap);
  let name = '';
  try { const r = await sap.post('/CompanyService_GetAdminInfo', {}); name = r?.CompanyName || ''; } catch {}
  if (name) _ownCompany.set(sap, name);
  return name;
}
const isOwnCompany = (name, own) => !!(name && own && nameSimilarity(name, own) >= 0.6);
const realCode = c => (c && !/^(null|n\/a|na|-)$/i.test(String(c).trim()) ? String(c).trim() : null);

function poExtractionPrompt(ownCompany) {
  return `You are a purchase order parser. A customer has sent us (the seller) their Purchase Order.

WHO IS THE CUSTOMER:
- The CUSTOMER (buyer) is the company that ISSUED this PO. Its name, logo and address are normally in the document HEADER / letterhead at the top, or under "Buyer", "Bill To", "Invoice To" or "Ship To".
- The block labelled "Vendor", "Supplier", "Seller", "To" or "M/s" is the company the PO is addressed TO — that is US${ownCompany ? ` ("${ownCompany}")` : ''}. NEVER return our company as customerName; put it in vendorName.

Return ONLY a valid JSON object — no markdown fences, no explanation, no extra text.
{
  "poNumber": "PO number or null",
  "poDate": "YYYY-MM-DD or null",
  "deliveryDate": "YYYY-MM-DD or null",
  "customerName": "buyer company from the PO header",
  "customerCode": "buyer's code / GSTIN / VAT no. printed for the buyer, or null",
  "customerAddress": "buyer address from the header, or null",
  "vendorName": "name in the Vendor/Supplier block (us), or null",
  "currency": "3-letter ISO code",
  "paymentTerms": "string or null",
  "lines": [{ "lineNum":1, "description":"...", "itemCode":"code as printed or null", "qty":1, "unit":"EA", "unitPrice":0, "lineTotal":0 }],
  "subtotal":0, "tax":0, "total":0, "notes": null
}
Use null for strings that cannot be determined and 0 for numbers that cannot be determined.`;
}

// ── PDF cache (uid → { pdfText, pdfName, pdfBuffer, ts }) — 30-min TTL ────
const _pdfCache = new Map();
setInterval(() => {
  const cut = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of _pdfCache) { if (v.ts < cut) _pdfCache.delete(k); }
}, 5 * 60 * 1000);

// Resolve just the default purchasing/sales UoM code for an item from SAP B1 item master —
// used wherever a document line is built server-side without a UI-selected uomCode.
async function getItemDefaultUoM(sap, itemCode) {
  try {
    const item = await sap.get(`/Items('${esc(itemCode)}')`, {
      $select: "ItemCode,UoMGroupEntry,SalesUoMEntry,SalesUnit,InventoryUOM,PurchaseUnit"
    });
    const groupEntry = item.UoMGroupEntry;
    if (groupEntry && groupEntry > 0) {
      try {
        const group = await sap.get(`/UnitOfMeasurementGroups(${groupEntry})`);
        const defs = group.UoMGroupDefinitionCollection || [];
        const resolved = (await Promise.all(defs.map(async d => {
          try {
            const u = await sap.get(`/UnitOfMeasurements(${d.AlternateUoM})`);
            return { code: u.Code, absEntry: d.AlternateUoM };
          } catch { return null; }
        }))).filter(Boolean);
        if (resolved.length) {
          const salesMatch = item.SalesUoMEntry && resolved.find(u => u.absEntry === item.SalesUoMEntry);
          return (salesMatch || resolved[0]).code;
        }
      } catch {}
    }
    return item.SalesUnit || item.InventoryUOM || item.PurchaseUnit || undefined;
  } catch {
    return undefined;
  }
}

export function createMailPoAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, cacheRepo, getActiveCompanyId } = deps;
  const callAiText = (prompt, maxTokens) => callAiTextShared(prompt, maxTokens, { AI_PROVIDER, azureMessagesCreate, gptChatComplete });
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  // PDF → PO JSON. Text PDFs go through the text model; scanned (image-only)
  // PDFs fall back to AI vision on the PDF itself.
  async function extractPo({ pdfText, pdfBuffer }, ownCompany) {
    const sys = poExtractionPrompt(ownCompany);
    let po = null;
    if (pdfText) {
      try {
        const m = (await callAiText(`${sys}\n\nPO TEXT:\n${pdfText.substring(0, 8000)}`, 2500))?.match(/\{[\s\S]*\}/);
        if (m) po = JSON.parse(m[0]);
      } catch {}
    }
    if (!po && pdfBuffer) po = await runVisionExtraction(pdfBuffer, 'application/pdf', null, aiDeps, sys, null);
    po = po || { customerName: '', lines: [] };
    if (!Array.isArray(po.lines)) po.lines = [];
    po.lines.forEach(l => { l.itemCode = realCode(l.itemCode); });
    if (!po.total) po.total = po.lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || 0), 0);
    // Safety net: if the model still took our own name, use the other party on the PO
    if (isOwnCompany(po.customerName, ownCompany)) {
      po.customerName = (po.vendorName && !isOwnCompany(po.vendorName, ownCompany)) ? po.vendorName : null;
    }
    return po;
  }

  // PO JSON → SAP customer master + item master matches
  async function matchPo(sap, po, ownCompany) {
    let customer = null;
    if (po.customerName || po.customerCode) {
      const m = await matchPartner(sap, { name: po.customerName, code: realCode(po.customerCode) }, 'cCustomer');
      if (m.partner && !isOwnCompany(m.partner.name, ownCompany)) customer = { ...m.partner, score: m.score };
    }
    const lines = await Promise.all(po.lines.map(async ol => ({
      ocrLine: ol,
      match: await matchItem(sap, { itemCode: ol.itemCode, description: ol.description }),
    })));
    return { customer, lines };
  }

  async function getCachedPdf(uid) {
    let c = _pdfCache.get(String(uid));
    if (c?.pdfBuffer) return c;
    const email = await mailPo.fetchEmail(Number(uid));
    const pdf = email?.pdfs?.[0];
    if (!pdf) return null;
    let pdfText = '';
    if (pdfParse) { try { pdfText = (await pdfParse(pdf.buffer)).text?.trim() || ''; } catch {} }
    c = { pdfText, pdfName: pdf.name || 'attachment.pdf', pdfBuffer: pdf.buffer, ts: Date.now() };
    _pdfCache.set(String(uid), c);
    return c;
  }

  // ── Split-view review: PDF bytes, SAP master-data search, lookups ─────────
  router.get('/pdf', requireAuth, async (req, res) => {
    try {
      const c = await getCachedPdf(req.query.uid);
      if (!c) return res.status(404).json({ ok: false, error: 'No PDF on this email' });
      res.set('Content-Disposition', `inline; filename="${String(c.pdfName).replace(/"/g, '')}"`);
      res.type('application/pdf').send(c.pdfBuffer);
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  router.get('/customers', requireAuth, async (req, res) => {
    const sap = getActiveSap();
    const own = await getOwnCompany(sap);
    const list = (await searchPartners(sap, String(req.query.q || '').trim(), 'cCustomer')).filter(c => !isOwnCompany(c.name, own));
    res.json({ ok: true, customers: list });
  });

  router.get('/items', requireAuth, async (req, res) => {
    res.json({ ok: true, items: await searchItems(getActiveSap(), String(req.query.q || '').trim()) });
  });

  router.get('/lookups', requireAuth, async (_req, res) => {
    const sap = getActiveSap();
    const [warehouses, ownCompany] = await Promise.all([
      getWarehouses(sap, cacheRepo, getActiveCompanyId ? getActiveCompanyId() : ''),
      getOwnCompany(sap),
    ]);
    res.json({ ok: true, warehouses, ownCompany });
  });

  router.get('/status', requireAuth, (_req, res) => {
    const cfg = {
      host:    process.env.MAIL_IMAP_HOST || "",
      user:    process.env.MAIL_USER      || "",
      folder:  process.env.MAIL_FOLDER    || "INBOX",
      pollMs:  parseInt(process.env.MAIL_POLL_MS || "60000"),
      configured: !!(process.env.MAIL_IMAP_HOST && process.env.MAIL_USER && process.env.MAIL_PASS),
    };
    res.json({ running: mailPo.isRunning(), config: cfg, logs: mailPo.getLogs().slice(-20) });
  });

  router.post('/test', requireAuth, async (_req, res) => {
    const result = await mailPo.testConnection();
    res.json(result);
  });

  router.post('/start', requireAuth, async (_req, res) => {
    const result = await mailPo.start();
    res.json(result);
  });

  router.post('/stop', requireAuth, (_req, res) => {
    res.json(mailPo.stop());
  });

  router.get('/logs', requireAuth, (_req, res) => {
    res.json(mailPo.getLogs());
  });

  router.post('/config', requireAuth, (req, res) => {
    const { host, port, user, pass, smtp, smtpPort, poll } = req.body || {};
    if (host)     process.env.MAIL_IMAP_HOST  = host;
    if (port)     process.env.MAIL_IMAP_PORT  = String(port);
    if (user)     process.env.MAIL_USER       = user;
    if (pass)     process.env.MAIL_PASS       = pass;
    if (smtp)     process.env.MAIL_SMTP_HOST  = smtp;
    if (smtpPort) process.env.MAIL_SMTP_PORT  = String(smtpPort);
    if (poll)     process.env.MAIL_POLL_MS    = String(poll);
    mailConfigRepo.save({
      imap_host: process.env.MAIL_IMAP_HOST || "",
      imap_port: parseInt(process.env.MAIL_IMAP_PORT || "993"),
      imap_tls:  (process.env.MAIL_IMAP_TLS || "true") !== "false" ? 1 : 0,
      mail_user: process.env.MAIL_USER || "",
      mail_pass: process.env.MAIL_PASS || "",
      smtp_host: process.env.MAIL_SMTP_HOST || "",
      smtp_port: parseInt(process.env.MAIL_SMTP_PORT || "587"),
      smtp_tls:  0,
      folder:    process.env.MAIL_FOLDER || "INBOX",
      poll_ms:   parseInt(process.env.MAIL_POLL_MS || "60000"),
    });
    res.json({ ok: true });
  });

  // ── Inbox: list unread PO emails ──────────────────────────────────────────
  router.get('/inbox', requireAuth, async (_req, res) => {
    try {
      const emails = await mailPo.fetchInbox();
      res.json({ ok: true, emails });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Fetch UoM options for an item from SAP B1 item master ───────────────────
  router.get('/item-uoms', requireAuth, async (req, res) => {
    const { itemCode } = req.query;
    if (!itemCode) return res.status(400).json({ ok: false, error: "itemCode required" });
    try {
      const sap = getActiveSap();
      const item = await sap.get(`/Items('${esc(itemCode)}')`, {
        $select: "ItemCode,ItemName,UoMGroupEntry,InventoryUoMEntry,SalesUoMEntry,SalesUnit,InventoryUOM,PurchaseUnit"
      });
      // Item master fallback (legacy Sales/Inventory/Purchase unit fields) — used when the item
      // isn't on a UoM group, or the group fails to resolve, so we never fall back to the
      // literal string "Manual" for an item SAP actually expects a real UoM code on.
      const masterFallback = item.SalesUnit || item.InventoryUOM || item.PurchaseUnit || null;
      let uoms = masterFallback ? [{ code: masterFallback, name: masterFallback }] : [{ code: "Manual", name: "Manual" }];
      let defaultCode = masterFallback || "Manual";
      const groupEntry = item.UoMGroupEntry;
      if (groupEntry && groupEntry > 0) {
        try {
          const group = await sap.get(`/UnitOfMeasurementGroups(${groupEntry})`);
          const defs = group.UoMGroupDefinitionCollection || [];
          const resolved = (await Promise.all(defs.map(async d => {
            try {
              const u = await sap.get(`/UnitOfMeasurements(${d.AlternateUoM})`);
              return { code: u.Code, name: u.Name || u.Code, absEntry: d.AlternateUoM };
            } catch { return null; }
          }))).filter(Boolean);
          if (resolved.length) {
            uoms = resolved;
            defaultCode = resolved[0].code;
            if (item.SalesUoMEntry) {
              const salesMatch = resolved.find(u => u.absEntry === item.SalesUoMEntry);
              if (salesMatch) defaultCode = salesMatch.code;
            }
          }
        } catch {}
      }
      res.json({ ok: true, itemCode: item.ItemCode, itemName: item.ItemName, uoms, defaultCode });
    } catch (e) {
      res.json({ ok: false, error: e.message, uoms: [{ code: "Manual", name: "Manual" }], defaultCode: "Manual" });
    }
  });

  // ── Validate SO before posting (S/4 HANA-style pre-check) ───────────────────
  router.post('/validate-so', requireAuth, async (req, res) => {
    const { cardCode, lines = [] } = req.body || {};
    if (!cardCode) return res.status(400).json({ ok: false, error: "cardCode required" });
    const sap = getActiveSap();
    const checks = [];

    // Customer + credit check
    try {
      const bp = await sap.get(`/BusinessPartners('${esc(cardCode)}')`);
      checks.push({ key: "customer", label: "Customer", status: "ok", detail: `${bp.CardName} (${bp.CardCode})` });
      const limit    = parseFloat(bp.CreditLimit)||0;
      const balance  = parseFloat(bp.CurrentAccountBalance)||0;
      const openOrd  = (parseFloat(bp.OrdersBalance)||0) + (parseFloat(bp.OpenDeliveryNotesBalance)||0);
      const orderAmt = lines.reduce((s, l) => s + (parseFloat(l.qty)||0) * (parseFloat(l.unitPrice)||0), 0);
      const newExp   = balance + openOrd + orderAmt;
      const pct      = limit > 0 ? (newExp / limit * 100).toFixed(1) : 0;
      const creditSt = limit === 0 ? "ok" : newExp > limit ? "error" : newExp/limit > 0.8 ? "warning" : "ok";
      checks.push({
        key: "credit", label: "Credit Limit", status: creditSt,
        detail: limit === 0
          ? "No credit limit — unlimited"
          : `${pct}% utilized · Limit: ${limit.toLocaleString()} · New Exposure: ${Math.round(newExp).toLocaleString()}`,
      });
    } catch (e) {
      checks.push({ key: "customer", label: "Customer", status: "error", detail: e.message });
      checks.push({ key: "credit", label: "Credit Limit", status: "skip", detail: "Skipped — customer not found" });
    }

    // Line-item checks: item exists + not frozen + ATP + UoM specified
    const validLines = lines.filter(l => l.itemCode && l.itemCode !== "null" && l.itemCode !== "N/A");
    if (!validLines.length) {
      checks.push({ key: "lines", label: "Line Items", status: "error", detail: "No valid item codes found", lines: [] });
    } else {
      const lineChecks = await Promise.all(validLines.map(async (l, idx) => {
        if (!l.uomCode || !l.uomCode.trim()) {
          return { lineNum: idx+1, itemCode: l.itemCode, status: "error", detail: `Line ${idx+1}: ${l.itemCode} — UoM not specified` };
        }
        try {
          const item = await sap.get(`/Items('${esc(l.itemCode)}')`, {
            $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers,Frozen"
          });
          if (item.Frozen === "tYES") {
            return { lineNum: idx+1, itemCode: l.itemCode, status: "error", detail: `${item.ItemName} — item is frozen/discontinued` };
          }
          const avail = Math.max(0, (parseFloat(item.QuantityOnStock)||0) - (parseFloat(item.QuantityOrderedByCustomers)||0));
          const qty   = parseFloat(l.qty)||0;
          return {
            lineNum: idx+1, itemCode: l.itemCode, itemName: item.ItemName,
            status: avail < qty ? "warning" : "ok",
            detail: `${item.ItemName} · UoM: ${l.uomCode} · Available: ${avail} · Requested: ${qty}`,
          };
        } catch {
          return { lineNum: idx+1, itemCode: l.itemCode, status: "error", detail: `"${l.itemCode}" not found in SAP B1` };
        }
      }));
      const linesErr  = lineChecks.filter(l => l.status === "error").length;
      const linesWarn = lineChecks.filter(l => l.status === "warning").length;
      checks.push({
        key: "lines", label: "Line Items",
        status: linesErr > 0 ? "error" : linesWarn > 0 ? "warning" : "ok",
        detail: `${lineChecks.length} line(s) · ${linesErr} error(s) · ${linesWarn} warning(s)`,
        lines: lineChecks,
      });
    }

    const hasErrors  = checks.some(c => c.status === "error");
    const hasWarnings = checks.some(c => c.status === "warning");
    res.json({ ok: true, checks, canPost: !hasErrors, hasErrors, hasWarnings });
  });

  // ── Step 1: Fetch email from IMAP and cache the PDF (fast ~5-10s) ──────────
  router.post('/open', requireAuth, async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: "uid required" });
    try {
      const email = await mailPo.fetchEmail(Number(uid));
      if (!email) return res.json({ ok: false, error: "Email not found or already read" });
      const pdf = email.pdfs[0];
      let pdfText = "";
      if (pdf && pdfParse) {
        try { pdfText = (await pdfParse(pdf.buffer)).text?.trim() || ""; } catch {}
      }
      if (pdf) _pdfCache.set(String(uid), { pdfText, pdfName: pdf.name || "attachment.pdf", pdfBuffer: pdf.buffer, ts: Date.now() });
      res.json({ ok: true, uid, pdfName: pdf?.name || "", pdfSize: pdf?.buffer?.length || 0, hasPdf: !!pdf, hasPdfText: pdfText.length > 0,
        email: { from: email.from, subject: email.subject, date: email.date } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Step 2: AI extract + match against SAP customer & item master ─────────
  router.post('/extract', requireAuth, async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: "uid required" });
    try {
      const cached = await getCachedPdf(uid);
      if (!cached) return res.json({ ok: false, error: "No PDF attached to this email" });
      const sap = getActiveSap();
      const ownCompany = await getOwnCompany(sap);
      const po = await extractPo(cached, ownCompany);
      if (!po.lines.length && !po.customerName) return res.json({ ok: false, error: "Could not read purchase order data from this PDF." });
      const { customer, lines } = await matchPo(sap, po, ownCompany);
      res.json({ ok: true, po, customer, lines, ownCompany, scanned: !cached.pdfText });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Create SO from email + send acknowledgment ────────────────────────────
  router.post('/create-so-mail', requireAuth, async (req, res) => {
    const { uid, fromEmail, subject, cardCode, poNumber, poDate, deliveryDate, currency, notes, lines = [], allowDuplicateRef } = req.body || {};
    if (!cardCode) return res.status(400).json({ ok: false, error: "cardCode required" });
    try {
      const docLines = lines.filter(l => l.itemCode).map(l => ({
        ItemCode: l.itemCode, Quantity: parseFloat(l.qty)||1, UnitPrice: parseFloat(l.unitPrice)||0,
        ...(l.uomCode && l.uomCode !== "Manual" ? { UoMCode: l.uomCode } : {}),
        ...(l.warehouse ? { WarehouseCode: l.warehouse } : {}),
        ...(l.freeText  ? { FreeText: String(l.freeText).slice(0, 100) } : {}),
      }));
      if (!docLines.length) return res.json({ ok: false, error: "No valid item lines to create SO" });
      const { DocNum: docNum } = await createSoDirect(getActiveSap(), { cardCode, docDate: poDate, docDueDate: deliveryDate, numAtCard: poNumber, currency, comments: notes || "", docLines, allowDuplicateRef });

      // SO is in SAP — now (and only now) mark this one email as read
      if (uid) {
        try { await mailPo.markSeen(Number(uid)); _pdfCache.delete(String(uid)); }
        catch (e) { console.warn("[MAIL-PO] Mark-as-read failed:", e.message); }
      }

      // Send acknowledgment email
      let ackSent = false;
      if (fromEmail) {
        try {
          const msg = `Your Purchase Order has been received and processed.\n\nSales Order #${docNum} has been created in SAP Business One.\n\nPO Reference: ${poNumber || "—"}\nCustomer Code: ${cardCode}\n\nThank you for your order.\n\n---\nAgentsphere AI — Automated PO→SO Workflow`;
          await mailPo.sendAcknowledgment(fromEmail, subject || "Purchase Order", msg);
          ackSent = true;
        } catch (e) { console.warn("[MAIL-PO] Ack send failed:", e.message); }
      }
      res.json({ ok: true, docNum, cardCode, poNumber, ackSent });
    } catch (e) {
      if (e.duplicateRef) return res.json({ ok: false, duplicateRef: true, numAtCard: e.numAtCard, suggestedRef: e.suggestedRef, error: e.message });
      res.json({ ok: false, error: e.message });
    }
  });

  // ── Register PDF workflow callback for mail-po ────────────────────────────
  // Auto mode posts only confident matches; anything else is left unread so it
  // is reviewed in the split-view screen.
  const AUTO_MIN_CUSTOMER = 0.8, AUTO_MIN_ITEM = 0.9;
  mailPo.setOnPdf(async (pdfBuffer, fileName, fromEmail, subject) => {
    let pdfText = "";
    if (pdfParse) { try { pdfText = (await pdfParse(pdfBuffer)).text?.trim() || ""; } catch {} }

    const activeSap  = getActiveSap();
    const ownCompany = await getOwnCompany(activeSap);
    const po = await extractPo({ pdfText, pdfBuffer }, ownCompany);
    if (!po.lines.length && !po.customerName) throw new Error("AI could not extract structured PO data");
    const total = po.total;

    const { customer, lines } = await matchPo(activeSap, po, ownCompany);
    if (!customer || customer.score < AUTO_MIN_CUSTOMER) {
      return { docNum: null, message: `Customer "${po.customerName || "—"}" not matched confidently in SAP B1. Review it in Mail PO → SO.`, poNumber: po.poNumber, currency: po.currency, total };
    }
    const weak = lines.filter(l => !l.match || l.match.score < AUTO_MIN_ITEM);
    if (!lines.length || weak.length) {
      return { docNum: null, message: `${weak.length || "No"} line(s) could not be matched to the SAP item master. Review it in Mail PO → SO.`, poNumber: po.poNumber, customerName: customer.name, currency: po.currency, total };
    }

    // Create SO directly (skip credit block — mail flow is auto, flag if exceeded)
    const docLines = await Promise.all(lines.map(async ({ ocrLine, match }) => {
      const uomCode = await getItemDefaultUoM(activeSap, match.code);
      return {
        ItemCode:  match.code,
        Quantity:  parseFloat(ocrLine.qty)       || 1,
        UnitPrice: parseFloat(ocrLine.unitPrice) || 0,
        ...(uomCode ? { UoMCode: uomCode } : {}),
      };
    }));

    const { DocNum, DocEntry } = await createSoDirect(activeSap, {
      cardCode:    customer.code,
      docDate:     po.poDate     || new Date().toISOString().split("T")[0],
      docDueDate:  po.deliveryDate || undefined,
      numAtCard:   po.poNumber,
      currency:    po.currency,
      comments:    "",
      docLines,
    });

    return {
      docNum:       DocNum,
      docEntry:     DocEntry,
      customerName: customer.name,
      poNumber:     po.poNumber,
      currency:     po.currency,
      total,
      message:      `Sales Order #${DocNum} created`,
    };
  });

  // Auto-start mail monitor if credentials are configured
  if (process.env.MAIL_IMAP_HOST && process.env.MAIL_USER && process.env.MAIL_PASS) {
    mailPo.start().then(r => console.log(`[MAIL-PO] Auto-start: ${r.ok ? "OK" : r.error}`));
  }

  return router;
}
