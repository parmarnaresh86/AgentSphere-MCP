/**
 * Custom Agent Builder
 * Lets an admin describe a new agent in plain language; AI generates a
 * persona spec (icon, system prompt, greeting, quick replies) which is
 * stored and then run by a generic chat runtime — no code execution,
 * no server restart. Mounted at /api/custom-agents by chat-server.mjs.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { extractPdfText, runVisionExtraction } from '../lib/ocr-extract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _sessions = new Map();
const _upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── SAP B1 schema registry (static reference data — entities, header/line fields) ──
let _sapSchema = null;
function loadSapSchema() {
  if (_sapSchema) return _sapSchema;
  try {
    _sapSchema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'sap-schema.json'), 'utf8'));
  } catch (e) {
    console.error('[Custom-Agents] Could not load data/sap-schema.json:', e.message);
    _sapSchema = { entities: {}, commonDocumentHeader: { fields: {} }, commonDocumentLine: { fields: {} } };
  }
  return _sapSchema;
}

// Read-only OData lookups the transaction-screen builder is allowed to query live
const LOOKUP_ENTITIES = {
  BusinessPartners: { select: 'CardCode,CardName,CardType,Currency', display: 'CardName', value: 'CardCode' },
  Items:            { select: 'ItemCode,ItemName,SalesUnit,PurchaseUnit', display: 'ItemName', value: 'ItemCode' },
  Warehouses:       { select: 'WarehouseCode,WarehouseName', display: 'WarehouseName', value: 'WarehouseCode' },
  SalesPersons:     { select: 'SalesEmployeeCode,SalesEmployeeName', display: 'SalesEmployeeName', value: 'SalesEmployeeCode' },
  ItemGroups:       { select: 'Number,GroupName', display: 'GroupName', value: 'Number' },
};

// ── AI helper (identical pattern to pr-agent.mjs / forecasting.mjs) ──────────
async function callAI(aiDeps, messages, system, maxTokens = 900) {
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
    console.error('[Custom-Agents] AI error:', e.message);
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

const GEN_SYSTEM = `You design conversational assistant personas for a SAP Business One web app called AgentSphere.
Given a short name and a plain-language requirement from an admin, output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "icon": "single emoji that fits the agent's purpose",
  "color": "#RRGGBB hex color that fits the purpose",
  "systemPrompt": "a detailed system prompt (150-400 words) instructing an AI assistant how to behave as this agent — its persona, what it helps with, what questions it should ask the user, how it should structure replies (use markdown), and any constraints. It must NOT claim to call external tools or post to SAP directly — it can only converse, explain, and produce structured text/markdown output (tables, checklists, summaries) for the user to act on.",
  "greeting": "a short first message (1-3 sentences, markdown ok) the agent shows when a user opens it",
  "quickReplies": ["2 to 5 short suggested replies/prompts the user could tap to get started"]
}
Keep the systemPrompt focused strictly on the stated requirement. Do not invent SAP data access the app doesn't already describe.`;

const TXN_FIELD_TYPES = ['text', 'number', 'date', 'lookup', 'select', 'computed'];

function buildTxnGenSystem(fromImage = false) {
  const schema = loadSapSchema();
  const entityList = Object.keys(schema.entities || {}).join(', ');
  const headerFields = Object.keys(schema.commonDocumentHeader?.fields || {}).join(', ');
  const lineFields = Object.keys(schema.commonDocumentLine?.fields || {}).join(', ');
  const lookupList = Object.keys(LOOKUP_ENTITIES).join(', ');
  const inputDesc = fromImage
    ? `You are given an image (a screenshot, mockup, or photo) or a PDF of an existing form/screen, plus an optional short note from the admin. Study its layout: which fields appear above the line-items table (header), which columns the table has (matrix), and any totals shown below it (footer). Infer field purposes from their labels/position even if the image is a different SAP flavor (e.g. SAP GUI, S/4HANA Fiori, Excel, a paper form) — map each one to the closest real SAP Business One field.`
    : `Given a short name and a plain-language requirement`;
  return `You design SAP Business One transaction-entry screens (header / line-items matrix / footer) for a web app called AgentSphere, styled like SAP Fiori / SAP S/4HANA.

${inputDesc}, output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "sapEntity": "one of: ${entityList}",
  "postPath": "the OData path for creating this document, e.g. /Orders",
  "linesField": "the header property name holding the line-items array, normally DocumentLines",
  "title": "screen title, e.g. Sales Order",
  "header": [ { "key": "SAP field name", "label": "human label", "type": "one of ${TXN_FIELD_TYPES.join('|')}", "lookupEntity": "one of ${lookupList} (only if type is lookup)", "required": true|false, "defaultValue": "optional pre-filled value, e.g. 'today' for a date field defaulting to today, or a literal default — omit if none" } ],
  "matrixColumns": [ { "key": "SAP line field name", "label": "human label", "type": "one of ${TXN_FIELD_TYPES.join('|')}", "lookupEntity": "...(only if lookup)", "formula": "e.g. Quantity*Price (only if type is computed)", "defaultValue": "optional default for new rows — omit if none" } ],
  "footer": [ { "key": "SAP header field name for a total, e.g. DocTotal", "label": "human label", "type": "computed", "formula": "sum(matrix.LineTotal) or similar" } ]
}

Rules:
- "key" for header fields MUST come from these known SAP B1 header fields where possible: ${headerFields}.
- "key" for matrix columns MUST come from these known SAP B1 line fields where possible: ${lineFields}.
- Only use "type":"lookup" with a "lookupEntity" from: ${lookupList}.
- Always include a CardCode-style header lookup for the business partner, a DocDate date field, at least 3 matrix columns (item lookup, quantity, price), and at least one computed footer total.
- If revising an existing spec (a "Current spec" is provided), preserve every field's existing properties — including "lookupSource", "lookupApiKey", "lookupSearchParam", "lookupValueField", "lookupDisplayField" if present — unless the admin's instruction specifically asks to change that field. Never drop these properties just because you're re-emitting the JSON.
- Keep it focused strictly on the stated requirement and standard SAP B1 document structure — do not invent fields that don't exist in SAP B1.`;
}

function validateTxnSpec(spec) {
  const schema = loadSapSchema();
  const warnings = [];
  const knownEntities = new Set(Object.keys(schema.entities || {}));
  const knownHeaderFields = new Set(Object.keys(schema.commonDocumentHeader?.fields || {}));
  const knownLineFields = new Set(Object.keys(schema.commonDocumentLine?.fields || {}));

  if (!spec.sapEntity || !knownEntities.has(spec.sapEntity)) {
    warnings.push(`Unknown SAP entity "${spec.sapEntity}" — not found in the schema registry. Posting will likely fail until this is corrected.`);
  }
  (spec.header || []).forEach(f => {
    if (!knownHeaderFields.has(f.key)) warnings.push(`Header field "${f.key}" is not a recognised SAP B1 document header field.`);
    if (f.type === 'lookup' && f.lookupSource !== 'customApi' && !LOOKUP_ENTITIES[f.lookupEntity]) warnings.push(`Header field "${f.key}" has an unsupported lookupEntity "${f.lookupEntity}".`);
    if (f.type === 'lookup' && f.lookupSource === 'customApi' && (!f.lookupApiKey || !f.lookupValueField)) warnings.push(`Header field "${f.key}" is mapped to a custom API but is missing the API key or value field.`);
  });
  (spec.matrixColumns || []).forEach(f => {
    if (f.type !== 'computed' && !knownLineFields.has(f.key)) warnings.push(`Matrix column "${f.key}" is not a recognised SAP B1 line field.`);
    if (f.type === 'lookup' && f.lookupSource !== 'customApi' && !LOOKUP_ENTITIES[f.lookupEntity]) warnings.push(`Matrix column "${f.key}" has an unsupported lookupEntity "${f.lookupEntity}".`);
    if (f.type === 'lookup' && f.lookupSource === 'customApi' && (!f.lookupApiKey || !f.lookupValueField)) warnings.push(`Matrix column "${f.key}" is mapped to a custom API but is missing the API key or value field.`);
  });
  return { verified: warnings.length === 0, warnings };
}

const UDT_FIELD_TYPES = ['db_Alpha', 'db_Numeric', 'db_Float', 'db_Date', 'db_Memo'];
const UDT_TABLE_TYPES = ['bott_NoObject', 'bott_MasterData', 'bott_MasterDataLines', 'bott_Document', 'bott_DocumentLines'];

function buildTablesGenSystem() {
  return `You design SAP Business One User-Defined Tables (UDTs) for a web app called AgentSphere.

Given a requirement (optionally with the JSON spec of an existing transaction screen it needs to support), output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "tables": [
    {
      "name": "TABLENAME (max 15 chars, letters/digits/underscore, will be uppercased, stored in SAP as @TABLENAME)",
      "description": "human description",
      "type": "one of ${UDT_TABLE_TYPES.join('|')}",
      "role": "header" or "lines" (use \"lines\" only for a child table holding repeating rows for a header table),
      "parentTable": "the \"name\" of the header table (ONLY set this on a table with role \"lines\")",
      "linkField": "field name on the lines table that stores the parent's key, e.g. U_ParentCode (ONLY set this on a table with role \"lines\")",
      "fields": [
        { "fieldName": "FIELDNAME (max 8 chars, will be uppercased, stored as U_FIELDNAME)", "description": "human description", "fieldType": "one of ${UDT_FIELD_TYPES.join('|')}", "size": 50 }
      ],
      "mapsToFormField": "if this field corresponds to a header/matrix field key from the given transaction spec, name it here (per-field, optional)"
    }
  ]
}

Rules:
- Output ONE table unless the requirement clearly needs a parent + repeating child rows (e.g. a custom header + custom line items) — then output exactly two tables: one "header" and one "lines" with parentTable/linkField set on the lines table.
- Keep field names short, meaningful, and unique per table.
- "size" only applies to db_Alpha fields (1-254); omit for other types.
- Do not invent a third table unless explicitly asked for more than one child relationship.`;
}

function validateTablesPlan(plan) {
  const warnings = [];
  const names = new Set();
  (plan.tables || []).forEach(t => {
    const name = String(t.name || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    if (!name || name.length > 15) warnings.push(`Table name "${t.name}" must be 1-15 alphanumeric characters.`);
    if (names.has(name)) warnings.push(`Duplicate table name "${name}".`);
    names.add(name);
    if (!UDT_TABLE_TYPES.includes(t.type)) warnings.push(`Table "${t.name}" has an unrecognised type "${t.type}".`);
    if (t.role === 'lines' && !t.parentTable) warnings.push(`Table "${t.name}" is a lines table but has no parentTable.`);
    if (t.role === 'lines' && t.parentTable && !(plan.tables || []).some(x => (x.name || '').toUpperCase() === String(t.parentTable).toUpperCase())) {
      warnings.push(`Table "${t.name}"'s parentTable "${t.parentTable}" was not found among the generated tables.`);
    }
    (t.fields || []).forEach(f => {
      const fname = String(f.fieldName || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
      if (!fname || fname.length > 8) warnings.push(`Field "${f.fieldName}" in table "${t.name}" must be 1-8 alphanumeric characters.`);
      if (!UDT_FIELD_TYPES.includes(f.fieldType)) warnings.push(`Field "${f.fieldName}" in table "${t.name}" has an unrecognised fieldType "${f.fieldType}".`);
    });
  });
  return { verified: warnings.length === 0, warnings };
}

async function createUdtTable(getActiveSap, t) {
  const name = String(t.name || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!name || name.length > 15) throw new Error(`Invalid table name "${t.name}"`);
  const sap = getActiveSap();
  await sap.post('/UserTablesMD', {
    TableName: name,
    TableDescription: t.description || name,
    TableType: t.type || 'bott_NoObject',
  });
  const createdFields = [];
  for (const f of (t.fields || [])) {
    const fname = String(f.fieldName || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').substring(0, 8);
    if (!fname) continue;
    const payload = {
      TableName: name,
      FieldName: fname,
      Description: f.description || fname,
      FieldType: f.fieldType || 'db_Alpha',
      ...(!f.fieldType || f.fieldType === 'db_Alpha' ? { EditSize: Math.min(Math.max(parseInt(f.size) || 50, 1), 254) } : {}),
    };
    await sap.post('/UserFieldsMD', payload);
    createdFields.push(fname);
  }
  return { name, fieldCount: createdFields.length, fields: createdFields };
}

// ── API Creation (saved named query → stable read-only endpoint) ────────────
const API_PARAM_TYPES = ['string', 'number', 'date'];

function buildApiGenSystem(sqlSchemaText, sapEntities) {
  return `You design read-only data APIs for a SAP Business One web app called AgentSphere.

Given a requirement, choose the best data source and output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "sourceType": "sql" or "servicelayer",
  "description": "human description of what this API returns",
  "params": [ { "name": "camelCaseName", "type": "one of ${API_PARAM_TYPES.join('|')}", "required": true|false, "description": "..." } ],
  "sqlQuery": "a single read-only SELECT ... statement using SAP B1 table names, with :paramName placeholders for each param (ONLY if sourceType is sql)",
  "sapPath": "an OData path under one of: ${sapEntities} (ONLY if sourceType is servicelayer)",
  "sapParams": { "$select": "...", "$filter": "... eq '{{paramName}}' ...", "$top": 20 } (ONLY if sourceType is servicelayer; use {{paramName}} tokens for param substitution)
}

Rules:
- sqlQuery MUST start with SELECT and must be a single statement — never INSERT/UPDATE/DELETE/DROP/ALTER/EXEC or multiple statements.
- Prefer "sql" when the requirement needs joins, aggregation, or tables not exposed as Service Layer entities. Prefer "servicelayer" for simple single-entity lookups.
- Reference only real SAP B1 tables/fields. Here is the known schema:
${sqlSchemaText}
- Always declare every parameter the query/filter actually uses in "params".`;
}

function validateApiSpec(spec) {
  const warnings = [];
  if (spec.sourceType === 'sql') {
    const trimmed = String(spec.sqlQuery || '').trim();
    if (!/^SELECT\b/i.test(trimmed)) warnings.push('sqlQuery must start with SELECT.');
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|EXEC|MERGE)\b/i.test(trimmed)) warnings.push('sqlQuery contains a disallowed keyword — only a single read-only SELECT is permitted.');
    if (trimmed.includes(';') && trimmed.indexOf(';') < trimmed.length - 1) warnings.push('sqlQuery must be a single statement.');
  } else if (spec.sourceType === 'servicelayer') {
    const schema = loadSapSchema();
    const entity = String(spec.sapPath || '').replace(/^\//, '').split('(')[0];
    if (!Object.keys(schema.entities || {}).includes(entity)) warnings.push(`Unknown SAP entity "${entity}" in sapPath.`);
  } else {
    warnings.push('sourceType must be "sql" or "servicelayer".');
  }
  return { verified: warnings.length === 0, warnings };
}

function substituteSqlParams(sqlTemplate, paramDefs, values) {
  let sql = sqlTemplate;
  for (const p of paramDefs || []) {
    const re = new RegExp(`:${p.name}\\b`, 'g');
    if (!re.test(sql)) continue;
    const raw = values?.[p.name];
    if (raw === undefined || raw === null || String(raw) === '') {
      if (p.required) throw new Error(`Missing required parameter: ${p.name}`);
    }
    let literal = 'NULL';
    if (raw !== undefined && raw !== null && String(raw) !== '') {
      if (p.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`Parameter ${p.name} must be a number`);
        literal = String(n);
      } else if (p.type === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new Error(`Parameter ${p.name} must be YYYY-MM-DD`);
        literal = `'${raw}'`;
      } else {
        literal = `'${String(raw).replace(/'/g, "''")}'`;
      }
    }
    sql = sql.replace(new RegExp(`:${p.name}\\b`, 'g'), literal);
  }
  return sql;
}

function substituteODataParams(sapParams, paramDefs, values) {
  const out = {};
  for (const [k, v] of Object.entries(sapParams || {})) {
    out[k] = typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, name) => {
      const p = (paramDefs || []).find(pd => pd.name === name);
      const raw = values?.[name];
      if (raw === undefined || raw === null || String(raw) === '') {
        if (p?.required) throw new Error(`Missing required parameter: ${name}`);
        return '';
      }
      if (p?.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`Parameter ${name} must be a number`);
        return String(n);
      }
      return String(raw).replace(/'/g, "''");
    }) : v;
  }
  return out;
}

export function createCustomAgentsRouter(deps) {
  const { requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI, customAgentsRepo, getActiveSap,
          SAP_B1_SCHEMA, executeSQL, isConnected, schemaRepo, getActiveCompanyId, localTablesRepo } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  router.post('/generate', requireAuth, async (req, res) => {
    try {
      const { name, requirement } = req.body || {};
      if (!name || !requirement) return res.status(400).json({ ok: false, error: 'name and requirement are required.' });

      const raw = await callAI(aiDeps, [
        { role: 'user', content: `Agent name: ${name}\n\nRequirement:\n${requirement}` },
      ], GEN_SYSTEM, 900);

      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond. Set an AI provider (ANTHROPIC_API_KEY / Azure) to use Create Agent.' });

      const spec = extractJson(raw);
      if (!spec || !spec.systemPrompt) return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again.' });

      res.json({
        ok: true,
        spec: {
          icon: spec.icon || '🤖',
          color: /^#[0-9a-fA-F]{6}$/.test(spec.color || '') ? spec.color : '#0070F2',
          systemPrompt: String(spec.systemPrompt).slice(0, 4000),
          greeting: String(spec.greeting || `Hi! I'm your ${name} assistant. How can I help?`).slice(0, 600),
          quickReplies: Array.isArray(spec.quickReplies) ? spec.quickReplies.slice(0, 5).map(String) : [],
        },
      });
    } catch (e) {
      console.error('[Custom-Agents] generate error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/', requireAuth, (req, res) => {
    try {
      // Workflows share this table but have their own list/nav under /api/workflows — exclude them here.
      res.json({ ok: true, agents: customAgentsRepo.list('active').filter(a => a.type !== 'workflow') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/', requireAuth, (req, res) => {
    try {
      const { name, icon, color, menuSection, menuGroup, requirement, systemPrompt, greeting, quickReplies, type, spec } = req.body || {};
      const agentType = ['transaction', 'api'].includes(type) ? type : 'chat';
      if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
      if (agentType === 'chat' && !systemPrompt) return res.status(400).json({ ok: false, error: 'systemPrompt is required for a chat agent.' });
      if ((agentType === 'transaction' || agentType === 'api') && !spec) return res.status(400).json({ ok: false, error: `spec is required for a ${agentType} agent.` });
      const agent = customAgentsRepo.insert({
        name, icon, color,
        menu_section: menuSection, menu_group: menuGroup,
        requirement, system_prompt: systemPrompt, greeting,
        quick_replies: quickReplies,
        type: agentType, spec_json: spec || null,
        created_by: req.user?.username || req.user?.email || '',
      });
      res.json({ ok: true, agent });
    } catch (e) {
      console.error('[Custom-Agents] create error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.put('/:id', requireAuth, (req, res) => {
    try {
      const agent = customAgentsRepo.update(Number(req.params.id), {
        name: req.body?.name, icon: req.body?.icon, color: req.body?.color,
        menu_section: req.body?.menuSection, menu_group: req.body?.menuGroup,
        requirement: req.body?.requirement, system_prompt: req.body?.systemPrompt,
        greeting: req.body?.greeting, quick_replies: req.body?.quickReplies,
        status: req.body?.status,
        type: req.body?.type, spec_json: req.body?.spec,
      });
      if (!agent) return res.status(404).json({ ok: false, error: 'Not found' });
      res.json({ ok: true, agent });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Transaction Screen generation (previousSpec + requirement = refinement round) ──
  router.post('/generate-transaction', requireAuth, async (req, res) => {
    try {
      const { name, requirement, previousSpec } = req.body || {};
      if (!name || !requirement) return res.status(400).json({ ok: false, error: 'name and requirement are required.' });

      const userContent = previousSpec
        ? `Screen name: ${name}\n\nCurrent spec (JSON):\n${JSON.stringify(previousSpec)}\n\nApply this additional instruction and output the FULL revised spec JSON:\n${requirement}`
        : `Screen name: ${name}\n\nRequirement:\n${requirement}`;

      const raw = await callAI(aiDeps, [
        { role: 'user', content: userContent },
      ], buildTxnGenSystem(), 1400);

      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond.' });
      const spec = extractJson(raw);
      if (!spec || !Array.isArray(spec.header) || !Array.isArray(spec.matrixColumns)) {
        return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again or refine the requirement.' });
      }
      spec.title = spec.title || name;
      spec.linesField = spec.linesField || 'DocumentLines';
      spec.footer = Array.isArray(spec.footer) ? spec.footer : [];

      const { verified, warnings } = validateTxnSpec(spec);
      res.json({ ok: true, spec, verified, warnings });
    } catch (e) {
      console.error('[Custom-Agents] generate-transaction error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Transaction Screen generation from a pasted/attached design image or PDF ──
  router.post('/generate-transaction-from-image', requireAuth, _upload.single('file'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
      const name = req.body?.name || 'Transaction Screen';
      const note = req.body?.requirement || '';

      let extractedText = null;
      if (file.mimetype === 'application/pdf') extractedText = await extractPdfText(file.buffer);

      const system = buildTxnGenSystem(true) +
        (note ? `\n\nAdmin's note about this design: ${note}` : '') +
        `\n\nScreen name to use for "title" unless the image clearly shows a different one: ${name}`;

      const spec = await runVisionExtraction(file.buffer, file.mimetype, extractedText, aiDeps, system, null);
      if (!spec || !Array.isArray(spec.header) || !Array.isArray(spec.matrixColumns)) {
        return res.status(502).json({ ok: false, error: 'Could not read a transaction screen layout from this file. Try a clearer image/PDF or describe it in text instead.' });
      }
      spec.title = spec.title || name;
      spec.linesField = spec.linesField || 'DocumentLines';
      spec.footer = Array.isArray(spec.footer) ? spec.footer : [];

      const { verified, warnings } = validateTxnSpec(spec);
      res.json({ ok: true, spec, verified, warnings });
    } catch (e) {
      console.error('[Custom-Agents] generate-transaction-from-image error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Table Creation: propose one or more UDTs (+ mapping) for a requirement ──
  router.post('/generate-tables', requireAuth, async (req, res) => {
    try {
      const { name, requirement, transactionSpec, previousPlan } = req.body || {};
      if (!requirement) return res.status(400).json({ ok: false, error: 'requirement is required.' });

      let userContent = `Requirement:\n${requirement}`;
      if (transactionSpec) userContent += `\n\nThis must support the following transaction screen spec (JSON) — propose UDT field mappings for its header/matrix fields where relevant:\n${JSON.stringify(transactionSpec)}`;
      if (previousPlan) userContent = `Current table plan (JSON):\n${JSON.stringify(previousPlan)}\n\nApply this additional instruction and output the FULL revised plan JSON:\n${requirement}`;

      const raw = await callAI(aiDeps, [{ role: 'user', content: userContent }], buildTablesGenSystem(), 1400);
      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond.' });
      const plan = extractJson(raw);
      if (!plan || !Array.isArray(plan.tables) || !plan.tables.length) {
        return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again or refine the requirement.' });
      }
      const { verified, warnings } = validateTablesPlan(plan);
      res.json({ ok: true, plan, verified, warnings });
    } catch (e) {
      console.error('[Custom-Agents] generate-tables error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Table Creation: actually create the planned UDT(s) in SAP (admin only) ──
  router.post('/create-tables', requireAuth, async (req, res) => {
    try {
      if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin can create tables in SAP.' });
      if (!getActiveSap) return res.status(503).json({ ok: false, error: 'SAP connection is not available.' });
      const tables = Array.isArray(req.body?.tables) ? req.body.tables : [];
      if (!tables.length) return res.status(400).json({ ok: false, error: 'No tables to create.' });

      // Header tables first, then lines tables (so parentTable already exists)
      const ordered = [...tables].sort((a, b) => (a.role === 'lines' ? 1 : 0) - (b.role === 'lines' ? 1 : 0));
      const results = [];
      for (const t of ordered) {
        try {
          const r = await createUdtTable(getActiveSap, t);
          if (schemaRepo) {
            try {
              schemaRepo.create(getActiveCompanyId ? getActiveCompanyId() : '', 'table', r.name, `@${r.name}`,
                JSON.stringify({ type: t.type, role: t.role, parentTable: t.parentTable, linkField: t.linkField, fields: t.fields }),
                t.description || '');
            } catch (e) { console.error('[Custom-Agents] schema registry log failed:', e.message); }
          }
          results.push({ name: r.name, ok: true, fieldCount: r.fieldCount });
        } catch (e) {
          let msg = e.message || 'UDT creation failed';
          try { const inner = JSON.parse(msg.replace(/^SAP \d+: /, '')); msg = inner?.error?.message?.value || inner?.message || msg; } catch {}
          results.push({ name: t.name, ok: false, error: msg });
        }
      }
      res.json({ ok: results.every(r => r.ok), results });
    } catch (e) {
      console.error('[Custom-Agents] create-tables error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── API Creation: propose a saved named query (SQL or Service Layer) ───────
  router.post('/generate-api', requireAuth, async (req, res) => {
    try {
      const { name, requirement } = req.body || {};
      if (!name || !requirement) return res.status(400).json({ ok: false, error: 'name and requirement are required.' });
      const entities = Object.keys(loadSapSchema().entities || {}).join(', ');
      const raw = await callAI(aiDeps, [
        { role: 'user', content: `API name: ${name}\n\nRequirement:\n${requirement}` },
      ], buildApiGenSystem(SAP_B1_SCHEMA || '(no schema available)', entities), 1200);
      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond.' });
      const spec = extractJson(raw);
      if (!spec || !spec.sourceType) return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again.' });
      spec.params = Array.isArray(spec.params) ? spec.params : [];
      spec.description = spec.description || requirement;
      const { verified, warnings } = validateApiSpec(spec);
      res.json({ ok: true, spec, verified, warnings });
    } catch (e) {
      console.error('[Custom-Agents] generate-api error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Shared: execute an API spec with the given param values ────────────────
  async function runApiSpec(spec, values) {
    if (spec.sourceType === 'sql') {
      if (!executeSQL) throw new Error('SQL execution is not available.');
      if (isConnected && !isConnected()) throw new Error('No ODBC/DB connection is active. Connect one under Developer Tools → DB Connection.');
      const finalSql = substituteSqlParams(spec.sqlQuery, spec.params, values);
      const rows = await executeSQL(finalSql);
      return Array.isArray(rows) ? rows.slice(0, 200) : rows;
    }
    if (spec.sourceType === 'servicelayer') {
      if (!getActiveSap) throw new Error('SAP connection is not available.');
      const params = substituteODataParams(spec.sapParams, spec.params, values);
      const r = await getActiveSap().get(spec.sapPath, params);
      return r?.value || r;
    }
    throw new Error('Unknown API sourceType.');
  }

  function isParamValidationError(msg) {
    return /^Missing required parameter|must be a number|must be YYYY-MM-DD/.test(msg || '');
  }

  // Test an in-progress (not yet saved) API spec
  router.post('/test-api', requireAuth, async (req, res) => {
    try {
      const { spec, values } = req.body || {};
      if (!spec) return res.status(400).json({ ok: false, error: 'spec is required.' });
      const rows = await runApiSpec(spec, values || {});
      res.json({ ok: true, rows });
    } catch (e) {
      console.error('[Custom-Agents] test-api error:', e);
      const msg = e.response?.data?.error?.message?.value || e.message;
      res.status(isParamValidationError(msg) ? 400 : 500).json({ ok: false, error: msg });
    }
  });

  // Run a saved API by key — the actual stable endpoint (GET, query-string params)
  router.get('/:key/run', requireAuth, async (req, res) => {
    try {
      const agent = customAgentsRepo.getByKey(req.params.key);
      if (!agent || agent.type !== 'api') return res.status(404).json({ ok: false, error: 'API not found.' });
      const rows = await runApiSpec(agent.spec_json, req.query || {});
      res.json({ ok: true, rows });
    } catch (e) {
      console.error('[Custom-Agents] run API error:', e);
      const msg = e.response?.data?.error?.message?.value || e.message;
      res.status(isParamValidationError(msg) ? 400 : 500).json({ ok: false, error: msg });
    }
  });

  // ── Live read-only lookup for header/matrix "lookup" fields (autocomplete) ──
  router.get('/lookup/:entity', requireAuth, async (req, res) => {
    try {
      const cfg = LOOKUP_ENTITIES[req.params.entity];
      if (!cfg) return res.status(400).json({ ok: false, error: 'Unsupported lookup entity.' });
      if (!getActiveSap) return res.status(503).json({ ok: false, error: 'SAP connection is not available.' });
      const q = String(req.query.q || '').trim().replace(/'/g, "''");
      const sap = getActiveSap();
      const params = { $select: cfg.select, $top: 15 };
      if (q) params.$filter = `contains(${cfg.display},'${q}')`;
      const r = await sap.get(`/${req.params.entity}`, params);
      const rows = (r?.value || []).map(row => ({ value: row[cfg.value], label: row[cfg.display], raw: row }));
      res.json({ ok: true, rows });
    } catch (e) {
      console.error('[Custom-Agents] lookup error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Shared: build a post payload from spec + form data, optionally post it live ──
  async function runTxnTest(req, res, spec) {
    if (!spec) return res.status(400).json({ ok: false, error: 'No transaction spec supplied.' });
    const { header = {}, lines = [], live = false } = req.body || {};

    // ── Local Table–backed screen: no SAP involved, no admin gate — it's the app's own sandbox ──
    if (spec.dataSourceKind === 'localTable') {
      if (!localTablesRepo) return res.status(503).json({ ok: false, error: 'Local Tables are not available.' });
      const table = localTablesRepo.getByKey(spec.localTableKey);
      if (!table) return res.status(400).json({ ok: false, error: 'The Local Table this screen is bound to no longer exists.' });
      const missing = (spec.header || []).filter(f => f.required && !header[f.key]).map(f => f.key);
      if (missing.length) return res.status(400).json({ ok: false, error: `Missing required field(s): ${missing.join(', ')}` });
      if (!live) {
        return res.json({ ok: true, live: false, payload: header, message: 'Preview only — nothing was saved yet. Click "Save Row" to save it for real.' });
      }
      const row = localTablesRepo.insertRow(table.id, header, req.user?.username || req.user?.email || '');
      return res.json({ ok: true, live: true, payload: header, result: { id: row.id } });
    }

    const payload = { ...header };
    payload[spec.linesField || 'DocumentLines'] = lines.map(l => {
      const row = {};
      (spec.matrixColumns || []).forEach(c => { if (c.type !== 'computed' && l[c.key] !== undefined) row[c.key] = l[c.key]; });
      return row;
    });

    const missing = (spec.header || []).filter(f => f.required && !payload[f.key]).map(f => f.key);
    if (missing.length) return res.status(400).json({ ok: false, error: `Missing required field(s): ${missing.join(', ')}` });

    if (!live) {
      return res.json({ ok: true, live: false, payload, message: 'Dry-run only — nothing was sent to SAP. Toggle "Go Live" to post for real.' });
    }
    if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin can post live to SAP.' });
    if (!getActiveSap) return res.status(503).json({ ok: false, error: 'SAP connection is not available.' });

    const sap = getActiveSap();
    const result = await sap.post(spec.postPath || `/${spec.sapEntity}`, payload);
    res.json({ ok: true, live: true, payload, result: { DocEntry: result?.DocEntry, DocNum: result?.DocNum } });
  }

  // Test against an already-saved transaction agent
  router.post('/:key/test', requireAuth, async (req, res) => {
    try {
      const agent = customAgentsRepo.getByKey(req.params.key);
      if (!agent || agent.type !== 'transaction') return res.status(404).json({ ok: false, error: 'Transaction agent not found.' });
      await runTxnTest(req, res, agent.spec_json);
    } catch (e) {
      console.error('[Custom-Agents] test error:', e);
      res.status(500).json({ ok: false, error: e.response?.data?.error?.message?.value || e.message });
    }
  });

  // Test an in-progress (not yet saved) spec, straight from the builder preview
  router.post('/test-transaction', requireAuth, async (req, res) => {
    try {
      await runTxnTest(req, res, req.body?.spec);
    } catch (e) {
      console.error('[Custom-Agents] test-transaction error:', e);
      res.status(500).json({ ok: false, error: e.response?.data?.error?.message?.value || e.message });
    }
  });

  router.delete('/:id', requireAuth, (req, res) => {
    try {
      customAgentsRepo.remove(Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Generic runtime chat for any saved custom agent ─────────────────────────
  router.post('/:key/chat', requireAuth, async (req, res) => {
    try {
      const { key } = req.params;
      const { message = '', sessionId } = req.body || {};
      const agent = customAgentsRepo.getByKey(key);
      if (!agent) return res.status(404).json({ ok: false, error: 'Agent not found.' });

      const sid = sessionId || `${key}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (!_sessions.has(sid)) _sessions.set(sid, { history: [] });
      const session = _sessions.get(sid);

      const msg = String(message || '').trim();
      let reply;
      if (!msg && session.history.length === 0) {
        reply = agent.greeting || `Hi! I'm ${agent.name}. How can I help?`;
      } else {
        session.history.push({ role: 'user', content: msg });
        const raw = await callAI(aiDeps, session.history, agent.system_prompt, 900);
        reply = raw || "Sorry, I couldn't reach the AI provider just now. Please try again.";
        session.history.push({ role: 'assistant', content: reply });
        if (session.history.length > 40) session.history.splice(0, session.history.length - 40);
      }

      res.json({ ok: true, sessionId: sid, reply, quickReplies: session.history.length ? [] : (agent.quick_replies || []) });
    } catch (e) {
      console.error('[Custom-Agents] chat error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/:key/reset', requireAuth, (req, res) => {
    const { sessionId } = req.body || {};
    if (sessionId) _sessions.delete(sessionId);
    res.json({ ok: true });
  });

  return router;
}
