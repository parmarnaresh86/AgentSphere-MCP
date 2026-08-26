import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

type JsonObject = Record<string, unknown>;

type ToolResponse = {
  content: Array<{ type: "text"; text: string }>;
};

type AgentEntry = {
  id: string;
  label: string;
  description?: string;
  kind: "tool" | "controller" | "page" | "inline-route";
  existingTools?: string[];
  existingController?: { mount: string; chatEndpoint?: string; endpoints?: string[] };
  existingUI?: string;
  status: "available" | "coming_soon" | "disabled";
};

type ModuleEntry = {
  id: string;
  label: string;
  agents: AgentEntry[];
};

type Registry = {
  connector: string;
  modules: ModuleEntry[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = path.resolve(__dirname, "..", "data", "agent-registry.json");

function loadRegistry(): Registry {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
  return JSON.parse(raw) as Registry;
}

function findAgent(registry: Registry, id: string): { module: ModuleEntry; agent: AgentEntry } | null {
  for (const module of registry.modules) {
    const agent = module.agents.find((a) => a.id === id);
    if (agent) return { module, agent };
  }
  return null;
}

function textResponse(payload: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

const CHAT_UI_BASE_URL = (process.env.CHAT_UI_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

function webUiUrl(agent: AgentEntry): string | null {
  if (agent.status !== "available") return null;
  return CHAT_UI_BASE_URL + (agent.existingUI ?? "/");
}

function withWebUiUrl(agent: AgentEntry): AgentEntry & { webUiUrl: string | null } {
  return { ...agent, webUiUrl: webUiUrl(agent) };
}

const toolDefinitions = [
  {
    name: "list_sap_agents",
    description:
      "List the SAP Business One agentic workflows available in this project, grouped by business module (Sales, Purchase, Inventory, Finance, Production, WMS, Analytics, Approvals, Autonomous). Each agent entry names the real existing MCP tool(s) on the sap-b1 connector and/or the existing chat-server controller/UI page that implements it, plus a webUiUrl — this tool never invents functionality. Optionally filter by category. AFTER calling this tool, render the result as an HTML artifact (a SAP Fiori-style agent hub: a header, one section per module, agents shown as cards with label + description + a status pill for \"available\"/\"coming_soon\"). EVERY card for an \"available\" agent MUST be wrapped in a real `<a href=\"{webUiUrl}\" target=\"_blank\">` — clicking it opens that agent's real, fully-interactive screen in the existing chat-server web app (requires `npm run chat` running). Do not render clickless divs/buttons with no href — a click must always do something real.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description:
            "Optional module id to filter to (e.g. \"sales\", \"purchase\", \"inventory\", \"finance\", \"production\", \"wms\", \"analytics\", \"approvals\", \"autonomous\"). Omit to list all modules.",
        },
      },
    },
  },
  {
    name: "get_sap_agent",
    description:
      "Get the full record for one SAP B1 agent by id, including which existing sap-b1 MCP tool names, controller endpoints, or UI page implement it, and its availability status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id, as returned by list_sap_agents (e.g. \"sales-order-agent\")." },
      },
      required: ["id"],
    },
  },
  {
    name: "open_sap_agent",
    description:
      "Resolve a menu selection to concrete next steps: which existing tool names to call on the sap-b1 connector, which existing chat-server controller/endpoint to use, or which existing public UI page to open. This tool is discovery-only — it never calls SAP itself, creates/updates/cancels/approves nothing, and does not bypass any confirmation the sap-b1 tools already require.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Agent id, as returned by list_sap_agents." },
      },
      required: ["id"],
    },
  },
];

