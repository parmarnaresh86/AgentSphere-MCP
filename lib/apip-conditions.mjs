/**
 * apip-conditions.mjs — approval rules for AP Invoice Processing templates and stages.
 *
 * A condition set is { match: 'all' | 'any', rules: [{ field, op, value }] } and is evaluated against
 * "facts" built from the invoice (see invoiceFacts in controllers/ap-invoice-processing-agent.mjs).
 * An empty rule list always matches.
 *
 * Field kinds and operators:
 *   number : gt gte lt lte eq between        value: number | [from, to]
 *   list   : in nin                          value: [{ code, name }]      (one value per invoice)
 *   lines  : any all none                    value: [{ code, name }]      (one value per invoice line)
 *   bool   : is                              value: true | false
 */

export const FIELDS = [
  { key: 'total',        label: 'Document total',            kind: 'number' },
  { key: 'subtotal',     label: 'Total before tax',          kind: 'number' },
  { key: 'tax',          label: 'Tax amount',                kind: 'number' },
  { key: 'maxLine',      label: 'Largest line amount',       kind: 'number' },
  { key: 'deviationPct', label: 'Deviation from bill total %', kind: 'number' },
  { key: 'vendor',       label: 'Vendor',                    kind: 'list',  source: 'vendors' },
  { key: 'vendorGroup',  label: 'Vendor group',              kind: 'list',  source: 'vendorGroups' },
  { key: 'currency',     label: 'Currency',                  kind: 'list',  source: 'currencies' },
  { key: 'docType',      label: 'Invoice type',              kind: 'list',  source: 'docTypes' },
  { key: 'itemGroup',    label: 'Item group',                kind: 'lines', source: 'itemGroups' },
  { key: 'itemCode',     label: 'Item',                      kind: 'lines', source: 'items' },
  { key: 'glAccount',    label: 'G/L account',               kind: 'lines', source: 'glAccounts' },
  { key: 'warehouse',    label: 'Warehouse',                 kind: 'lines', source: 'warehouses' },
  { key: 'hasBase',      label: 'Linked to PO / GRPO',       kind: 'bool' },
];
export const OPS = {
  number: [['gt', 'is more than'], ['gte', 'is at least'], ['lt', 'is less than'], ['lte', 'is at most'], ['eq', 'equals'], ['between', 'is between']],
  list:   [['in', 'is any of'], ['nin', 'is none of']],
  lines:  [['any', 'any line is'], ['all', 'every line is'], ['none', 'no line is']],
  bool:   [['is', 'is']],
};
const OP_LABEL = Object.fromEntries(Object.values(OPS).flat());

const num = v => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const codeList = v => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map(x => (x && typeof x === 'object' ? { code: String(x.code ?? '').trim(), name: String(x.name ?? '').trim() } : { code: String(x).trim(), name: '' }))
  .filter(x => x.code);

/**
 * Condition helpers bound to one field list. AP Invoice Processing uses FIELDS (the plain exports below);
 * other modules (e.g. employee expense claims) pass their own field list.
 */
