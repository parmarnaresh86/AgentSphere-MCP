// AI layer for the Forecast Dashboard (public/index.html → forecast-dashboard-panel).
//
// The dashboard computes everything client-side from the /api/forecast/* reads
// (open SOs/POs, order matrix, supply vs demand, 9-model forecast, stock
// projection). The browser sends that snapshot here; the AI only explains and
// recommends from it — it never fetches or invents figures.
//
//   POST /api/forecast/ai/insight  { snapshot }                    → { insight, source }
//   POST /api/forecast/ai/chat     { message, sessionId, snapshot } → { reply, sessionId }
import { Router } from 'express';
import { callAI } from '../lib/insight-kit.mjs';

const PERSONA = `You are a demand-planning and inventory analyst for a company running SAP Business One.
You explain the Forecast Dashboard for one item to a purchasing / supply-chain manager.
Only use figures present in the dashboard snapshot; never invent numbers, dates, vendors or documents.
Amounts are in the company's local currency: never add a currency symbol or code. Quantities are in the item's UoM.
If something needed is missing from the snapshot (e.g. the forecast was not run yet), say which button to click.`;

const MAX_SNAPSHOT = 24_000; // chars — keeps token use predictable

function snapshotText(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const s = JSON.stringify(snap, (_, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  return s.length > MAX_SNAPSHOT ? `${s.slice(0, MAX_SNAPSHOT)} …(truncated)` : s;
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

export function createForecastDashboardAiRouter({ requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI }) {
  const router = Router();
  const aiDeps = () => (USE_AI ? { AI_PROVIDER, gptChatComplete, azureMessagesCreate } : null);
  const sessions = new Map(); // sessionId → [{role, content}]

  router.post('/insight', requireAuth, async (req, res) => {
    try {
      const snap = req.body?.snapshot;
      if (!snap?.item?.code) return res.status(400).json({ ok: false, error: 'Load an item first.' });
      if (!USE_AI) return res.json({ ok: true, source: 'off', insight: '' });
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `Analyse this Forecast Dashboard snapshot for item ${snap.item.code} and give a planning briefing.

Snapshot (JSON):
${snapshotText(snap)}`;
      const ai = await withTimeout(callAI(aiDeps(), [{ role: 'user', content: prompt }],
        `${PERSONA}
Today is ${today}. Reply in concise markdown with exactly these sections:
**Headline** — one bold sentence on the item's situation.
**Demand outlook** — 2-3 bullets (trend, growth, forecast next month / horizon, model reliability from MAPE: <20% good, 20-50% fair, >50% weak).
**Supply & stock risk** — 2-4 bullets (net gap, projected stockout month, overdue / late POs with numbers and vendors, safety stock vs available).
**Recommended actions** — 3-5 numbered actions with quantities and dates where the snapshot supports them (e.g. order qty and order-by date from the reorder plan, which POs to expedite).
**Data caveats** — 1-2 bullets only if something looks off (sparse history, zero lead time, high MAPE).`,
        1100), 45_000, '');
      res.json({ ok: true, insight: ai, source: ai ? 'ai' : 'none' });
    } catch (e) {
      console.error('[ForecastDashboard/AI] /insight error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/chat', requireAuth, async (req, res) => {
    try {
      const { message, sessionId, snapshot } = req.body || {};
      const msg = String(message || '').trim();
      if (!msg) return res.status(400).json({ ok: false, error: 'message required' });
      const sid = sessionId || `fdai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!USE_AI) return res.json({ ok: true, sessionId: sid, reply: 'AI is not configured on this server (no API key), so only the computed figures on the dashboard are available.' });
      if (!snapshot?.item?.code) return res.json({ ok: true, sessionId: sid, reply: 'Select an item and click **Load Item** first so I have data to answer from.' });

      const history = sessions.get(sid) || [];
      history.push({ role: 'user', content: msg });
      if (history.length > 20) history.splice(0, history.length - 20);
      sessions.set(sid, history);
      if (sessions.size > 500) sessions.delete(sessions.keys().next().value);

      const sys = `${PERSONA}
Today is ${new Date().toISOString().slice(0, 10)}. Answer strictly from the snapshot below (it reflects what the user currently sees). Use markdown tables for lists, thousand separators, and keep answers short and actionable. For "what-if" questions, show the arithmetic you used.

Dashboard snapshot (JSON):
${snapshotText(snapshot)}`;
      const reply = (await withTimeout(callAI(aiDeps(), history, sys, 1200), 60_000, ''))
        || 'I could not get an answer from the AI provider. Please try again.';
      history.push({ role: 'assistant', content: reply });
      res.json({ ok: true, sessionId: sid, reply });
    } catch (e) {
      console.error('[ForecastDashboard/AI] /chat error:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
