// Shared by the PO Agentic Workflow (controllers/po-workflow-agent.mjs) and
// the still-inline Mail-PO→SO agent in chat-server.mjs — both turn a parsed
// PDF purchase order into a live SAP B1 Sales Order via the same call, and
// both use the same AI text-completion helper to parse the PDF in the first
// place. Pulled out so neither has to hoist-reference the other's file.

export async function createSoDirect(activeSap, { cardCode, docDate, docDueDate, numAtCard, currency, comments, docLines }) {
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
  const result = await activeSap.post("/Orders", payload);
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