const SERVER_INSTRUCTIONS = `This connector is a read-only discovery/navigation layer over the existing "sap-b1" SAP Business One MCP connector and its chat-server web UI. It does not talk to SAP and does not duplicate any business logic.

IMPORTANT PLATFORM LIMIT: a Claude-rendered HTML artifact is a sandboxed preview — clicking something inside it can NEVER trigger a new tool call or send a chat message back to Claude. The only click action that genuinely works inside an artifact is a real hyperlink (<a href>) that opens a URL. Design around this constraint; do not imply buttons will "call a tool" or "open a form here" unless that literally means opening a link.

WORKFLOW:
1. When the user asks to see their SAP B1 agents/workflows (or names a business area like "sales" or "purchase"), call list_sap_agents (optionally with a category).
2. RENDER THE RESULT AS AN HTML ARTIFACT, not as a chat text list or raw JSON. Build a self-contained HTML page styled like a SAP Fiori launchpad: a dark header bar reading "SAP Business One — Agentic ERP", then one section per module, each rendering its agents as a grid of cards (label, short description, a status pill). Every "available" card is a real anchor tag (a href = the agent's webUiUrl, target=_blank) into the existing chat-server web UI — that is the actual working, fully-interactive screen; the artifact itself is only a menu, never the real form/workflow. "coming_soon" cards render disabled with no href.
3. Tell the user once, near the artifact, that clicking a card opens the real screen in their browser and requires 'npm run chat' to already be running at the connector's webUiBase — if that server isn't up, the link will fail to load.
4. If the user instead wants to act without leaving the chat, they can type e.g. "open Sales Order Agent" or name the agent directly — call open_sap_agent with its id to resolve which real tool names / controller endpoint implement it, then call those tools directly on the "sap-b1" connector. Never re-implement the operation here.
5. Preserve all existing confirmation behavior: any create/update/cancel/approve/post operation must still go through the normal sap-b1 tool call and its usual confirmation, exactly as if this connector didn't exist.
6. Agents marked "coming_soon" have no real implementation yet — say so plainly rather than attempting the operation through a fallback tool.`;

const server = new Server(
  { name: "sap-ui-connector", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const registry = loadRegistry();
  const args = (request.params.arguments ?? {}) as JsonObject;

  switch (request.params.name) {
    case "list_sap_agents": {
      const category = typeof args.category === "string" ? args.category.toLowerCase() : undefined;
      const modules = (category
        ? registry.modules.filter((m) => m.id === category || m.label.toLowerCase() === category)
        : registry.modules
      ).map((m) => ({ ...m, agents: m.agents.map(withWebUiUrl) }));
      return textResponse({
        connector: registry.connector,
        webUiBase: CHAT_UI_BASE_URL,
        modules,
      });
    }
    case "get_sap_agent": {
      const id = typeof args.id === "string" ? args.id : "";
      const found = findAgent(registry, id);
      if (!found) throw new McpError(ErrorCode.InvalidParams, `Unknown agent id: ${id}`);
      return textResponse({ module: { id: found.module.id, label: found.module.label }, agent: withWebUiUrl(found.agent) });
    }
    case "open_sap_agent": {
      const id = typeof args.id === "string" ? args.id : "";
      const found = findAgent(registry, id);
      if (!found) throw new McpError(ErrorCode.InvalidParams, `Unknown agent id: ${id}`);
      const { agent } = found;
      if (agent.status !== "available") {
        return textResponse({
          id: agent.id,
          label: agent.label,
          status: agent.status,
          message: `${agent.label} has no real implementation yet in this project — do not attempt to fulfil this request through an unrelated tool.`,
        });
      }
      return textResponse({
        id: agent.id,
        label: agent.label,
        status: agent.status,
        webUiUrl: webUiUrl(agent),
        nextSteps: {
          callToolsOnSapB1Connector: agent.existingTools ?? [],
          controller: agent.existingController ?? null,
          uiPage: agent.existingUI ?? null,
        },
        instruction:
          `Link/open webUiUrl for the real, fully-interactive existing UI (requires 'npm run chat' to be running on ${CHAT_UI_BASE_URL}). ` +
          `To act directly in this chat instead, call the listed tool names on the sap-b1 connector — preserve normal confirmation for any create/update/cancel/approve/post operation.`,
      });
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }
});

async function main(): Promise<void> {
  loadRegistry(); // fail fast at startup if the registry file is missing/invalid
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SAP UI Connector MCP server running (stdio)");
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
