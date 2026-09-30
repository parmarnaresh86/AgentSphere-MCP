/**
 * ai-credits.mjs — per-user AI credit allowance, model-wise token pricing,
 * and a usage/credit history ledger.
 *
 * How metering works: AI calls in this codebase go out through ~25 different
 * call sites (chat loop, every controller's callAI(), OCR, analytics) using
 * three transports — the Anthropic SDK (global fetch), raw fetch, and axios.
 * Rather than touching every call site, installAiUsageMeter() wraps
 * globalThis.fetch and adds axios interceptors once at startup. Any request to
 * an LLM endpoint (/v1/messages, /chat/completions, AZURE_GPT_ENDPOINT) is:
 *   1. checked BEFORE it is sent — a user with no remaining credit is refused
 *   2. metered AFTER it returns — token usage from the response is priced with
 *      the matching model rate and deducted from the user's credit.
 *
 * The calling user is resolved via a resolver injected by chat-server.mjs
 * (it reads the request's AsyncLocalStorage context). Calls made outside a
 * request (schedulers, mail polling) are logged as "system" and never blocked.
 *
 * Credits are denominated in USD. Prices are per 1M tokens.
 */
import axios from "axios";
import { db } from "../db.mjs";

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_credit_settings (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    enforce               INTEGER NOT NULL DEFAULT 1,
    default_allowance_usd REAL    NOT NULL DEFAULT 10,
    low_balance_pct       REAL    NOT NULL DEFAULT 20,
    updated_by            TEXT    DEFAULT '',
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_model_pricing (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    model         TEXT    UNIQUE NOT NULL,
    display_name  TEXT    DEFAULT '',
    provider      TEXT    DEFAULT '',
    input_per_1m  REAL    NOT NULL DEFAULT 0,
    output_per_1m REAL    NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_user_credits (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    allowed_usd REAL    NOT NULL DEFAULT 0,
    used_usd    REAL    NOT NULL DEFAULT 0,
    unlimited   INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS ai_credit_transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username      TEXT    DEFAULT '',
    type          TEXT    NOT NULL,
    amount_usd    REAL    NOT NULL DEFAULT 0,
    allowed_after REAL    NOT NULL DEFAULT 0,
    used_after    REAL    NOT NULL DEFAULT 0,
    note          TEXT    DEFAULT '',
    performed_by  TEXT    DEFAULT '',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ai_tx_user ON ai_credit_transactions(user_id, created_at);

  CREATE TABLE IF NOT EXISTS ai_usage_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username       TEXT    DEFAULT '',
    model          TEXT    DEFAULT '',
    priced_as      TEXT    DEFAULT '',
    provider       TEXT    DEFAULT '',
    feature        TEXT    DEFAULT '',
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    input_rate     REAL    NOT NULL DEFAULT 0,
    output_rate    REAL    NOT NULL DEFAULT 0,
    input_cost     REAL    NOT NULL DEFAULT 0,
    output_cost    REAL    NOT NULL DEFAULT 0,
    total_cost     REAL    NOT NULL DEFAULT 0,
    balance_after  REAL,
    estimated      INTEGER NOT NULL DEFAULT 0,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_usage_user    ON ai_usage_log(user_id, created_at);
`);

// One row per user prompt (a chat message, an agent request). A single prompt
// can make several AI calls — the chat agent loop calls the model again after
// every tool round — so ai_usage_log rows link back here via prompt_id and
// the totals below are the prompt's full cost across all models it used.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username      TEXT    DEFAULT '',
    prompt        TEXT    DEFAULT '',
    feature       TEXT    DEFAULT '',
    session_id    TEXT    DEFAULT '',
    calls         INTEGER NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cost    REAL    NOT NULL DEFAULT 0,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_ai_prompts_created ON ai_prompts(created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_prompts_user    ON ai_prompts(user_id, created_at);
`);
try { db.exec(`ALTER TABLE ai_usage_log ADD COLUMN prompt_id INTEGER REFERENCES ai_prompts(id) ON DELETE SET NULL`); } catch {}
db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_usage_prompt ON ai_usage_log(prompt_id)`);

db.prepare(`INSERT OR IGNORE INTO ai_credit_settings(id) VALUES (1)`).run();

// Seed rates for the models this app actually calls, at a flat $2 input /
// $4 output per 1M tokens. These are placeholders — set each model's real
// provider rate in Admin → AI Credits → Model Pricing. "*" is the fallback
// for any model with no row of its own.
{
  const seed = db.prepare(`INSERT OR IGNORE INTO ai_model_pricing(model,display_name,provider,input_per_1m,output_per_1m) VALUES(?,?,?,?,?)`);
  seed.run("*",                          "Default (any other model)", "any",       2, 4);
  seed.run("claude-sonnet-4-6",          "Claude Sonnet 4.6",         "anthropic", 2, 4);
  seed.run("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet (Azure)", "azure",     2, 4);
  seed.run("gpt-4o",                     "GPT-4o (Azure)",            "azure-gpt", 2, 4);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

export const creditSettings = {
  get() { return db.prepare(`SELECT * FROM ai_credit_settings WHERE id=1`).get(); },
  save({ enforce, default_allowance_usd, low_balance_pct }, by = "") {
    const cur = this.get();
    db.prepare(`UPDATE ai_credit_settings SET enforce=?, default_allowance_usd=?, low_balance_pct=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`)
      .run(enforce === undefined ? cur.enforce : (enforce ? 1 : 0),
           default_allowance_usd === undefined ? cur.default_allowance_usd : Math.max(0, Number(default_allowance_usd) || 0),
           low_balance_pct === undefined ? cur.low_balance_pct : Math.min(100, Math.max(0, Number(low_balance_pct) || 0)),
           by);
    return this.get();
  },
};

export const pricingRepo = {
  list() { return db.prepare(`SELECT * FROM ai_model_pricing ORDER BY (model='*'), model`).all(); },
  get(id) { return db.prepare(`SELECT * FROM ai_model_pricing WHERE id=?`).get(id); },
  create(p) {
    const info = db.prepare(`INSERT INTO ai_model_pricing(model,display_name,provider,input_per_1m,output_per_1m,is_active) VALUES(?,?,?,?,?,?)`)
      .run(p.model, p.display_name || "", p.provider || "", p.input_per_1m, p.output_per_1m, p.is_active === false ? 0 : 1);
    return this.get(info.lastInsertRowid);
  },
  update(id, p) {
    const cur = this.get(id);
    if (!cur) return null;
    db.prepare(`UPDATE ai_model_pricing SET model=?,display_name=?,provider=?,input_per_1m=?,output_per_1m=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(cur.model === "*" ? "*" : (p.model ?? cur.model), p.display_name ?? cur.display_name, p.provider ?? cur.provider,
           p.input_per_1m ?? cur.input_per_1m, p.output_per_1m ?? cur.output_per_1m,
           p.is_active === undefined ? cur.is_active : (p.is_active ? 1 : 0), id);
    return this.get(id);
  },
  delete(id) { return db.prepare(`DELETE FROM ai_model_pricing WHERE id=? AND model<>'*'`).run(id); },

  /**
   * Pick the pricing row for a model id returned by a provider. Exact match
   * first, then the longest configured model that is a prefix of it
   * ("gpt-4o" prices "gpt-4o-2024-08-06"), then the "*" default.
   */
  resolve(model) {
    const m = String(model || "").toLowerCase();
    const rows = db.prepare(`SELECT * FROM ai_model_pricing WHERE is_active=1`).all();
    let best = null;
    for (const r of rows) {
      const key = r.model.toLowerCase();
      if (key === "*") continue;
      if (key === m) return r;
      const prefix = key.endsWith("*") ? key.slice(0, -1) : key;
      if (m.startsWith(prefix) && (!best || prefix.length > best.model.length)) best = r;
    }
    return best || rows.find(r => r.model === "*") || { model: "*", input_per_1m: 0, output_per_1m: 0 };
  },
};

