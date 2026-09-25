/**
 * Workflow Designer — AI Studio Phase 4.
 * A linear-chain step executor (Start → ... → End) with one branch point
 * (Condition). Node vocabulary follows SAP Build Process Automation; v1
 * supports Start, Form Step, Data Step (Local Table read/write only —
 * SAP data steps are a later phase), Condition, Approval, End.
 * Decision Table, Loop, Sub-process, AI Step and Notify are deferred.
 * Mounted at /api/workflows by chat-server.mjs.
 */
import { Router } from 'express';

const NODE_TYPES = ['start', 'form', 'data', 'condition', 'approval', 'end'];

// ── AI helper (identical pattern to custom-agents.mjs / local-tables.mjs) ────
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
    console.error('[Workflows] AI error:', e.message);
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

const GEN_SYSTEM = `You design simple business processes (workflows) for a web app called AgentSphere, following SAP Build Process Automation's vocabulary but limited to these node types:
- "start": entry point (exactly one, no config)
- "form": a step where a user fills in data and submits (config: { fields:[{key,label,type:text|number|date}] })
- "approval": a step where an assigned person approves or rejects (config: { assignTo: "role or username", instructions })
- "condition": a two-way branch (config: { field, operator: one of ==|!=|>|<|>=|<=, value })
- "data": reads or writes to a Local Table (config: { operation: "create"|"list", tableHint: "short description of what table this needs" })
- "end": terminates the instance (config: { status: "completed"|"rejected" })

Given a requirement, output ONLY valid JSON (no markdown, no commentary) with this exact structure:
{
  "name": "short workflow name",
  "nodes": [ { "id": "n1", "type": "one of the types above", "label": "human label", "config": { ... per type above } } ],
  "edges": [ { "from": "n1", "to": "n2" }, { "from": "n3", "to": "n4", "branch": "true" }, { "from": "n3", "to": "n5", "branch": "false" } ]
}
Rules:
- Exactly one "start" node, at least one "end" node.
- A "condition" node MUST have exactly two outgoing edges, one with "branch":"true" and one with "branch":"false".
- Every other node has exactly one outgoing edge (no "branch" property).
- Keep the chain short and directly answering the requirement — do not invent extra approval layers unless asked.`;

function validateGraph(graph) {
  const warnings = [];
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const ids = new Set(nodes.map(n => n.id));
  const starts = nodes.filter(n => n.type === 'start');
  if (starts.length !== 1) warnings.push(`A workflow must have exactly one "start" node (found ${starts.length}).`);
  if (!nodes.some(n => n.type === 'end')) warnings.push('A workflow must have at least one "end" node.');
  nodes.forEach(n => {
    if (!NODE_TYPES.includes(n.type)) warnings.push(`Unknown node type "${n.type}" on node "${n.id}".`);
  });
  edges.forEach(e => {
    if (!ids.has(e.from) || !ids.has(e.to)) warnings.push(`Edge references a node that doesn't exist (${e.from} → ${e.to}).`);
  });
  nodes.filter(n => n.type === 'condition').forEach(n => {
    const out = edges.filter(e => e.from === n.id);
    const hasTrue = out.some(e => e.branch === 'true');
    const hasFalse = out.some(e => e.branch === 'false');
    if (!hasTrue || !hasFalse) warnings.push(`Condition node "${n.id}" needs both a "true" and a "false" outgoing edge.`);
  });
  return { verified: warnings.length === 0, warnings };
}

function compare(a, op, b) {
  const na = Number(a), nb = Number(b);
  const bothNumeric = Number.isFinite(na) && Number.isFinite(nb);
  const x = bothNumeric ? na : String(a ?? '');
  const y = bothNumeric ? nb : String(b ?? '');
  switch (op) {
    case '==': return x == y;
    case '!=': return x != y;
    case '>':  return x > y;
    case '<':  return x < y;
    case '>=': return x >= y;
    case '<=': return x <= y;
    default: return false;
  }
}

