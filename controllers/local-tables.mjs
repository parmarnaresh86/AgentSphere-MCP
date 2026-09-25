/**
 * Local Tables — AI Studio Phase 1.
 * Business tables that live entirely in AgentSphere's own SQLite database —
 * no SAP UDT, no Service Layer call, nothing pushed live. Rows are stored as
 * JSON payloads (see db.mjs local_table_rows) rather than real dynamic SQL
 * columns, so a bad column definition can never break a query underneath it.
 * Mounted at /api/local-tables by chat-server.mjs.
 */
import { Router } from 'express';

const COLUMN_TYPES = ['text', 'number', 'decimal', 'date', 'boolean', 'select'];

// ── AI helper (identical pattern to custom-agents.mjs) ───────────────────────
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
    console.error('[Local-Tables] AI error:', e.message);
  }
  return null;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

const GEN_SYSTEM = `You design simple business-data tables for a web app called AgentSphere. These tables are NOT SAP objects — they live in the app's own database, so only use plain, sensible column names, never SAP field names.

Given a requirement, output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "columns": [
    { "name": "camelCaseName", "label": "Human Label", "type": "one of ${COLUMN_TYPES.join('|')}", "required": true|false, "options": ["Only for type select — the fixed choices"] }
  ]
}
Rules:
- Always include a short descriptive column set (5-10 columns) covering exactly what the requirement asks for — no more, no less.
- "type":"select" MUST include "options".
- Column names must be unique, camelCase, and never start with a digit.`;

function slugifyColumnName(name) {
  const s = String(name || '').trim().replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  if (!s) return '';
  const parts = s.split(' ');
  return parts.map((p, i) => i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

function sanitizeColumns(columns) {
  const seen = new Set();
  return (Array.isArray(columns) ? columns : []).map(c => {
    let name = slugifyColumnName(c.name || c.label);
    if (!name || seen.has(name)) name = `${name || 'field'}${seen.size}`;
    seen.add(name);
    return {
      name,
      label: String(c.label || c.name || name).slice(0, 60),
      type: COLUMN_TYPES.includes(c.type) ? c.type : 'text',
      required: !!c.required,
      options: c.type === 'select' && Array.isArray(c.options) ? c.options.map(String).slice(0, 30) : undefined,
    };
  }).filter(c => c.name);
}

function validateRowAgainstColumns(columns, data) {
  const errors = [];
  const clean = {};
  for (const col of columns) {
    let v = data?.[col.name];
    if (v === undefined || v === null || v === '') {
      if (col.required) errors.push(`"${col.label}" is required.`);
      continue;
    }
    if (col.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`"${col.label}" must be a number.`); continue; }
      v = n;
    } else if (col.type === 'decimal') {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`"${col.label}" must be a decimal number.`); continue; }
      v = n;
    } else if (col.type === 'boolean') {
      v = v === true || v === 'true' || v === 1 || v === '1';
    } else if (col.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) { errors.push(`"${col.label}" must be YYYY-MM-DD.`); continue; }
    } else if (col.type === 'select') {
      if (col.options && !col.options.includes(v)) { errors.push(`"${col.label}" must be one of: ${col.options.join(', ')}.`); continue; }
    } else {
      v = String(v);
    }
    clean[col.name] = v;
  }
  return { errors, clean };
}

export function createLocalTablesRouter(deps) {
  const { requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, localTablesRepo } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/generate', requireAuth, async (req, res) => {
    try {
      const { name, requirement } = req.body || {};
      if (!name || !requirement) return res.status(400).json({ ok: false, error: 'name and requirement are required.' });

      const raw = await callAI(aiDeps, [
        { role: 'user', content: `Table name: ${name}\n\nRequirement:\n${requirement}` },
      ], GEN_SYSTEM, 700);

      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond.' });
      const parsed = extractJson(raw);
      const columns = sanitizeColumns(parsed?.columns);
      if (!columns.length) return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again.' });

      res.json({ ok: true, columns });
    } catch (e) {
      console.error('[Local-Tables] generate error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, tables: localTablesRepo.list('active') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/', requireAuth, (req, res) => {
    try {
      const { name, icon, color, menuSection, menuGroup, requirement, columns } = req.body || {};
      if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
      const clean = sanitizeColumns(columns);
      if (!clean.length) return res.status(400).json({ ok: false, error: 'At least one column is required.' });
      const table = localTablesRepo.insert({
        name, icon, color, menu_section: menuSection, menu_group: menuGroup, requirement,
        columns: clean, created_by: req.user?.username || req.user?.email || '',
      });
      res.json({ ok: true, table });
    } catch (e) {
      console.error('[Local-Tables] create error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.put('/:id', requireAuth, (req, res) => {
    try {
      const fields = { ...req.body };
      if (fields.columns) fields.columns = sanitizeColumns(fields.columns);
      if (fields.menuSection !== undefined) { fields.menu_section = fields.menuSection; delete fields.menuSection; }
      if (fields.menuGroup !== undefined) { fields.menu_group = fields.menuGroup; delete fields.menuGroup; }
      const table = localTablesRepo.update(Number(req.params.id), fields);
      if (!table) return res.status(404).json({ ok: false, error: 'Not found' });
      res.json({ ok: true, table });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.delete('/:id', requireAuth, (req, res) => {
    try {
      localTablesRepo.remove(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/:key/schema', requireAuth, (req, res) => {
    try {
      const table = localTablesRepo.getByKey(req.params.key);
      if (!table) return res.status(404).json({ ok: false, error: 'Table not found.' });
      res.json({ ok: true, columns: table.columns_json });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Row CRUD ─────────────────────────────────────────────────────────────────
  router.get('/:key/rows', requireAuth, (req, res) => {
    try {
      const table = localTablesRepo.getByKey(req.params.key);
      if (!table) return res.status(404).json({ ok: false, error: 'Table not found.' });
      let rows = localTablesRepo.listRows(table.id);
      const q = String(req.query.q || '').trim().toLowerCase();
      if (q) {
        rows = rows.filter(r => table.columns_json.some(c => String(r[c.name] ?? '').toLowerCase().includes(q)));
      }
      res.json({ ok: true, rows, columns: table.columns_json });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/:key/rows', requireAuth, (req, res) => {
    try {
      const table = localTablesRepo.getByKey(req.params.key);
      if (!table) return res.status(404).json({ ok: false, error: 'Table not found.' });
      const { errors, clean } = validateRowAgainstColumns(table.columns_json, req.body || {});
      if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
      const row = localTablesRepo.insertRow(table.id, clean, req.user?.username || req.user?.email || '');
      res.json({ ok: true, row });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.put('/:key/rows/:id', requireAuth, (req, res) => {
    try {
      const table = localTablesRepo.getByKey(req.params.key);
      if (!table) return res.status(404).json({ ok: false, error: 'Table not found.' });
      const { errors, clean } = validateRowAgainstColumns(table.columns_json, req.body || {});
      if (errors.length) return res.status(400).json({ ok: false, error: errors.join(' ') });
      const row = localTablesRepo.updateRow(table.id, Number(req.params.id), clean);
      if (!row) return res.status(404).json({ ok: false, error: 'Row not found.' });
      res.json({ ok: true, row });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.delete('/:key/rows/:id', requireAuth, (req, res) => {
    try {
      const table = localTablesRepo.getByKey(req.params.key);
      if (!table) return res.status(404).json({ ok: false, error: 'Table not found.' });
      localTablesRepo.removeRow(table.id, Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
