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

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch (e) { console.warn('pdf-parse load failed:', e.message); pdfParse = null; }

const esc = s => String(s || '').replace(/'/g, "''");

// ── PDF text cache (uid → { pdfText, pdfName, ts }) — 30-min TTL ─────────
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
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER } = deps;
  const callAiText = (prompt, maxTokens) => callAiTextShared(prompt, maxTokens, { AI_PROVIDER, azureMessagesCreate, gptChatComplete });
  const router = Router();

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

  // ── Step 1: Fetch email from IMAP and cache PDF text (fast ~5-10s) ─────────
  router.post('/open', requireAuth, async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: "uid required" });
    try {
      const email = await mailPo.fetchEmail(Number(uid));
      if (!email) return res.json({ ok: false, error: "Email not found or already read" });
      let pdfName = email.pdfs[0]?.name || "";
      let pdfText = "";
      if (email.pdfs.length && pdfParse) {
        try {
          const pdfData = await pdfParse(email.pdfs[0].buffer);
          pdfText = pdfData.text?.trim() || "";
        } catch (e) { pdfName = pdfName + " (parse error: " + e.message + ")"; }
      }
      _pdfCache.set(String(uid), { pdfText, pdfName, ts: Date.now() });
      res.json({ ok: true, uid, pdfName, hasPdf: email.pdfs.length > 0, hasPdfText: pdfText.length > 0,
        email: { from: email.from, subject: email.subject, date: email.date } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Step 2: AI extract + customer + credit + ATP (uses cached PDF text) ────
  router.post('/extract', requireAuth, async (req, res) => {
    const { uid } = req.body || {};
    if (!uid) return res.status(400).json({ ok: false, error: "uid required" });
    const cached = _pdfCache.get(String(uid));
    if (!cached) return res.json({ ok: false, error: "PDF not found in cache — please re-open the email" });
    try {
      // AI extraction
      let po = { customerName: "", lines: [], total: 0 };
      if (cached.pdfText) {
        const prompt = `You are a purchase order parser. Extract all purchase order data from the text below.
Return ONLY a valid JSON object — no markdown fences, no explanation.
{
  "poNumber": "PO number or null",
  "poDate": "YYYY-MM-DD or null",
  "deliveryDate": "YYYY-MM-DD or null",
  "customerName": "buyer company name",
  "customerRef": "buyer reference code or null",
  "currency": "3-letter ISO code",
  "lines": [{ "lineNum":1, "description":"...", "itemCode":"...", "qty":1, "unit":"EA", "unitPrice":0, "lineTotal":0 }],
  "subtotal":0, "tax":0, "total":0, "notes": null
}
PO TEXT:\n${cached.pdfText.substring(0, 8000)}`;
        try {
          const aiText = await callAiText(prompt, 2500);
          const match  = aiText.match(/\{[\s\S]*\}/);
          if (match) po = JSON.parse(match[0]);
        } catch {}
      }
      if (!Array.isArray(po.lines)) po.lines = [];
      if (!po.total) po.total = po.lines.reduce((s, l) => s + (parseFloat(l.lineTotal)||0), 0);

      // Customer lookup
      const activeSap = getActiveSap();
      let customer = null;
      if (po.customerName) {
        const term = po.customerName.substring(0, 35).replace(/'/g, "").replace(/-/g, " ").trim();
        for (const filter of [
          `CardType eq 'cCustomer' and contains(CardName,'${term}')`,
          `CardType eq 'cCustomer' and startswith(CardName,'${term.split(/\s/)[0]}')`,
        ]) {
          try {
            const r = await activeSap.get("/BusinessPartners", { $filter: filter, $select: "CardCode,CardName,CreditLimit,CurrentAccountBalance", $top: 1 });
            if (r.value?.[0]) { customer = r.value[0]; break; }
          } catch {}
        }
      }

      // Credit check
      let creditResult = null;
      if (customer) {
        try {
          const bp = await activeSap.get(`/BusinessPartners('${customer.CardCode.replace(/'/g,"")}')`);
          const limit = parseFloat(bp.CreditLimit)||0, balance = parseFloat(bp.CurrentAccountBalance)||0;
          const openOrd = (parseFloat(bp.OrdersBalance)||0) + (parseFloat(bp.OpenDeliveryNotesBalance)||0);
          const exposure = balance + openOrd, orderAmt = parseFloat(po.total)||0, newExp = exposure + orderAmt;
          const status = limit === 0 ? "ok" : newExp > limit ? "exceeded" : newExp/limit > 0.8 ? "warning" : "ok";
          creditResult = { creditLimit: limit, balance, openOrders: openOrd, exposure, orderAmt, newExposure: newExp, status, noLimit: limit === 0, message: status !== "ok" ? `${(newExp/limit*100).toFixed(1)}% of credit limit` : "" };
        } catch {}
      }

      // ATP check
      let atpResult = null;
      const itemLines = (po.lines||[]).filter(l => l.itemCode && l.itemCode !== "null" && l.itemCode !== "N/A");
      if (itemLines.length && customer) {
        try {
          atpResult = await Promise.all(itemLines.slice(0, 10).map(async l => {
            try {
              const item = await activeSap.get(`/Items('${esc(l.itemCode)}')`, { $select: "ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers" });
              const onStock = parseFloat(item.QuantityOnStock)||0, committed = parseFloat(item.QuantityOrderedByCustomers)||0;
              const InStock = Math.max(0, onStock - committed), requested = parseFloat(l.qty)||0;
              return { itemCode: l.itemCode, itemName: item.ItemName, InStock, requested, ok: InStock >= requested };
            } catch { return { itemCode: l.itemCode, error: "not found", InStock: 0, requested: parseFloat(l.qty)||0 }; }
          }));
        } catch {}
      }

      res.json({ ok: true, po, customer, creditResult, atpResult });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // ── Create SO from email + send acknowledgment ────────────────────────────
  router.post('/create-so-mail', requireAuth, async (req, res) => {
    const { fromEmail, subject, cardCode, poNumber, poDate, deliveryDate, currency, notes, lines = [], allowDuplicateRef } = req.body || {};
    if (!cardCode) return res.status(400).json({ ok: false, error: "cardCode required" });
    try {
      const docLines = lines.filter(l => l.itemCode).map(l => ({ ItemCode: l.itemCode, Quantity: parseFloat(l.qty)||1, UnitPrice: parseFloat(l.unitPrice)||0, ...(l.uomCode && l.uomCode !== "Manual" ? { UoMCode: l.uomCode } : {}) }));
      if (!docLines.length) return res.json({ ok: false, error: "No valid item lines to create SO" });
      const { DocNum: docNum } = await createSoDirect(getActiveSap(), { cardCode, docDate: poDate, docDueDate: deliveryDate, numAtCard: poNumber, currency, comments: notes || "", docLines, allowDuplicateRef });

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
  mailPo.setOnPdf(async (pdfBuffer, fileName, fromEmail, subject) => {
    if (!pdfParse) throw new Error("pdf-parse not available");

    // Step 1: Parse PDF
    const pdfData  = await pdfParse(pdfBuffer);
    const rawText  = pdfData.text?.trim();
    if (!rawText) throw new Error("PDF appears to be image-only — cannot extract text");

    const prompt = `You are a purchase order parser. Extract all purchase order data from the text below.
Return ONLY a valid JSON object — no markdown fences, no explanation, no extra text.
{
  "poNumber": "PO number string or null",
  "poDate": "YYYY-MM-DD or null",
  "deliveryDate": "YYYY-MM-DD or null",
  "customerName": "the BUYER company name who placed the order",
  "customerRef": "buyer reference code if visible or null",
  "currency": "3-letter ISO code",
  "lines": [{ "lineNum":1, "description":"...", "itemCode":"...", "qty":1, "unit":"EA", "unitPrice":0, "lineTotal":0 }],
  "subtotal":0, "tax":0, "total":0, "notes": null
}
PO TEXT:
${rawText.substring(0, 8000)}`;

    const aiText  = await callAiText(prompt, 2500);
    const match   = aiText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("AI could not extract structured PO data");
    const po      = JSON.parse(match[0]);
    const lines   = Array.isArray(po.lines) ? po.lines : [];
    const total   = po.total || lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || 0), 0);

    // Step 2: Find customer
    const activeSap = getActiveSap();
    let customer    = null;
    if (po.customerName) {
      const term = po.customerName.substring(0, 35).replace(/'/g, "").replace(/-/g, " ").trim();
      try {
        const r = await activeSap.get("/BusinessPartners", {
          $filter: `CardType eq 'cCustomer' and contains(CardName,'${term}')`,
          $select: "CardCode,CardName,CreditLimit,CurrentAccountBalance",
          $top: 1,
        });
        customer = r.value?.[0] || null;
      } catch {}
      if (!customer) {
        const fw = po.customerName.split(/[\s\-]/)[0];
        if (fw?.length > 2) {
          try {
            const r = await activeSap.get("/BusinessPartners", {
              $filter: `CardType eq 'cCustomer' and startswith(CardName,'${fw.replace(/'/g,"")}')`,
              $select: "CardCode,CardName,CreditLimit,CurrentAccountBalance",
              $top: 1,
            });
            customer = r.value?.[0] || null;
          } catch {}
        }
      }
    }
    if (!customer) {
      return { docNum: null, message: `Customer "${po.customerName}" not found in SAP B1. Manual processing required.`, poNumber: po.poNumber, currency: po.currency, total };
    }

    // Step 3: Create SO directly (skip credit block — mail flow is auto, flag if exceeded)
    const docLines = await Promise.all(lines.filter(l => l.itemCode && l.itemCode !== "null").map(async l => {
      const uomCode = (l.uomCode && l.uomCode !== "Manual") ? l.uomCode : await getItemDefaultUoM(activeSap, l.itemCode);
      return {
        ItemCode:  l.itemCode,
        Quantity:  parseFloat(l.qty)       || 1,
        UnitPrice: parseFloat(l.unitPrice) || 0,
        ...(uomCode ? { UoMCode: uomCode } : {}),
      };
    }));

    if (!docLines.length) {
      return { docNum: null, message: "No item codes found in PO — manual mapping required.", poNumber: po.poNumber, customerName: customer.CardName, currency: po.currency, total };
    }

    const { DocNum, DocEntry } = await createSoDirect(activeSap, {
      cardCode:    customer.CardCode,
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
      customerName: customer.CardName,
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