export const creditRepo = {
  /** Fetch a user's credit account, creating it with the default allowance on first use. */
  ensure(userId) {
    let row = db.prepare(`SELECT * FROM ai_user_credits WHERE user_id=?`).get(userId);
    if (!row) {
      const user = db.prepare(`SELECT id, username, role FROM users WHERE id=?`).get(userId);
      if (!user) return null;
      const allowance = creditSettings.get().default_allowance_usd;
      db.prepare(`INSERT INTO ai_user_credits(user_id, allowed_usd) VALUES(?,?)`).run(userId, allowance);
      logTx(userId, user.username, "grant", allowance, allowance, 0, "Default allowance on first use", "system");
      row = db.prepare(`SELECT * FROM ai_user_credits WHERE user_id=?`).get(userId);
    }
    return row;
  },
  balance(userId) {
    const a = this.ensure(userId);
    if (!a) return null;
    return { ...a, remaining_usd: round6(a.allowed_usd - a.used_usd) };
  },
};

function logTx(userId, username, type, amount, allowedAfter, usedAfter, note, by) {
  db.prepare(`INSERT INTO ai_credit_transactions(user_id,username,type,amount_usd,allowed_after,used_after,note,performed_by) VALUES(?,?,?,?,?,?,?,?)`)
    .run(userId, username || "", type, round6(amount), round6(allowedAfter), round6(usedAfter), note || "", by || "");
}

