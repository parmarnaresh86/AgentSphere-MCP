/**
 * PO Agentic Workflow — a manually-uploaded PDF purchase order walked
 * through 5 steps: parse (AI extraction), find the matching SAP customer,
 * credit check, per-line ATP (available-to-promise) check, then create the
 * Sales Order. This is the upload-driven counterpart to the IMAP-polling
 * Mail-PO→SO agent (still inline in chat-server.mjs), which shares
 * createSoDirect/callAiText with this one via lib/sap-order-helpers.mjs.
 *
 * Extracted from chat-server.mjs (was ~230 inline lines under
 * "PO Agentic Workflow") as part of splitting that file into per-agent
 * modules, following the same createXRouter(deps) factory pattern already
 * used by production-agent.mjs / mrp-agent.mjs / pricing-agent.mjs /
 * procurement-agent.mjs.
 */
import { Router } from 'express';
import multer from 'multer';
import { createRequire } from 'module';
import { createSoDirect, callAiText as callAiTextShared } from '../lib/sap-order-helpers.mjs';

const _require = createRequire(import.meta.url);
let pdfParse;
try { pdfParse = _require('pdf-parse'); } catch (e) { console.warn('pdf-parse load failed:', e.message); pdfParse = null; }

const esc = s => String(s || '').replace(/'/g, "''");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

export function createPoWorkflowAgentRouter(deps) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER } = deps;
  const callAiText = (prompt, maxTokens) => callAiTextShared(prompt, maxTokens, { AI_PROVIDER, azureMessagesCreate, gptChatComplete });
  const router = Router();

  // Step 1: Parse PO PDF
  router.post('/parse', requireAuth, (req, res, next) => {
    upload.single('pdf')(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'File upload error: ' + err.message });
      next();
    });
  }, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded — make sure you select a PDF' });
    if (!pdfParse) return res.status(500).json({ error: 'PDF parser not available on this server' });
    try {
      const pdfData = await pdfParse(req.file.buffer);
      const rawText = pdfData.text.trim();
      if (!rawText) return res.status(422).json({ error: 'PDF appears to be image-only — cannot extract text. Please use a text-based PDF.' });

      const prompt = `You are a purchase order parser. Extract all purchase order data from the text below.
Return ONLY a valid JSON object — no markdown fences, no explanation, no extra text.

Required JSON structure:
{
  "poNumber": "PO number string or null",
  "poDate": "YYYY-MM-DD or null",
  "deliveryDate": "YYYY-MM-DD or null",
  "customerName": "the BUYER company name who placed the order",
  "customerRef": "buyer's own account/PO reference code if visible (NOT the supplier's code) or null",
  "vendorRef": "supplier/vendor reference if shown or null",
  "currency": "3-letter ISO code e.g. USD GBP EUR INR — guess from context if not shown",
  "lines": [
    { "lineNum": 1, "description": "item description", "itemCode": "product code if shown or null", "qty": 10, "unit": "EA", "unitPrice": 5.50, "lineTotal": 55.00 }
  ],
  "subtotal": 0,
  "tax": 0,
  "total": 0,
  "notes": "any delivery, payment, or special instructions or null"
}

PO TEXT:
${rawText.substring(0, 8000)}`;

      const aiText = await callAiText(prompt, 2500);
      const match = aiText.match(/\{[\s\S]*\}/);
      if (!match) return res.status(422).json({ error: 'AI could not extract structured PO data from this document' });

      const poData = JSON.parse(match[0]);
      const lines = Array.isArray(poData.lines) ? poData.lines : [];
      const total = poData.total || lines.reduce((s, l) => s + (parseFloat(l.lineTotal) || parseFloat(l.qty) * parseFloat(l.unitPrice || 0) || 0), 0);

      res.json({ ok: true, fileName: req.file.originalname, pageCount: pdfData.numpages, lineCount: lines.length, total, ...poData, lines });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Step 2: Find Customer
  router.post('/customer', requireAuth, async (req, res) => {
    const { name = '', code = '' } = req.body || {};
    try {
      let candidates = [];
      const activeSap = getActiveSap();
      const debugUrl  = activeSap._activeUrl || activeSap.baseUrl || '(unknown)';
      const debugComp = activeSap._connCredentials?.company || process.env.SAP_B1_COMPANY || '(unknown)';
      const errors    = [];

      // Tier 1: full name search
      if (name) {
        const term = name.substring(0, 35).replace(/'/g, '').replace(/-/g, ' ').trim();
        try {
          const r = await activeSap.get('/BusinessPartners', {
            $filter: `CardType eq 'cCustomer' and contains(CardName,'${term}')`,
            $select: 'CardCode,CardName,CreditLimit,CurrentAccountBalance,Phone1',
            $orderby: 'CardName asc', $top: 10
          });
          candidates = r.value || [];
        } catch(e) { errors.push(`T1: ${e.message}`); }
      }

      // Tier 2: tolower case-insensitive
      if (!candidates.length && name) {
        const termLower = name.substring(0, 35).replace(/'/g, '').replace(/-/g, ' ').trim().toLowerCase();
        try {
          const r = await activeSap.get('/BusinessPartners', {
            $filter: `CardType eq 'cCustomer' and contains(tolower(CardName),'${termLower}')`,
            $select: 'CardCode,CardName,CreditLimit,CurrentAccountBalance,Phone1',
            $orderby: 'CardName asc', $top: 10
          });
          candidates = r.value || [];
        } catch(e) { errors.push(`T2: ${e.message}`); }
      }

      // Tier 3: first word only
      if (!candidates.length && name) {
        const firstWord = name.split(/[\s\-]/)[0];
        if (firstWord && firstWord.length > 2) {
          try {
            const r = await activeSap.get('/BusinessPartners', {
              $filter: `CardType eq 'cCustomer' and startswith(CardName,'${firstWord.replace(/'/g,'')}')`,
              $select: 'CardCode,CardName,CreditLimit,CurrentAccountBalance,Phone1',
              $orderby: 'CardName asc', $top: 10
            });
            candidates = r.value || [];
          } catch(e) { errors.push(`T3: ${e.message}`); }
        }
      }

      // Tier 4: PDF reference code as SAP B1 CardCode
      if (!candidates.length && code) {
        try {
          const r = await activeSap.get(`/BusinessPartners('${esc(code)}')`);
          if (r?.CardCode) candidates = [r];
        } catch(e) { errors.push(`T4: ${e.message}`); }
      }

      console.log(`[CUST-SEARCH] company=${debugComp} url=${debugUrl} name="${name}" found=${candidates.length} errors=${JSON.stringify(errors)}`);

      if (!candidates.length) return res.json({ found: false, candidates: [], debug: { company: debugComp, url: debugUrl, errors } });
      res.json({ found: true, exact: candidates.length === 1, customer: candidates[0], candidates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Step 3: Credit check
  router.post('/credit', requireAuth, async (req, res) => {
    const { cardCode, orderTotal = 0 } = req.body || {};
    if (!cardCode) return res.status(400).json({ error: 'cardCode required' });
    try {
      const bp = await getActiveSap().get(`/BusinessPartners('${esc(cardCode)}')`);
      const limit     = parseFloat(bp.CreditLimit)              || 0;
      const balance   = parseFloat(bp.CurrentAccountBalance)    || 0;
      const openOrders= (parseFloat(bp.OrdersBalance) || 0) + (parseFloat(bp.OpenDeliveryNotesBalance) || 0);
      const exposure  = balance + openOrders;
      const orderAmt  = parseFloat(orderTotal)     || 0;
      const newExposure = exposure + orderAmt;

      let status = 'ok', message = '';
      if (limit > 0) {
        const pct = (newExposure / limit) * 100;
        if (newExposure > limit)    { status = 'exceeded'; message = `Over limit by ${(newExposure - limit).toLocaleString('en', {minimumFractionDigits:2})}`; }
        else if (pct > 80)          { status = 'warning';  message = `${pct.toFixed(1)}% of credit limit will be used`; }
      }
      res.json({ ok: true, cardCode, cardName: bp.CardName, creditLimit: limit, balance, openOrders, exposure, orderAmt, newExposure, status, message, noLimit: limit === 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Step 4: ATP check (per line)
  router.post('/atp', requireAuth, async (req, res) => {
    const { lines = [] } = req.body || {};
    try {
      const results = await Promise.all(lines.map(async (line) => {
        if (!line.itemCode) {
          // Try to suggest item by description
          let suggestions = [];
          if (line.description) {
            const term = line.description.substring(0, 25).replace(/'/g, '');
            try {
              const r = await getActiveSap().get('/Items', { $filter: `contains(ItemName,'${term}') and ItemType eq 'itItems'`, $select: 'ItemCode,ItemName,QuantityOnStock', $top: 5 });
              suggestions = r.value || [];
            } catch {}
          }
          return { ...line, available: null, status: 'unmapped', suggestions };
        }
        try {
          const item = await getActiveSap().get(`/Items('${esc(line.itemCode)}')`, { $select: 'ItemCode,ItemName,QuantityOnStock,QuantityOrderedByCustomers' });
          const onStock   = parseFloat(item.QuantityOnStock)              || 0;
          const committed = parseFloat(item.QuantityOrderedByCustomers)   || 0;
          const available = Math.max(0, onStock - committed);
          const qty       = parseFloat(line.qty)                          || 0;
          const status    = available === 0 ? 'none' : available < qty ? 'partial' : 'ok';
          return { ...line, itemName: item.ItemName, available, onStock, committed, status };
        } catch {
          return { ...line, available: null, status: 'notfound', message: `Item '${line.itemCode}' not found in SAP B1` };
        }
      }));

      const allOk    = results.every(r => r.status === 'ok');
      const hasIssue = results.some(r => ['none', 'notfound', 'unmapped'].includes(r.status));
      res.json({ ok: true, lines: results, overallStatus: allOk ? 'ok' : hasIssue ? 'issues' : 'partial', issueCount: results.filter(r => r.status !== 'ok').length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Step 5: Create Sales Order
  router.post('/create', requireAuth, async (req, res) => {
    const { cardCode, poNumber, poDate, deliveryDate, lines = [], notes, creditOverride, allowDuplicateRef } = req.body || {};
    if (!cardCode) return res.status(400).json({ error: 'cardCode required' });
    const docLines = lines.filter(l => l.itemCode).map(l => ({ ItemCode: l.itemCode, Quantity: parseFloat(l.qty) || 1, UnitPrice: parseFloat(l.unitPrice) || 0, ...(l.uomCode && l.uomCode !== 'Manual' ? { UoMCode: l.uomCode } : {}) }));
    if (!docLines.length) return res.status(400).json({ error: 'No valid item codes — map all items before creating order' });
    try {
      const comments = [poNumber ? `PO Ref: ${poNumber}` : '', notes || '', creditOverride ? 'Credit override approved' : ''].filter(Boolean).join(' | ');
      const { DocNum, DocEntry } = await createSoDirect(getActiveSap(), { cardCode, docDate: poDate, docDueDate: deliveryDate, numAtCard: poNumber, comments, docLines, allowDuplicateRef });
      res.json({ ok: true, docNum: DocNum, docEntry: DocEntry, message: `Sales Order #${DocNum} created` });
    } catch (e) {
      if (e.duplicateRef) return res.status(409).json({ error: e.message, duplicateRef: true, numAtCard: e.numAtCard, suggestedRef: e.suggestedRef });
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
