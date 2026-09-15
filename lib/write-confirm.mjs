// Write-action confirmation gate for the tool-calling chat agent (both the
// Anthropic and GPT-4o loops in chat-server.mjs). Previously any of these
// MCP tools executed the moment the model decided to call them — the model
// would post a Sales Order, apply a payment, etc. and the user only found
// out after the fact, either with a plain success message or a raw SAP
// error dumped into chat (the duplicate-reference-number dead-end earlier
// in this project's history was exactly this: no preview, no chance to
// catch it before SAP rejected it). Now: draft → show what will happen →
// require an explicit yes → only then call the tool.

export const WRITE_TOOLS = new Set([
  "create_sales_quotation",
  "create_sales_order",
  "create_delivery",
  "confirm_delivery_pod",
  "create_ar_invoice",
  "apply_incoming_payment",
  "create_purchase_request",
  "create_purchase_quotation",
  "create_po_from_quotation",
  "create_purchase_order",
  "create_goods_receipt_po",
  "create_ap_invoice",
  "apply_outgoing_payment",
]);

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

// Human-readable summary of one or more proposed write actions, shown to
// the user before anything is actually sent to SAP.
export function describeWriteActions(calls) {
  return calls.map(({ name, args }) => {
    const lines = Object.entries(args || {}).map(([k, v]) => {
      if (Array.isArray(v)) {
        if (!v.length) return `  • ${k}: (none)`;
        const preview = v.slice(0, 5).map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join("\n    ");
        const more = v.length > 5 ? `\n    ...and ${v.length - 5} more` : "";
        return `  • ${k} (${v.length}):\n    ${preview}${more}`;
      }
      if (v && typeof v === "object") return `  • ${k}: ${JSON.stringify(v)}`;
      return `  • ${k}: ${v}`;
    }).join("\n");
    return `**${name}**\n${lines}`;
  }).join("\n\n");
}

export const CONFIRM_RE = /^\s*(yes|y|confirm|confirmed|go ahead|proceed|do it|approve|approved|ok|okay|sure|post it)\s*[.!]?\s*$/i;
export const CANCEL_RE  = /^\s*(no|n|cancel|stop|nevermind|never\s*mind|don'?t|do not)\s*[.!]?\s*$/i;
