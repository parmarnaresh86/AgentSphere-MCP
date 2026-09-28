// Shared plumbing for the analytical "insight" agents (Collections, Cash Flow,
// Credit Risk, Sales Follow-up, Quotation Intelligence, Inventory Optimization,
// Dead Stock, Vendor Performance).
//
// Every one of these agents reads live SAP B1 tables through DB Direct (MSSQL
// or HANA) and returns the same response shape so a single generic panel in
// public/index.html can render all of them:
//
//   { ok, title, asOf, kpis:[{label,value,fmt,tone,hint}], tabs:[{key,label,
//     columns:[{key,label,fmt,align,badge}], rows:[...], actions?}], chart?,
//     insight (markdown), notes:[string] }
import { Router } from 'express';
import { qcol } from './sql-dialect.mjs';

export class AgentDataError extends Error {}

// ── Dates ────────────────────────────────────────────────────────────────────
export function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
export function todayISO() { return new Date().toISOString().slice(0, 10); }
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
}
export function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// ── Numbers ──────────────────────────────────────────────────────────────────
export const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const round = (v, d = 2) => { const f = 10 ** d; return Math.round(num(v) * f) / f; };
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function fmtAmt(n) { return num(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function percentile(arr, p) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = clamp((a.length - 1) * p, 0, a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

// Standard aging bucket used across the finance agents.
export function agingBucket(daysOverdue) {
  if (daysOverdue <= 0)   return 'Current';
  if (daysOverdue <= 30)  return '1-30';
  if (daysOverdue <= 60)  return '31-60';
  if (daysOverdue <= 90)  return '61-90';
  if (daysOverdue <= 180) return '91-180';
  return '180+';
}
export const AGING_BUCKETS = ['Current', '1-30', '31-60', '61-90', '91-180', '180+'];

// ── SQL kit ──────────────────────────────────────────────────────────────────
// Templates use @TABLE for a fully-qualified table ref and {Column} for a
// dialect-quoted identifier, so one SQL string works on both MSSQL and HANA:
//   k.run(`SELECT T0.{DocEntry} FROM @OINV T0 WHERE T0.{DocStatus} = 'O'`)
// Date math is done in JS (not DATEDIFF / DAYS_BETWEEN) for the same reason.
export function sqlKit(deps) {
  const { isConnected, getActiveType, getActiveConfig, executeSQL, tableRef, getTableColumns } = deps || {};
  if (!isConnected || !isConnected()) {
    throw new AgentDataError('This agent reads live SAP tables and needs a DB Direct connection. Configure one under Tools → DB Connection, then re-run.');
  }
  const isHana = getActiveType() === 'hana';
  const cfg = getActiveConfig();
  const S = tpl => tpl
    .replace(/@([A-Z][A-Z0-9_]*)\b/g, (_, t) => tableRef(t, cfg))
    .replace(/\{(\w+)\}/g, (_, c) => qcol(c, isHana));
  const colCache = new Map();
  async function cols(table) {
    if (!colCache.has(table)) colCache.set(table, await getTableColumns(table));
    return colCache.get(table);
  }
  return {
    isHana,
    company: cfg?.database || cfg?.schema_name || 'default',
    S,
    run: tpl => executeSQL(S(tpl)),
    lit: s => `'${String(s ?? '').replace(/'/g, "''")}'`,
    // Verify every column we are about to query exists on this DB, so a
    // localisation/version difference fails loudly instead of returning junk.
    async need(table, list) {
      const have = await cols(table);
      if (!have.size) throw new AgentDataError(`Table ${table} was not found on the connected database.`);
      const missing = list.filter(c => !have.has(c.toLowerCase()));
      if (missing.length) throw new AgentDataError(`${table} is missing column(s) ${missing.join(', ')} on this database.`);
    },
    async has(table, col) {
      try { return (await cols(table)).has(col.toLowerCase()); } catch { return false; }
    },
  };
}

// ── AI ───────────────────────────────────────────────────────────────────────
// Same provider order as the other controllers. Never throws — callers fall
// back to their rule-based text when this returns ''.
export async function callAI(aiDeps, messages, systemPrompt, maxTokens = 1024) {
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
      const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
      const r = await azureMessagesCreate({ model, messages: msgs, max_tokens: maxTokens });
      return r.content?.[0]?.text || r.choices?.[0]?.message?.content || '';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: maxTokens,
        system: systemPrompt || undefined, messages,
      });
      return resp.content?.[0]?.text || '';
    }
  } catch (e) {
    console.warn('[InsightAgent/AI] call failed:', e.message);
  }
  return '';
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

// ── SAP Activity (follow-up call / task) via Service Layer ──────────────────
// Tries with the document link first; some SL versions reject DocType/DocEntry
// on activities, so it retries once without them.
export async function createSapActivity(sap, { cardCode, subject, notes, docType, docEntry, dueDate, kind = 'call' }) {
  const base = {
    CardCode: cardCode,
    ActivityDate: todayISO(),
    Activity: kind === 'task' ? 'cn_Task' : 'cn_Conversation',
    Subject: String(subject || '').slice(0, 100),
    Notes: notes || '',
    Closed: 'tNO',
    Priority: 'pr_High',
  };
  if (dueDate) base.EndDueDate = dueDate;
  const withDoc = docType && docEntry ? { ...base, DocType: String(docType), DocEntry: String(docEntry) } : null;
  try {
    const r = await sap.post('/Activities', withDoc || base);
    return { ok: true, activityCode: r?.ActivityCode ?? null };
  } catch (e) {
    if (!withDoc) throw e;
    const r = await sap.post('/Activities', base);
    return { ok: true, activityCode: r?.ActivityCode ?? null, note: 'Created without document link' };
  }
}

