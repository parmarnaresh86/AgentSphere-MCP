/**
 * Quotation Comparison Agent
 *  Read-only analysis agent — loads open sales quotations from SAP B1,
 *  groups them by customer and returns comparison/summary data.
 *  No posting. View only.
 */
import { Router } from 'express';

const _sessions = new Map();

function initSession() {
  return {
    step:      'INIT',
    history:   [],
    lastQuery: null,   // 'all' | cardCode searched
  };
}

function today() { return new Date().toISOString().slice(0, 10); }
function fmtN(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ── SAP helpers ────────────────────────────────────────────────────────────────

async function searchCustomers(sap, query) {
  try {
    const q = query.replace(/'/g, "''");
    const r = await sap.get('/BusinessPartners', {
      $filter:  `CardType eq 'cCustomer' and (substringof('${q}',CardName) or substringof('${q}',CardCode))`,
      $select:  'CardCode,CardName',
      $orderby: 'CardName',
      $top:     20,
    });
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[QCA] searchCustomers error:', e.message);
    return [];
  }
}

async function fetchOpenQuotations(sap, cardCode) {
  const cc = cardCode.replace(/'/g, "''");
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO' and CardCode eq '${cc}'`,
    $orderby: 'DocDate desc',
    $top:     100,
  };
  try {
    const r = await sap.get('/Quotations', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard,DocumentLines',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected — retry without */ }
  try {
    const r = await sap.get('/Quotations', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[QCA] fetchOpenQuotations error:', e.message);
    return [];
  }
}

async function fetchAllOpenQuotations(sap) {
  const base = {
    $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
    $orderby: 'DocDate desc',
    $top:     100,
  };
  try {
    const r = await sap.get('/Quotations', {
      ...base,
      $select: 'DocEntry,DocNum,DocDate,DocDueDate,CardCode,CardName,DocTotal,NumAtCard,DocumentLines',
    });
    if (Array.isArray(r.value)) return r.value;
  } catch { /* $select rejected — retry without */ }
  try {
    const r = await sap.get('/Quotations', base);
    return Array.isArray(r.value) ? r.value : [];
  } catch (e) {
    console.error('[QCA] fetchAllOpenQuotations error:', e.message);
    return [];
  }
}

// ── Data shaping ───────────────────────────────────────────────────────────────

function mapQuotation(q) {
  const lineCount = Array.isArray(q.DocumentLines) ? q.DocumentLines.length : 0;
  return {
    docNum:    q.DocNum,
    docEntry:  q.DocEntry,
    docDate:   q.DocDate    ? q.DocDate.slice(0, 10)    : null,
    validUntil: q.DocDueDate ? q.DocDueDate.slice(0, 10) : null,
    numAtCard: q.NumAtCard  || '',
    lineCount,
    docTotal:  Number(q.DocTotal || 0),
  };
}

function buildComparisonData(quotations) {
  // group by customer
  const groupMap = new Map();
  for (const q of quotations) {
    const key = q.CardCode || 'UNKNOWN';
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        cardCode:   q.CardCode   || 'UNKNOWN',
        cardName:   q.CardName   || q.CardCode || 'Unknown',
        count:      0,
        totalValue: 0,
        quotations: [],
      });
    }
    const grp = groupMap.get(key);
    grp.count      += 1;
    grp.totalValue += Number(q.DocTotal || 0);
    grp.quotations.push(mapQuotation(q));
  }

  // sort groups by totalValue desc
  const groups = [...groupMap.values()].sort((a, b) => b.totalValue - a.totalValue);

  const totalQuotations = quotations.length;
  const totalCustomers  = groups.length;
  const totalValue      = groups.reduce((s, g) => s + g.totalValue, 0);

  return {
    summary: { totalQuotations, totalCustomers, totalValue },
    groups,
  };
}

function buildSummaryReply(comparisonData) {
  const { summary, groups } = comparisonData;
  if (!summary.totalQuotations) {
    return 'No open quotations found.';
  }

  const topGroups = groups.slice(0, 5);
  const tableRows = topGroups.map(g =>
    `| ${g.cardName} | ${g.cardCode} | ${g.count} | ${fmtN(g.totalValue)} |`
  ).join('\n');

  return `### 📊 Open Quotations Summary\n\n` +
    `| Metric | Value |\n|---|---|\n` +
    `| **Total Quotations** | ${summary.totalQuotations} |\n` +
    `| **Customers** | ${summary.totalCustomers} |\n` +
    `| **Total Value** | ${fmtN(summary.totalValue)} |\n\n` +
    (topGroups.length
      ? `**Top Customers by Quotation Value:**\n\n| Customer | Code | Count | Total Value |\n|---|---|---|---|\n${tableRows}\n\n`
      : '') +
    `Search by customer name or type **"all"** to reload.`;
}

function buildCustomerReply(comparisonData, customerName) {
  const { summary, groups } = comparisonData;
  if (!summary.totalQuotations) {
    return `No open quotations found for **${customerName}**.`;
  }

  const g = groups[0];
  if (!g) return `No open quotations found for **${customerName}**.`;

  const tableRows = g.quotations.map(q =>
    `| ${q.docNum} | ${q.docDate || '—'} | ${q.validUntil || '—'} | ${q.numAtCard || '—'} | ${q.lineCount} | ${fmtN(q.docTotal)} |`
  ).join('\n');

  return `### 📋 Open Quotations for ${g.cardName} (${g.cardCode})\n\n` +
    `**${g.count}** open quotation${g.count !== 1 ? 's' : ''} — Total Value: **${fmtN(g.totalValue)}**\n\n` +
    `| Doc # | Date | Valid Until | Reference | Lines | Total |\n|---|---|---|---|---|---|\n` +
    `${tableRows}\n\n` +
    `Type another customer name to compare, or type **"all"** to see all customers.`;
}

// ── Router factory ─────────────────────────────────────────────────────────────

export function createQuotationComparisonRouter(deps) {
  const { requireAuth, getActiveSap } = deps;
  const router = Router();

  // ── POST /chat ─────────────────────────────────────────────────────────────
  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message = '', sessionId } = req.body;
      const sid = sessionId || `qca_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, initSession());
      const session = _sessions.get(sid);
      const sap     = getActiveSap();
      const msg     = message.trim();
      const msgL    = msg.toLowerCase();

      if (msg) session.history.push({ role: 'user', content: msg });

      let reply          = '';
      let quickReplies   = [];
      let comparisonData = null;
      let customerList   = null;

      // ── Reset / start over ─────────────────────────────────────────────────
      if (/start over|reset|cancel/i.test(msgL)) {
        Object.assign(session, initSession());
        reply = '## 🟣 Quotation Comparison Agent\n\nSession reset. Type a customer name, or type **"all"** to load all open quotations:';
        quickReplies = ['Show All Open Quotations'];

      // ── Load all quotations ────────────────────────────────────────────────
      } else if (!msg || /^all$/i.test(msgL) || /show all|all open|all quot/i.test(msgL)) {
        session.lastQuery = 'all';
        session.step      = 'SELECT_CUSTOMER';
        const quotations  = await fetchAllOpenQuotations(sap);
        comparisonData    = buildComparisonData(quotations);
        reply             = buildSummaryReply(comparisonData);
        quickReplies      = ['Refresh', 'Start Over'];

      // ── Refresh ────────────────────────────────────────────────────────────
      } else if (/^refresh$/i.test(msgL)) {
        if (session.lastQuery && session.lastQuery !== 'all') {
          const quotations = await fetchOpenQuotations(sap, session.lastQuery);
          comparisonData   = buildComparisonData(quotations);
          const grp        = comparisonData.groups[0];
          reply            = buildCustomerReply(comparisonData, grp?.cardName || session.lastQuery);
        } else {
          const quotations = await fetchAllOpenQuotations(sap);
          comparisonData   = buildComparisonData(quotations);
          reply            = buildSummaryReply(comparisonData);
        }
        quickReplies = ['Refresh', 'Show All Open Quotations', 'Start Over'];

      // ── Customer search / SELECT_CUSTOMER ─────────────────────────────────
      } else {
        const customers = await searchCustomers(sap, msg);

        if (!customers.length) {
          reply = `No customers found matching **"${msg}"**. Try a different name, or type **"all"** to see all open quotations.`;
          quickReplies = ['Show All Open Quotations'];

        } else if (customers.length === 1) {
          const c          = customers[0];
          session.lastQuery = c.CardCode;
          session.step      = 'SELECT_CUSTOMER';
          const quotations  = await fetchOpenQuotations(sap, c.CardCode);
          comparisonData    = buildComparisonData(quotations);
          reply             = buildCustomerReply(comparisonData, c.CardName);
          quickReplies      = ['Show All Open Quotations', 'Refresh', 'Start Over'];

        } else {
          // Multiple customers found — show list and load all their quotations
          customerList = customers.map(c => ({ cardCode: c.CardCode, cardName: c.CardName }));
          session.step = 'SELECT_CUSTOMER';

          // Load quotations for all matched customers and aggregate
          const allQuotations = [];
          await Promise.all(customers.slice(0, 10).map(async c => {
            const qs = await fetchOpenQuotations(sap, c.CardCode);
            allQuotations.push(...qs);
          }));
          comparisonData = buildComparisonData(allQuotations);

          reply = `Found **${customers.length}** customers matching **"${msg}"**.\n\n` +
            buildSummaryReply(comparisonData);
          quickReplies = ['Show All Open Quotations', 'Start Over'];
        }
      }

      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) session.history.splice(0, session.history.length - 40);

      res.json({
        ok: true, reply, quickReplies, sessionId: sid,
        step: session.step,
        comparisonData,
        customerList,
      });

    } catch (e) {
      console.error('[QCA] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── POST /reset ────────────────────────────────────────────────────────────
  router.post('/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  // ── GET /open-list — list open quotations for combo selectors ────────────────
  router.get('/open-list', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const r   = await sap.get('/Quotations', {
        $filter:  `DocumentStatus eq 'bost_Open' and Cancelled eq 'tNO'`,
        $select:  'DocEntry,DocNum,DocDate,CardCode,CardName,DocTotal',
        $orderby: 'DocDate desc',
        $top:     200,
      });
      const list = (Array.isArray(r.value) ? r.value : []).map(q => ({
        docEntry:  q.DocEntry,
        docNum:    q.DocNum,
        docDate:   (q.DocDate||'').slice(0,10),
        cardCode:  q.CardCode,
        cardName:  q.CardName,
        docTotal:  Number(q.DocTotal||0),
      }));
      res.json({ ok:true, list });
    } catch(e) { res.json({ ok:false, error:e.message, list:[] }); }
  });

  // ── GET /compare?q1=DocEntry&q2=DocEntry — fetch both quotations for GUI compare
  router.get('/compare', requireAuth, async (req, res) => {
    try {
      const sap = getActiveSap();
      const { q1, q2 } = req.query;
      if (!q1 || !q2) return res.status(400).json({ ok:false, error:'q1 and q2 required' });

      const [r1, r2] = await Promise.all([
        sap.get(`/Quotations(${parseInt(q1)})`),
        sap.get(`/Quotations(${parseInt(q2)})`),
      ]);

      const shape = (q) => ({
        docNum:    q.DocNum,
        docEntry:  q.DocEntry,
        docDate:   (q.DocDate||'').slice(0,10),
        validUntil:(q.DocDueDate||'').slice(0,10),
        cardCode:  q.CardCode,
        cardName:  q.CardName,
        reference: q.NumAtCard||'',
        docTotal:  Number(q.DocTotal||0),
        lines:     (q.DocumentLines||[]).map(l => ({
          lineNum:    l.LineNum,
          itemCode:   l.ItemCode||'',
          itemName:   l.ItemDescription||l.ItemName||'',
          qty:        Number(l.Quantity||0),
          unitPrice:  Number(l.UnitPrice||0),
          discount:   Number(l.DiscountPercent||0),
          lineTotal:  Number(l.LineTotal||0),
          taxCode:    l.VatGroup||l.TaxCode||'',
          unit:       l.UoMCode||l.MeasureUnit||'',
        })),
      });

      res.json({ ok:true, q1:shape(r1), q2:shape(r2) });
    } catch(e) { res.json({ ok:false, error:e.message }); }
  });

  return router;
}