export function createConditionSet(fields) {
const FIELD = Object.fromEntries(fields.map(f => [f.key, f]));

/** Clean one condition set; rules that cannot be evaluated are dropped. */
function normalizeConditions(c) {
  const rules = (Array.isArray(c?.rules) ? c.rules : []).map(r => {
    const f = FIELD[r?.field];
    if (!f) return null;
    const op = OPS[f.kind].some(([k]) => k === r.op) ? r.op : OPS[f.kind][0][0];
    let value;
    if (f.kind === 'number') {
      value = op === 'between' ? (Array.isArray(r.value) ? r.value : [r.value, r.value2]).map(num) : num(Array.isArray(r.value) ? r.value[0] : r.value);
      if (op === 'between' ? value.some(v => v == null) : value == null) return null;
      if (op === 'between' && value[0] > value[1]) value = [value[1], value[0]];
    } else if (f.kind === 'bool') {
      value = r.value === true || r.value === 'true' || r.value === 1 || r.value === '1';
    } else {
      value = codeList(r.value);
      if (!value.length) return null;
    }
    return { field: f.key, op, value };
  }).filter(Boolean);
  return { match: c?.match === 'any' ? 'any' : 'all', rules };
}

/** Problems that should block saving (incomplete rules the user is still editing). */
function conditionProblems(c, where = 'Condition') {
  return (Array.isArray(c?.rules) ? c.rules : []).map((r, i) => {
    const f = FIELD[r?.field];
    if (!f) return `${where} ${i + 1}: choose a field.`;
    if (f.kind === 'number') {
      const v = r.op === 'between' ? (Array.isArray(r.value) ? r.value : [r.value, r.value2]) : [Array.isArray(r.value) ? r.value[0] : r.value];
      if (v.some(x => num(x) == null || x === '' || x == null)) return `${where} ${i + 1} (${f.label}): enter ${r.op === 'between' ? 'both amounts' : 'an amount'}.`;
    } else if (f.kind !== 'bool' && !codeList(r.value).length) return `${where} ${i + 1} (${f.label}): pick at least one value.`;
    return null;
  }).filter(Boolean);
}

const fmtN = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const names = v => v.map(x => x.name ? `${x.code} ${x.name}`.trim() : x.code).join(', ');
/** "Document total is more than 1,00,000" */
function describeRule(r) {
  const f = FIELD[r.field];
  if (!f) return '';
  if (f.kind === 'number') return `${f.label} ${OP_LABEL[r.op]} ${r.op === 'between' ? `${fmtN(r.value[0])} and ${fmtN(r.value[1])}` : fmtN(r.value)}`;
  if (f.kind === 'bool') return `${f.label}: ${r.value ? 'yes' : 'no'}`;
  if (f.kind === 'lines') {
    const lbl = /^[A-Z][A-Z/]/.test(f.label) ? f.label : f.label[0].toLowerCase() + f.label.slice(1);   // keep "G/L account"
    return `${OP_LABEL[r.op].replace('line', `line's ${lbl}`)} ${names(r.value)}`;
  }
  return `${f.label} ${OP_LABEL[r.op]} ${names(r.value)}`;
}
const describeConditions = c => {
  const n = normalizeConditions(c);
  return n.rules.length ? n.rules.map(describeRule).join(n.match === 'any' ? ' OR ' : ' AND ') : '';
};

function evalRule(r, facts) {
  const f = FIELD[r.field];
  const v = facts[r.field];
  if (f.kind === 'number') {
    if (v == null || !Number.isFinite(Number(v))) return false;
    const x = Number(v);
    switch (r.op) {
      case 'gt': return x > r.value;
      case 'gte': return x >= r.value;
      case 'lt': return x < r.value;
      case 'lte': return x <= r.value;
      case 'eq': return Math.abs(x - r.value) < 0.005;
      case 'between': return x >= r.value[0] && x <= r.value[1];
    }
    return false;
  }
  if (f.kind === 'bool') return !!v === r.value;
  const want = new Set(r.value.map(x => String(x.code).toLowerCase()));
  if (f.kind === 'list') {
    if (v == null || v === '') return r.op === 'nin';
    const hit = want.has(String(v).toLowerCase());
    return r.op === 'in' ? hit : !hit;
  }
  const vals = (Array.isArray(v) ? v : []).map(x => String(x ?? '').toLowerCase());
  if (r.op === 'none') return !vals.some(x => want.has(x));
  if (!vals.length) return false;
  return r.op === 'all' ? vals.every(x => want.has(x)) : vals.some(x => want.has(x));
}

/** → { ok, reasons: [rules that matched], failed: [rules that did not] } */
function evalConditions(c, facts) {
  const n = normalizeConditions(c);
  if (!n.rules.length) return { ok: true, reasons: [], failed: [] };
  const res = n.rules.map(r => ({ r, hit: evalRule(r, facts) }));
  const reasons = res.filter(x => x.hit).map(x => describeRule(x.r));
  const failed = res.filter(x => !x.hit).map(x => describeRule(x.r));
  return { ok: n.match === 'any' ? reasons.length > 0 : failed.length === 0, reasons, failed };
}

return { FIELDS: fields, OPS, normalizeConditions, conditionProblems, describeRule, describeConditions, evalConditions };
}

// AP Invoice Processing condition set (unchanged public API)
const APIP_SET = createConditionSet(FIELDS);
export const { normalizeConditions, conditionProblems, describeRule, describeConditions, evalConditions } = APIP_SET;
