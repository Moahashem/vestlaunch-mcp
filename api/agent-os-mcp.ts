/**
 * AI Operating System MCP — HTTP (Streamable) transport for Vercel.
 *
 * Exposes the shared agent "Heartbeat" logbook as MCP tools so any FFL agent
 * (and Ruckus, the Chief of Staff) can use it:
 *   - agent_heartbeat        → an agent reports what it just did (write)
 *   - agent_heartbeats_list  → read recent heartbeats (for the brief / dashboard)
 *
 * Both RELAY to ffl-crm:
 *   POST /api/agent-os/heartbeat   and   GET /api/agent-os/heartbeats
 * which are gated by the CRM CRON_SECRET. Kept SEPARATE from the shared read MCP
 * (api/mcp.ts) and the Ruckus reply MCP (api/ruckus-mcp.ts) so the OS plumbing
 * can never affect the tools other agents rely on.
 *
 * Auth model (same as ruckus-mcp): THIN AUTHENTICATED RELAY. The agent presents
 * a bearer (the vault injects one); we forward that exact bearer to ffl-crm,
 * whose CRON_SECRET check is the real gate. So the vault credential's token must
 * equal the CRM CRON_SECRET. Fallback: AGENT_OS_SEND_TOKEN env.
 *
 * Env (set in Vercel — never hard-coded):
 *   AGENT_OS_SEND_TOKEN   — fallback bearer for the CRM endpoints (= CRON_SECRET)
 *   AGENT_OS_BASE_URL     — optional CRM base; defaults to VESTLAUNCH_BASE_URL,
 *                           then https://crm.vestlaunch.com
 *   VESTLAUNCH_TIMEOUT_MS — optional request timeout (default 30s)
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const config = { maxDuration: 30 };

const WRITE_TOOL = "agent_heartbeat";
const WRITE_DESC =
  "Report what you (an FFL AI agent) just did into the AI Operating System " +
  "logbook, so the dashboard and Ruckus can see it. Call this once at the end " +
  "of a run. Args: { agentKey } (required, your id e.g. 'occupancy'), plus " +
  "optional { status: 'ok'|'error', summary, needsHuman, tier: 'green'|'yellow'|'red', payload }.";
const WRITE_SCHEMA = {
  type: "object" as const,
  properties: {
    agentKey: { type: "string", description: "Your agent id, e.g. 'occupancy'." },
    status: { type: "string", description: "'ok' or 'error'. Defaults to 'ok'." },
    summary: { type: "string", description: "One line: what you did / found." },
    needsHuman: { type: "boolean", description: "True if a human needs to look." },
    tier: { type: "string", description: "Autonomy tier: 'green' | 'yellow' | 'red'." },
    payload: { type: "object", description: "Optional structured detail.", additionalProperties: true },
  },
  required: ["agentKey"],
  additionalProperties: false,
};

const LIST_TOOL = "agent_heartbeats_list";
const LIST_DESC =
  "Read recent agent heartbeats from the AI Operating System logbook (most " +
  "recent first). Use this to see what the agent workforce has been doing. " +
  "Args (optional): { limit (default 100, max 500), agentKey (filter to one agent) }.";
const LIST_SCHEMA = {
  type: "object" as const,
  properties: {
    limit: { type: "number", description: "Max rows (default 100, max 500)." },
    agentKey: { type: "string", description: "Optional: only this agent's heartbeats." },
  },
  additionalProperties: false,
};

function baseUrl(): string {
  const explicit = (process.env.AGENT_OS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  return "https://crm.vestlaunch.com";
}

function bearer(forwardToken?: string): string {
  return (forwardToken ?? "").trim() || (process.env.AGENT_OS_SEND_TOKEN ?? "").trim();
}

function timeoutMs(): number {
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(t) && t > 0 ? t : 30_000;
}

async function callCrm(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  if (!token) {
    throw new Error(
      "agent-os MCP is not configured: present a bearer (vault) or set " +
        "AGENT_OS_SEND_TOKEN (= the ffl-crm CRON_SECRET).",
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "agent-os-mcp-http/0.1.0",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const out = await res.text();
    let parsed: unknown = null;
    try {
      parsed = out ? JSON.parse(out) : null;
    } catch {
      parsed = { raw: out };
    }
    if (!res.ok) return { ok: false, status: res.status, error: parsed ?? out };
    return parsed ?? { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function writeHeartbeat(args: Record<string, unknown>, token: string): Promise<unknown> {
  const agentKey = typeof args.agentKey === "string" ? args.agentKey.trim() : "";
  if (!agentKey) throw new Error("agent_heartbeat requires a non-empty 'agentKey'.");
  const body: Record<string, unknown> = { agentKey };
  if (typeof args.status === "string") body.status = args.status;
  if (typeof args.summary === "string") body.summary = args.summary;
  if (typeof args.needsHuman === "boolean") body.needsHuman = args.needsHuman;
  if (typeof args.tier === "string") body.tier = args.tier;
  if (args.payload && typeof args.payload === "object") body.payload = args.payload;
  return callCrm("POST", "/api/agent-os/heartbeat", token, body);
}

async function listHeartbeats(args: Record<string, unknown>, token: string): Promise<unknown> {
  const params = new URLSearchParams();
  const limit = typeof args.limit === "number" ? Math.trunc(args.limit) : undefined;
  if (limit && limit > 0) params.set("limit", String(limit));
  if (typeof args.agentKey === "string" && args.agentKey.trim()) {
    params.set("agentKey", args.agentKey.trim());
  }
  const qs = params.toString();
  return callCrm("GET", `/api/agent-os/heartbeats${qs ? `?${qs}` : ""}`, token);
}

function buildServer(forwardToken?: string): Server {
  const server = new Server(
    { name: "agent-os-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: WRITE_TOOL, description: WRITE_DESC, inputSchema: WRITE_SCHEMA },
      { name: LIST_TOOL, description: LIST_DESC, inputSchema: LIST_SCHEMA },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const token = bearer(forwardToken);
    try {
      let result: unknown;
      if (name === WRITE_TOOL) result = await writeHeartbeat(args, token);
      else if (name === LIST_TOOL) result = await listHeartbeats(args, token);
      else return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error invoking ${name}: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  // THIN AUTHENTICATED RELAY (same as ruckus-mcp): require some bearer, forward
  // it to ffl-crm; the CRM CRON_SECRET check is the real gate.
  const incomingBearer = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "").trim();
  if (!incomingBearer) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  const server = buildServer(incomingBearer);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