/**
 * Admin actions on a user's credit. Every change is written to
 * ai_credit_transactions so the history shows who changed what and when.
 *   grant       — add `amount` to the allowance (negative amount deducts)
 *   set_limit   — set the allowance to exactly `amount`
 *   reset_usage — zero the used counter (e.g. a new billing month)
 *   unlimited / limited, block / unblock — flags
 */
export const adjustCredit = db.transaction((userId, action, { amount = 0, note = "" } = {}, by = "") => {
  const acct = creditRepo.ensure(userId);
  if (!acct) throw new Error("User not found");
  const username = db.prepare(`SELECT username FROM users WHERE id=?`).get(userId)?.username || "";
  let { allowed_usd, used_usd, unlimited, blocked } = acct;
  let txAmount = 0;
  const amt = Number(amount) || 0;
  switch (action) {
    case "grant":       allowed_usd = Math.max(0, allowed_usd + amt); txAmount = amt; break;
    case "set_limit":   txAmount = Math.max(0, amt) - allowed_usd; allowed_usd = Math.max(0, amt); break;
    case "reset_usage": txAmount = used_usd; used_usd = 0; break;
    case "unlimited":   unlimited = 1; break;
    case "limited":     unlimited = 0; break;
    case "block":       blocked = 1; break;
    case "unblock":     blocked = 0; break;
    default: throw new Error(`Unknown action: ${action}`);
  }
  db.prepare(`UPDATE ai_user_credits SET allowed_usd=?, used_usd=?, unlimited=?, blocked=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
    .run(round6(allowed_usd), round6(used_usd), unlimited, blocked, userId);
  logTx(userId, username, action, txAmount, allowed_usd, used_usd, note, by);
  return creditRepo.balance(userId);
});

// ── Enforcement + recording ──────────────────────────────────────────────────
export class AiCreditError extends Error {
  constructor(message) { super(message); this.name = "AiCreditError"; this.code = "AI_CREDIT_EXHAUSTED"; this.status = 402; }
}

/** Throws AiCreditError when this user may not make another AI call. */
export function assertCanUseAi(userId) {
  if (!userId) return;
  const s = creditSettings.get();
  const b = creditRepo.balance(userId);
  if (!b) return;
  if (b.blocked) throw new AiCreditError("AI access is blocked for your account. Please contact your administrator.");
  if (!s.enforce || b.unlimited) return;
  if (b.remaining_usd <= 0) {
    throw new AiCreditError(`AI credit limit reached — you have used $${b.used_usd.toFixed(4)} of your $${b.allowed_usd.toFixed(2)} allowance. Please contact your administrator to add credit.`);
  }
}

const recordTx = db.transaction((row, prompt) => {
  let balanceAfter = null;
  let promptId = null;
  if (prompt) {
    // prompt is the request's mutable context object — create its row on the
    // first AI call, then accumulate every later call of the same request.
    if (!prompt.id) {
      prompt.id = db.prepare(`INSERT INTO ai_prompts(user_id,username,prompt,feature,session_id) VALUES(?,?,?,?,?)`)
        .run(row.user_id, row.username, String(prompt.text || "").slice(0, 4000), row.feature, String(prompt.sessionId || "").slice(0, 100)).lastInsertRowid;
    }
    promptId = prompt.id;
    db.prepare(`UPDATE ai_prompts SET calls=calls+1, input_tokens=input_tokens+?, output_tokens=output_tokens+?, total_cost=ROUND(total_cost+?,6), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(row.input_tokens, row.output_tokens, row.total_cost, promptId);
  }
  if (row.user_id) {
    const acct = creditRepo.ensure(row.user_id);
    if (acct) {
      const used = round6(acct.used_usd + row.total_cost);
      db.prepare(`UPDATE ai_user_credits SET used_usd=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`).run(used, row.user_id);
      balanceAfter = round6(acct.allowed_usd - used);
    }
  }
  db.prepare(`INSERT INTO ai_usage_log(user_id,username,model,priced_as,provider,feature,input_tokens,output_tokens,input_rate,output_rate,input_cost,output_cost,total_cost,balance_after,estimated,prompt_id)
              VALUES(@user_id,@username,@model,@priced_as,@provider,@feature,@input_tokens,@output_tokens,@input_rate,@output_rate,@input_cost,@output_cost,@total_cost,@balance_after,@estimated,@prompt_id)`)
    .run({ ...row, balance_after: balanceAfter, prompt_id: promptId });
});