export function createWorkflowsRouter(deps) {
  const { requireAuth, gptChatComplete, azureMessagesCreate, AI_PROVIDER, USE_AI,
          customAgentsRepo, workflowInstancesRepo, localTablesRepo } = deps;
  const aiDeps = { AI_PROVIDER, gptChatComplete, azureMessagesCreate, USE_AI };
  const router = Router();

  function findNode(graph, id) { return (graph.nodes || []).find(n => n.id === id); }
  function outEdges(graph, id) { return (graph.edges || []).filter(e => e.from === id); }

  function logStep(instance, node, extra = {}) {
    instance.history_json = [...(instance.history_json || []), {
      nodeId: node.id, type: node.type, label: node.label, at: new Date().toISOString(), ...extra,
    }];
  }

  // Runs the graph forward from the current node until it hits a wait-state
  // (form/approval) or an end node. Mutates and returns `instance` (not yet persisted).
  async function advanceInstance(graph, instance, input) {
    let node = findNode(graph, instance.current_node_id) || findNode(graph, graph.nodes.find(n => n.type === 'start')?.id);
    let guard = 0;
    while (node && guard++ < 200) {
      if (node.type === 'start') {
        logStep(instance, node);
        const next = outEdges(graph, node.id)[0];
        if (!next) return { instance, error: 'Start node has no outgoing edge.' };
        node = findNode(graph, next.to);
        continue;
      }
      if (node.type === 'form') {
        if (input?.formData && instance._consumedForm === node.id) {
          instance.variables_json = { ...instance.variables_json, ...input.formData };
          logStep(instance, node, { formData: input.formData });
          const next = outEdges(graph, node.id)[0];
          if (!next) return { instance, error: 'Form step has no outgoing edge.' };
          node = findNode(graph, next.to);
          continue;
        }
        instance.current_node_id = node.id;
        instance.status = 'running';
        return { instance, waiting: 'form', node };
      }
      if (node.type === 'approval') {
        if (input?.decision && instance._consumedApproval === node.id) {
          logStep(instance, node, { decision: input.decision, decidedBy: input.decidedBy, comment: input.comment });
          if (input.decision === 'reject') {
            instance.status = 'rejected';
            instance.current_node_id = node.id;
            return { instance, done: true };
          }
          const next = outEdges(graph, node.id)[0];
          if (!next) return { instance, error: 'Approval step has no outgoing edge.' };
          node = findNode(graph, next.to);
          continue;
        }
        instance.current_node_id = node.id;
        instance.status = 'running';
        return { instance, waiting: 'approval', node };
      }
      if (node.type === 'condition') {
        const cfg = node.config || {};
        const val = instance.variables_json?.[cfg.field];
        const result = compare(val, cfg.operator, cfg.value);
        logStep(instance, node, { evaluated: result, field: cfg.field, value: val });
        const branch = result ? 'true' : 'false';
        const next = outEdges(graph, node.id).find(e => e.branch === branch);
        if (!next) return { instance, error: `Condition node "${node.id}" has no "${branch}" edge.` };
        node = findNode(graph, next.to);
        continue;
      }
      if (node.type === 'data') {
        const cfg = node.config || {};
        try {
          if (cfg.tableKey && localTablesRepo) {
            const table = localTablesRepo.getByKey(cfg.tableKey);
            if (table) {
              if (cfg.operation === 'create') {
                const row = localTablesRepo.insertRow(table.id, instance.variables_json, instance.started_by);
                instance.variables_json = { ...instance.variables_json, _lastRowId: row.id };
              } else if (cfg.operation === 'list') {
                const rows = localTablesRepo.listRows(table.id, 20);
                instance.variables_json = { ...instance.variables_json, _rows: rows };
              }
            }
          }
          logStep(instance, node, { operation: cfg.operation, tableKey: cfg.tableKey });
        } catch (e) {
          logStep(instance, node, { error: e.message });
        }
        const next = outEdges(graph, node.id)[0];
        if (!next) return { instance, error: 'Data step has no outgoing edge.' };
        node = findNode(graph, next.to);
        continue;
      }
      if (node.type === 'end') {
        logStep(instance, node);
        instance.current_node_id = node.id;
        instance.status = (node.config?.status === 'rejected') ? 'rejected' : 'completed';
        return { instance, done: true };
      }
      return { instance, error: `Unknown node type "${node.type}".` };
    }
    return { instance, error: 'Workflow did not reach a stopping point (possible loop).' };
  }

  router.post('/generate', requireAuth, async (req, res) => {
    try {
      const { name, requirement, previousGraph } = req.body || {};
      if (!requirement) return res.status(400).json({ ok: false, error: 'requirement is required.' });
      const userContent = previousGraph
        ? `Workflow name: ${name || ''}\n\nCurrent graph (JSON):\n${JSON.stringify(previousGraph)}\n\nApply this additional instruction and output the FULL revised graph JSON:\n${requirement}`
        : `Workflow name: ${name || ''}\n\nRequirement:\n${requirement}`;
      const raw = await callAI(aiDeps, [{ role: 'user', content: userContent }], GEN_SYSTEM, 1200);
      if (!raw) return res.status(503).json({ ok: false, error: 'AI is not configured or did not respond.' });
      const graph = extractJson(raw);
      if (!graph || !Array.isArray(graph.nodes)) return res.status(502).json({ ok: false, error: 'AI returned an unexpected format. Please try again.' });
      const { verified, warnings } = validateGraph(graph);
      res.json({ ok: true, graph, verified, warnings });
    } catch (e) {
      console.error('[Workflows] generate error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, workflows: customAgentsRepo.list('active').filter(a => a.type === 'workflow') });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/', requireAuth, (req, res) => {
    try {
      const { name, icon, color, menuSection, menuGroup, requirement, graph } = req.body || {};
      if (!name) return res.status(400).json({ ok: false, error: 'name is required.' });
      if (!graph || !Array.isArray(graph.nodes)) return res.status(400).json({ ok: false, error: 'graph is required.' });
      const agent = customAgentsRepo.insert({
        name, icon: icon || '🔀', color: color || '#7c3aed',
        menu_section: menuSection, menu_group: menuGroup, requirement,
        type: 'workflow', spec_json: graph,
        created_by: req.user?.username || req.user?.email || '',
      });
      res.json({ ok: true, workflow: agent });
    } catch (e) {
      console.error('[Workflows] create error:', e);
      res.status(500).json({ ok: false, error: e.message });
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

  router.post('/:key/start', requireAuth, async (req, res) => {
    try {
      const wf = customAgentsRepo.getByKey(req.params.key);
      if (!wf || wf.type !== 'workflow') return res.status(404).json({ ok: false, error: 'Workflow not found.' });
      let instance = workflowInstancesRepo.create(wf.id, wf.key, req.user?.username || req.user?.email || '');
      const { error, waiting, node, done } = await advanceInstance(wf.spec_json, instance, {});
      instance = workflowInstancesRepo.save(instance);
      if (error) return res.status(500).json({ ok: false, error, instance });
      res.json({ ok: true, instance, waiting: waiting || null, node: node || null, done: !!done });
    } catch (e) {
      console.error('[Workflows] start error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.get('/:key/instances', requireAuth, (req, res) => {
    try {
      res.json({ ok: true, instances: workflowInstancesRepo.listByWorkflow(req.params.key) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/:key/instances/:id/advance', requireAuth, async (req, res) => {
    try {
      const wf = customAgentsRepo.getByKey(req.params.key);
      if (!wf || wf.type !== 'workflow') return res.status(404).json({ ok: false, error: 'Workflow not found.' });
      let instance = workflowInstancesRepo.getById(Number(req.params.id));
      if (!instance || instance.workflow_key !== wf.key) return res.status(404).json({ ok: false, error: 'Instance not found.' });
      if (instance.status !== 'running') return res.status(400).json({ ok: false, error: `This instance already finished (${instance.status}).` });

      const node = findNode(wf.spec_json, instance.current_node_id);
      if (node?.type === 'approval') {
        const assignTo = node.config?.assignTo;
        const isAssigned = !assignTo || assignTo === req.user?.username || assignTo === req.user?.role;
        if (!isAssigned && req.user?.role !== 'admin') {
          return res.status(403).json({ ok: false, error: `Only ${assignTo || 'an admin'} can act on this approval.` });
        }
        instance._consumedApproval = node.id;
      } else if (node?.type === 'form') {
        instance._consumedForm = node.id;
      }

      const { error, waiting, node: nextNode, done } = await advanceInstance(wf.spec_json, instance, req.body || {});
      instance = workflowInstancesRepo.save(instance);
      if (error) return res.status(500).json({ ok: false, error, instance });
      res.json({ ok: true, instance, waiting: waiting || null, node: nextNode || null, done: !!done });
    } catch (e) {
      console.error('[Workflows] advance error:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post('/:key/instances/:id/cancel', requireAuth, (req, res) => {
    try {
      if (req.user?.role !== 'admin') return res.status(403).json({ ok: false, error: 'Only an admin can cancel a running instance.' });
      let instance = workflowInstancesRepo.getById(Number(req.params.id));
      if (!instance) return res.status(404).json({ ok: false, error: 'Instance not found.' });
      instance.status = 'cancelled';
      instance = workflowInstancesRepo.save(instance);
      res.json({ ok: true, instance });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}