// ── Router factory ───────────────────────────────────────────────────────────
// Wires the routes every insight agent shares:
//   POST /analyze → run(k, params, ctx) → payload; adds AI insight + caches it
//   POST /chat    → AI Q&A grounded in the caller's last /analyze result
// `extra(router, helpers)` lets an agent add its own action routes.
export function createInsightRouter(deps, spec) {
  const { requireAuth, getActiveSap, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI } = deps;
  const router = Router();
  const aiDeps = () => (USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null);
  const lastResult = new Map();   // userId → { payload, at }
  const sessions = new Map();     // sessionId → history
  const userKey = req => String(req.user?.id ?? req.user?.username ?? 'anon');
  const dbDeps = {
    isConnected: deps.isConnected, getActiveType: deps.getActiveType, getActiveConfig: deps.getActiveConfig,
    executeSQL: deps.executeSQL, tableRef: deps.tableRef, getTableColumns: deps.getTableColumns,
  };
  const helpers = {
    kit: () => sqlKit(dbDeps), getActiveSap, aiDeps, requireAuth,
    lastFor: req => lastResult.get(userKey(req))?.payload || null,
  };

  router.post('/analyze', requireAuth, async (req, res) => {
    const t0 = Date.now();
    try {
      const params = { ...(spec.defaults || {}), ...(req.body || {}) };
      params.asOf = isoDate(params.asOf) || todayISO();
      const k = sqlKit(dbDeps);
      const payload = await spec.run(k, params, { req, getActiveSap });

      // AI narrative on top of the deterministic numbers. The rule-based
      // `insight` from run() stays as the fallback when AI is off or slow.
      if (params.useAI !== false && USE_AI && payload.aiContext) {
        const ai = await withTimeout(callAI(aiDeps(),
          [{ role: 'user', content: `${spec.aiTask}\n\n${payload.aiContext}` }],
          `${spec.persona} Today is ${params.asOf}. Only use figures present in the data; never invent numbers. Amounts are in the company's local currency: never add a currency symbol or code. Reply in concise markdown: a one-line headline in bold, then 3-5 bullet points with specific names, document numbers and amounts, then a "Next actions" list.`,
          900), 30_000, '');
        if (ai) payload.insight = ai;
      }
      payload.aiSource = payload.insight && USE_AI && params.useAI !== false ? 'ai-or-rules' : 'rules';
      lastResult.set(userKey(req), { payload: { ...payload, params }, at: Date.now() });
      const { aiContext, ...out } = payload;
      res.json({ ok: true, title: spec.title, asOf: params.asOf, elapsedMs: Date.now() - t0, ...out });
    } catch (e) {
      const known = e instanceof AgentDataError;
      if (!known) console.error(`[${spec.title}] /analyze error:`, e);
      res.status(known ? 400 : 500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId } = req.body || {};
      const msg = String(message || '').trim();
      if (!msg) return res.status(400).json({ ok: false, error: 'message required' });
      const sid = sessionId || `${spec.slug}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const last = helpers.lastFor(req);
      if (!last) return res.json({ ok: true, sessionId: sid, reply: 'Run **Analyze** first so I have live data to answer from.' });
      if (!USE_AI) return res.json({ ok: true, sessionId: sid, reply: 'AI is not configured on this server (no API key), so I can only show the computed tables above. The **Insight** box has the rule-based summary.' });

      const history = sessions.get(sid) || [];
      history.push({ role: 'user', content: msg });
      if (history.length > 20) history.splice(0, history.length - 20);
      sessions.set(sid, history);
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);

      const sys = `${spec.persona}
Today is ${last.params.asOf}. Amounts are in the company's local currency — never add a currency symbol or code. Answer strictly from the analysis data below (computed live from SAP B1). If the data does not contain the answer, say so. Use markdown tables for lists, thousand separators for amounts, and keep it concise and actionable.

${last.aiContext || ''}`;
      const reply = (await callAI(aiDeps(), history, sys, 1200)) || 'I could not get an answer from the AI provider. Please try again.';
      history.push({ role: 'assistant', content: reply });
      res.json({ ok: true, sessionId: sid, reply });
    } catch (e) {
      console.error(`[${spec.title}] /chat error:`, e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  if (spec.extra) spec.extra(router, helpers);
  return router;
}

// Compact text table for AI context (keeps token use predictable).
export function ctxTable(rows, cols, limit = 25) {
  const head = cols.map(c => c[1]).join(' | ');
  const body = rows.slice(0, limit).map(r => cols.map(([k]) => {
    const v = r[k];
    return typeof v === 'number' ? (Math.abs(v) >= 100 ? fmtAmt(v) : round(v, 1)) : (v ?? '');
  }).join(' | ')).join('\n');
  return `${head}\n${body}${rows.length > limit ? `\n… ${rows.length - limit} more rows` : ''}`;
}