/** Price one AI call and deduct it from the user's credit. Never throws. */
export function recordAiUsage({ user, model, provider, feature, prompt, inputTokens = 0, outputTokens = 0, estimated = false }) {
  try {
    if (!inputTokens && !outputTokens) return;
    const p = pricingRepo.resolve(model);
    const input_cost  = round6(inputTokens  / 1e6 * p.input_per_1m);
    const output_cost = round6(outputTokens / 1e6 * p.output_per_1m);
    recordTx({
      user_id: user?.user_id ?? null,
      username: user?.username || "system",
      model: model || "unknown",
      priced_as: p.model,
      provider: provider || "",
      feature: feature || "",
      input_tokens: Math.round(inputTokens),
      output_tokens: Math.round(outputTokens),
      input_rate: p.input_per_1m,
      output_rate: p.output_per_1m,
      input_cost, output_cost,
      total_cost: round6(input_cost + output_cost),
      estimated: estimated ? 1 : 0,
    }, prompt || null);
  } catch (e) {
    console.error("[ai-credits] failed to record usage:", e.message);
  }
}

// ── Transport-level meter ────────────────────────────────────────────────────
// → { user: {user_id, username, role} | null, feature: string, prompt: {text, sessionId, id?} | null }
let _resolveCtx = () => null;
export function setAiContextResolver(fn) { _resolveCtx = fn; }
function ctx() { try { return _resolveCtx() || {}; } catch { return {}; } }

function isAiUrl(url) {
  const u = String(url || "");
  if (!u) return false;
  if (/\/v1\/messages\/count_tokens/.test(u)) return false;
  if (/\/v1\/messages(\?|$)/.test(u) || /\/chat\/completions/.test(u)) return true;
  const gpt = process.env.AZURE_GPT_ENDPOINT;
  return !!gpt && u.startsWith(gpt.split("?")[0]);
}

function providerOf(url) {
  const u = String(url);
  if (u.includes("api.anthropic.com")) return "anthropic";
  if (u.includes("/v1/messages")) return "azure-claude";
  if (u.includes("api.openai.com")) return "openai";
  return "azure-gpt";
}

/** Pull {model, input, output} out of an Anthropic or OpenAI-shaped response body. */
function extractUsage(data, fallbackModel) {
  const u = data?.usage;
  if (!u) return null;
  const input = (u.input_tokens ?? u.prompt_tokens ?? 0)
    + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens ?? u.completion_tokens ?? 0;
  return { model: data.model || fallbackModel, input, output };
}

