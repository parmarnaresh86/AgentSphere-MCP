/**
 * AI Credits admin API — mounted at /api/ai-credits.
 *
 * GET /me is available to every signed-in user (their own balance). Every
 * other route needs the admin.ai_credits permission (admin/superadmin roles
 * have it by default). Data lives in lib/ai-credits.mjs.
 */
import { Router } from 'express';
import db, { userPermRepo } from '../db.mjs';
import { creditSettings, pricingRepo, creditRepo, adjustCredit } from '../lib/ai-credits.mjs';

// Date filters arrive as YYYY-MM-DD; SQLite CURRENT_TIMESTAMP is UTC "YYYY-MM-DD HH:MM:SS".
function dateRange(q, col = 'created_at') {
  const where = [], args = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) { where.push(`${col} >= ?`); args.push(`${q.from} 00:00:00`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to   || '')) { where.push(`${col} <= ?`); args.push(`${q.to} 23:59:59`); }
  return { where, args };
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createAiCreditsRouter(deps) {
  const { requireAuth } = deps;
  const router = Router();

  const requireCreditAdmin = (req, res, next) => {
    const u = req.user;
    const ok = u.role === 'superadmin' || userPermRepo.getEffective(u.user_id, u.role).includes('admin.ai_credits');
    if (!ok) return res.status(403).json({ error: 'AI Credits admin permission required' });
    next();
  };
  const by = (req) => req.user.username || '';

  // ── Own balance (any user) ────────────────────────────────────────────────
  router.get('/me', requireAuth, (req, res) => {
    try {
      const b = creditRepo.balance(req.user.user_id);
      const s = creditSettings.get();
      res.json({ ...b, enforce: !!s.enforce, low_balance_pct: s.low_balance_pct });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.use(requireAuth, requireCreditAdmin);

  // ── Dashboard summary ─────────────────────────────────────────────────────
  router.get('/summary', (req, res) => {
    try {
      const { where, args } = dateRange(req.query);
      const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const totals = db.prepare(`SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens,
                                        COALESCE(SUM(input_cost),0) input_cost, COALESCE(SUM(output_cost),0) output_cost, COALESCE(SUM(total_cost),0) total_cost,
                                        COUNT(DISTINCT user_id) active_users
                                 FROM ai_usage_log ${W}`).get(...args);
      const byModel = db.prepare(`SELECT model, priced_as, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(total_cost) total_cost
                                  FROM ai_usage_log ${W} GROUP BY model ORDER BY total_cost DESC`).all(...args);
      const byDay = db.prepare(`SELECT substr(created_at,1,10) day, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(input_cost) input_cost, SUM(output_cost) output_cost, SUM(total_cost) total_cost
                                FROM ai_usage_log ${W} GROUP BY day ORDER BY day`).all(...args);
      const byFeature = db.prepare(`SELECT feature, COUNT(*) calls, SUM(total_cost) total_cost
                                    FROM ai_usage_log ${W} GROUP BY feature ORDER BY total_cost DESC LIMIT 10`).all(...args);
      const topUsers = db.prepare(`SELECT user_id, username, COUNT(*) calls, SUM(input_tokens+output_tokens) tokens, SUM(total_cost) total_cost
                                   FROM ai_usage_log ${W} GROUP BY user_id, username ORDER BY total_cost DESC LIMIT 8`).all(...args);
      const credit = db.prepare(`SELECT COALESCE(SUM(CASE WHEN unlimited=0 THEN allowed_usd END),0) allowed, COALESCE(SUM(used_usd),0) used,
                                        SUM(CASE WHEN unlimited=0 AND blocked=0 AND allowed_usd-used_usd<=0 THEN 1 ELSE 0 END) exhausted
                                 FROM ai_user_credits`).get();
      const prompts = db.prepare(`SELECT COUNT(*) n, COALESCE(AVG(total_cost),0) avg_cost, COALESCE(MAX(total_cost),0) max_cost FROM ai_prompts ${W}`).get(...args);
      const topPrompts = db.prepare(`SELECT id, username, prompt, feature, calls, total_cost, created_at FROM ai_prompts ${W} ORDER BY total_cost DESC LIMIT 5`).all(...args);
      res.json({ totals, prompts, topPrompts, byModel, byDay, byFeature, topUsers, credit, settings: creditSettings.get() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Users & balances ──────────────────────────────────────────────────────
  router.get('/users', (_req, res) => {
    try {
      // Make sure every user has an account row so the list is complete.
      for (const u of db.prepare(`SELECT id FROM users`).all()) creditRepo.ensure(u.id);
      const rows = db.prepare(`
        SELECT u.id user_id, u.username, u.full_name, u.role,
               c.allowed_usd, c.used_usd, c.unlimited, c.blocked, c.updated_at,
               ROUND(c.allowed_usd - c.used_usd, 6) remaining_usd,
               (SELECT COUNT(*) FROM ai_usage_log l WHERE l.user_id=u.id) calls,
               (SELECT COALESCE(SUM(input_tokens),0) FROM ai_usage_log l WHERE l.user_id=u.id) input_tokens,
               (SELECT COALESCE(SUM(output_tokens),0) FROM ai_usage_log l WHERE l.user_id=u.id) output_tokens,
               (SELECT MAX(created_at) FROM ai_usage_log l WHERE l.user_id=u.id) last_used
        FROM users u JOIN ai_user_credits c ON c.user_id=u.id
        ORDER BY c.used_usd DESC, u.username`).all();
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  const ACTIONS = new Set(['grant', 'set_limit', 'reset_usage', 'unlimited', 'limited', 'block', 'unblock']);

  router.post('/users/:id/:action', (req, res) => {
    const { action } = req.params;
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });
    const amount = Number(req.body?.amount);
    if ((action === 'grant' || action === 'set_limit') && !Number.isFinite(amount))
      return res.status(400).json({ error: 'amount (USD) is required' });
    try {
      res.json(adjustCredit(Number(req.params.id), action, { amount, note: String(req.body?.note || '').slice(0, 300) }, by(req)));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Apply one action to several users at once (e.g. monthly top-up for everyone).
  router.post('/bulk/:action', (req, res) => {
    const { action } = req.params;
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });
    const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'user_ids required' });
    const amount = Number(req.body?.amount);
    if ((action === 'grant' || action === 'set_limit') && !Number.isFinite(amount))
      return res.status(400).json({ error: 'amount (USD) is required' });
    try {
      const note = String(req.body?.note || '').slice(0, 300);
      const results = db.transaction(() => ids.map(id => adjustCredit(id, action, { amount, note }, by(req))))();
      res.json({ ok: true, updated: results.length });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Usage history (paged, filterable, CSV export) ─────────────────────────
  router.get('/usage', (req, res) => {
    try {
      const { where, args } = dateRange(req.query);
      if (req.query.user_id) { where.push('user_id = ?'); args.push(Number(req.query.user_id)); }
      if (req.query.model)   { where.push('model = ?');   args.push(String(req.query.model)); }
      if (req.query.q)       { where.push('(username LIKE ? OR model LIKE ? OR feature LIKE ?)'); const q = `%${req.query.q}%`; args.push(q, q, q); }
      const W = where.length ? `WHERE ${where.join(' AND ')}` : '';

      if (req.query.format === 'csv') {
        const rows = db.prepare(`SELECT * FROM ai_usage_log ${W} ORDER BY created_at DESC, id DESC LIMIT 100000`).all(...args);
        const cols = ['id','created_at','username','model','priced_as','provider','feature','input_tokens','output_tokens','input_rate','output_rate','input_cost','output_cost','total_cost','balance_after','estimated'];
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="ai-usage-${new Date().toISOString().slice(0,10)}.csv"`);
        return res.send([cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\n'));
      }

      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
      const page  = Math.max(1, Number(req.query.page) || 1);
      const total = db.prepare(`SELECT COUNT(*) n FROM ai_usage_log ${W}`).get(...args).n;
      const rows  = db.prepare(`SELECT * FROM ai_usage_log ${W} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
      const models = db.prepare(`SELECT DISTINCT model FROM ai_usage_log ORDER BY model`).all().map(r => r.model);
      res.json({ rows, total, page, limit, models });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Prompt history — one row per user prompt, with its per-model split ────
  router.get('/prompts', (req, res) => {
    try {
      const { where, args } = dateRange(req.query, 'p.created_at');
      if (req.query.user_id) { where.push('p.user_id = ?'); args.push(Number(req.query.user_id)); }
      if (req.query.model)   { where.push('EXISTS (SELECT 1 FROM ai_usage_log l WHERE l.prompt_id=p.id AND l.model=?)'); args.push(String(req.query.model)); }
      if (req.query.q)       { where.push('(p.prompt LIKE ? OR p.username LIKE ? OR p.feature LIKE ?)'); const q = `%${req.query.q}%`; args.push(q, q, q); }
      const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const modelsFor = (ids) => {
        if (!ids.length) return {};
        const rows = db.prepare(`SELECT prompt_id, model, COUNT(*) calls, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(total_cost) total_cost
                                 FROM ai_usage_log WHERE prompt_id IN (${ids.map(() => '?').join(',')}) GROUP BY prompt_id, model ORDER BY total_cost DESC`).all(...ids);
        const out = {};
        for (const r of rows) (out[r.prompt_id] ||= []).push(r);
        return out;
      };

      if (req.query.format === 'csv') {
        const rows = db.prepare(`SELECT p.* FROM ai_prompts p ${W} ORDER BY p.created_at DESC, p.id DESC LIMIT 50000`).all(...args);
        const models = modelsFor(rows.map(r => r.id));
        const cols = ['id','created_at','username','feature','prompt','models','calls','input_tokens','output_tokens','total_cost'];
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="ai-prompts-${new Date().toISOString().slice(0,10)}.csv"`);
        return res.send([cols.join(','), ...rows.map(r => {
          const m = (models[r.id] || []).map(x => `${x.model}=$${Number(x.total_cost).toFixed(6)}`).join('; ');
          return cols.map(c => csvCell(c === 'models' ? m : r[c])).join(',');
        })].join('\n'));
      }

      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
      const page  = Math.max(1, Number(req.query.page) || 1);
      const agg   = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cost),0) cost, COALESCE(AVG(total_cost),0) avg_cost, COALESCE(MAX(total_cost),0) max_cost FROM ai_prompts p ${W}`).get(...args);
      const rows  = db.prepare(`SELECT p.* FROM ai_prompts p ${W} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
      const models = modelsFor(rows.map(r => r.id));
      res.json({ rows: rows.map(r => ({ ...r, models: models[r.id] || [] })), total: agg.n, page, limit,
                 stats: { cost: agg.cost, avg_cost: agg.avg_cost, max_cost: agg.max_cost } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/prompts/:id', (req, res) => {
    try {
      const p = db.prepare(`SELECT * FROM ai_prompts WHERE id=?`).get(Number(req.params.id));
      if (!p) return res.status(404).json({ error: 'Not found' });
      const calls = db.prepare(`SELECT * FROM ai_usage_log WHERE prompt_id=? ORDER BY id`).all(p.id);
      res.json({ ...p, calls });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One user's all-time spend split by model.
  router.get('/users/:id/models', (req, res) => {
    try {
      res.json(db.prepare(`SELECT model, COUNT(*) calls, COUNT(DISTINCT prompt_id) prompts, SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens, SUM(total_cost) total_cost
                           FROM ai_usage_log WHERE user_id=? GROUP BY model ORDER BY total_cost DESC`).all(Number(req.params.id)));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Credit transactions (who granted / changed what) ──────────────────────
  router.get('/transactions', (req, res) => {
    try {
      const { where, args } = dateRange(req.query);
      if (req.query.user_id) { where.push('user_id = ?'); args.push(Number(req.query.user_id)); }
      const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));
      const page  = Math.max(1, Number(req.query.page) || 1);
      const total = db.prepare(`SELECT COUNT(*) n FROM ai_credit_transactions ${W}`).get(...args).n;
      const rows  = db.prepare(`SELECT * FROM ai_credit_transactions ${W} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
      res.json({ rows, total, page, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Model pricing ─────────────────────────────────────────────────────────
  const parsePricing = (b, partial) => {
    const out = {};
    if (b.model !== undefined) out.model = String(b.model).trim().slice(0, 120);
    if (b.display_name !== undefined) out.display_name = String(b.display_name).slice(0, 120);
    if (b.provider !== undefined) out.provider = String(b.provider).slice(0, 60);
    for (const k of ['input_per_1m', 'output_per_1m']) {
      if (b[k] === undefined) { if (!partial) throw new Error(`${k} is required`); continue; }
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} must be a non-negative number`);
      out[k] = n;
    }
    if (b.is_active !== undefined) out.is_active = !!b.is_active;
    if (!partial && !out.model) throw new Error('model is required');
    return out;
  };

  router.get('/models', (_req, res) => {
    try {
      const usage = Object.fromEntries(db.prepare(`SELECT priced_as, COUNT(*) calls, SUM(total_cost) cost FROM ai_usage_log GROUP BY priced_as`).all().map(r => [r.priced_as, r]));
      res.json(pricingRepo.list().map(p => ({ ...p, calls: usage[p.model]?.calls || 0, cost: usage[p.model]?.cost || 0 })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post('/models', (req, res) => {
    try { res.json(pricingRepo.create(parsePricing(req.body || {}, false))); }
    catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A price for that model already exists' : e.message }); }
  });
  router.put('/models/:id', (req, res) => {
    try {
      const row = pricingRepo.update(Number(req.params.id), parsePricing(req.body || {}, true));
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json(row);
    } catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'A price for that model already exists' : e.message }); }
  });
  router.delete('/models/:id', (req, res) => {
    const r = pricingRepo.delete(Number(req.params.id));
    if (!r.changes) return res.status(400).json({ error: 'Cannot delete the default (*) price' });
    res.json({ ok: true });
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  router.get('/settings', (_req, res) => res.json(creditSettings.get()));
  router.put('/settings', (req, res) => {
    try { res.json(creditSettings.save(req.body || {}, by(req))); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  return router;
}
