// Shared by the PO Agentic Workflow (controllers/po-workflow-agent.mjs) and
// the still-inline Mail-PO→SO agent in chat-server.mjs — both turn a parsed
// PDF purchase order into a live SAP B1 Sales Order via the same call, and
// both use the same AI text-completion helper to parse the PDF in the first
// place. Pulled out so neither has to hoist-reference the other's file.

import { DUPLICATE_REF_RE, suggestAltReference } from "./write-confirm.mjs";

// Thrown when SAP blocks on a duplicate customer/vendor reference (NumAtCard) and the
// caller hasn't opted in to posting with a bumped reference — lets the route ask the
// user to confirm instead of failing outright. Mirrors the recovery already built for
// the AI-chat tool-calling path in write-confirm.mjs, for this direct-post path.
export class DuplicateRefError extends Error {
  constructor(numAtCard) {
    const suggestedRef = suggestAltReference(numAtCard);
    super(`A sales order with reference "${numAtCard}" already exists for this customer. Try "${suggestedRef}" instead?`);
    this.duplicateRef = true;
    this.numAtCard = numAtCard;
    this.suggestedRef = suggestedRef;
  }
}

const VALID_CURRENCY_RE = /-5002|valid currency code/i;

export async function createSoDirect(activeSap, { cardCode, docDate, docDueDate, numAtCard, currency, comments, docLines, allowDuplicateRef }) {
  const today = new Date().toISOString().split("T")[0];
  const payload = {
    CardCode: cardCode,
    DocDate:  docDate || today,
    Comments: comments || "",
    DocumentLines: docLines,
  };
  if (docDueDate) payload.DocDueDate = docDueDate;
  if (numAtCard)  payload.NumAtCard  = numAtCard;
  if (currency)   payload.DocCurrency = currency;

  let attempt = payload;
  let result;
  for (let i = 0; i < 3 && !result; i++) {
    try {
      result = await activeSap.post("/Orders", attempt);
    } catch (e) {
      // This company DB rejects an explicit DocCur — neither the ISO code (e.g. "USD")
      // nor the "local currency" marker "##" validates against ORCR here, meaning the
      // company isn't set up for multi-currency documents at all. Drop DocCurrency and
      // let SAP default it instead of dictating one.
      if (attempt.DocCurrency && VALID_CURRENCY_RE.test(e.message)) {
        const { DocCurrency, ...rest } = attempt;
        attempt = rest;
        continue;
      }
      // Duplicate customer/vendor reference — same SAP -5002 block the AI-chat path
      // already recovers from (see write-confirm.mjs). Only bump the reference if the
      // caller explicitly opted in; otherwise surface it so the caller can ask first.
      if (attempt.NumAtCard && DUPLICATE_REF_RE.test(e.message)) {
        if (!allowDuplicateRef) throw new DuplicateRefError(attempt.NumAtCard);
        attempt = { ...attempt, NumAtCard: suggestAltReference(attempt.NumAtCard) };
        continue;
      }
      throw e;
    }
  }
  if (!result?.DocNum) throw new Error(result?.error?.message || result?.message || "SO creation returned no DocNum");
  return { DocNum: result.DocNum, DocEntry: result.DocEntry };
}

// { AI_PROVIDER, azureMessagesCreate, gptChatComplete } passed in rather than
// imported — both callers already have their own copies of these (chat-server.mjs
// has the module-level originals, controllers get them via deps injection).
export async function callAiText(prompt, maxTokens = 2500, { AI_PROVIDER, azureMessagesCreate, gptChatComplete }) {
  const model = process.env.AZURE_CLAUDE_MODEL ||
    (AI_PROVIDER === "azure" ? "claude-3-5-sonnet-20241022" : "claude-sonnet-4-6");
  if (AI_PROVIDER === "azure" && process.env.AZURE_OPENAI_API_KEY) {
    const body = { model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
    const r = await azureMessagesCreate(body);
    return r.content?.[0]?.text || r.choices?.[0]?.message?.content || "";
  }
  if (AI_PROVIDER === "gpt" && process.env.AZURE_GPT_ENDPOINT) {
    const body = { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
    const r = await gptChatComplete(body);
    return r.choices?.[0]?.message?.content || "";
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const ant = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const r = await ant.messages.create({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
  return r.content[0].text;
}