function modelFromBody(body) {
  try { return (typeof body === "string" ? JSON.parse(body) : body)?.model || ""; } catch { return ""; }
}

/** Read an SSE stream copy in the background and meter the usage it reports. */
async function meterSseStream(stream, c, provider, fallbackModel) {
  let buf = "", model = fallbackModel, input = 0, output = 0;
  const decoder = new TextDecoder();
  const handle = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const d = t.slice(5).trim();
    if (!d || d === "[DONE]") return;
    let ev; try { ev = JSON.parse(d); } catch { return; }
    if (ev.type === "message_start" && ev.message) {
      model = ev.message.model || model;
      const u = ev.message.usage || {};
      input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      output = u.output_tokens || output;
    } else if (ev.type === "message_delta" && ev.usage) {
      output = ev.usage.output_tokens ?? output;
    } else if (ev.usage) {                       // OpenAI final chunk with include_usage
      model = ev.model || model;
      input = ev.usage.prompt_tokens ?? input;
      output = ev.usage.completion_tokens ?? output;
    }
  };
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      lines.forEach(handle);
    }
    if (buf) handle(buf);
  } catch { /* stream aborted — record what we saw */ }
  recordAiUsage({ user: c.user, model, provider, feature: c.feature, prompt: c.prompt, inputTokens: input, outputTokens: output });
}

let _installed = false;
export function installAiUsageMeter() {
  if (_installed) return;
  _installed = true;

  // 1) global fetch — covers the Anthropic SDK and raw fetch() calls
  const origFetch = globalThis.fetch;
  if (typeof origFetch === "function") {
    globalThis.fetch = async function meteredFetch(input, init) {
      const url = typeof input === "string" ? input : (input?.url || String(input));
      if (!isAiUrl(url)) return origFetch(input, init);
      const c = ctx();
      try { assertCanUseAi(c.user?.user_id); }
      catch (e) {
        // Answer like the provider would rather than throwing: SDKs turn a
        // thrown fetch into a retried, generic "Connection error.", but pass
        // a 402 body's error.message straight through to the caller.
        if (!(e instanceof AiCreditError)) throw e;
        return new Response(JSON.stringify({ type: "error", error: { type: "credit_limit", code: e.code, message: e.message } }),
          { status: 402, headers: { "content-type": "application/json" } });
      }
      const res = await origFetch(input, init);
      if (!res.ok) return res;
      const provider = providerOf(url);
      const reqModel = modelFromBody(init?.body);
      try {
        const type = res.headers.get("content-type") || "";
        const copy = res.clone();
        if (type.includes("text/event-stream")) {
          meterSseStream(copy.body, c, provider, reqModel);
        } else {
          copy.json().then(data => {
            const u = extractUsage(data, reqModel);
            if (u) recordAiUsage({ user: c.user, model: u.model, provider, feature: c.feature, prompt: c.prompt, inputTokens: u.input, outputTokens: u.output });
          }).catch(() => {});
        }
      } catch { /* never let metering break the call */ }
      return res;
    };
  }

  // 2) axios — covers the Azure Claude / Azure GPT helpers
  axios.interceptors.request.use((config) => {
    if (isAiUrl(config.url)) {
      const c = ctx();
      assertCanUseAi(c.user?.user_id);
      config.__aiMeter = c;
    }
    return config;
  });
  axios.interceptors.response.use((res) => {
    const c = res.config?.__aiMeter;
    // Streams are metered by their consumer (see gptChatCompleteStream) —
    // reading them here would steal chunks from the caller.
    if (c && res.status >= 200 && res.status < 300 && res.config.responseType !== "stream") {
      const u = extractUsage(res.data, modelFromBody(res.config.data));
      if (u) recordAiUsage({ user: c.user, model: u.model, provider: providerOf(res.config.url), feature: c.feature, prompt: c.prompt, inputTokens: u.input, outputTokens: u.output });
    }
    return res;
  });
}

/** Current request's context — for callers that meter manually (streams). */
export function currentAiContext() { return ctx(); }
