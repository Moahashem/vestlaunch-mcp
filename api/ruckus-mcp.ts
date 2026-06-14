/**
 * Ruckus reply MCP — HTTP (Streamable) transport for Vercel.
 *
 * A tiny, SELF-CONTAINED MCP server that exposes exactly ONE tool, `ruckus_send`,
 * which lets the Ruckus agent (FFL Chief of Staff) post a message into its own
 * RingCentral channel. It does this by calling the ffl-crm endpoint
 *   POST /api/ringcentral/ruckus-send
 * which posts as the Ruckus bot. We keep this SEPARATE from the shared read MCP
 * (api/mcp.ts) so Ruckus's "acting" path can never affect the read tools the
 * other FFL agents rely on.
 *
 * Why a tool (not the model holding a secret): the CRM send endpoint is gated by
 * a bearer token. That token lives ONLY in this server's env (RUCKUS_SEND_TOKEN)
 * and is injected server-side here — the model just calls `ruckus_send({text})`
 * and never sees the secret.
 *
 * Auth (agent → this MCP): a single static Bearer token (MCP_BEARER_TOKEN, the
 * same vault-injected token the read MCP uses), so the Managed Agents credential
 * vault injects it identically.
 *
 * Env (set by Mo in Vercel — never hard-coded):
 *   RUCKUS_MCP_BEARER     — bearer the connecting agent must present (set this fresh in env
 *                          + the vault credential for /api/ruckus-mcp). Falls back to
 *                          MCP_BEARER_TOKEN if unset.
 *   RUCKUS_SEND_TOKEN    — bearer for the CRM send endpoint (= ffl-crm CRON_SECRET). SECRET.
 *   RUCKUS_SEND_BASE_URL — optional CRM base; defaults to VESTLAUNCH_BASE_URL,
 *                          then https://crm.vestlaunch.com
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

const TOOL_NAME = "ruckus_send";
const TOOL_DESC =
  "Post a message into Ruckus's own RingCentral channel — this is Ruckus's reply " +
  "path as FFL Chief of Staff. Calls ffl-crm POST /api/ringcentral/ruckus-send, which " +
  "posts as the Ruckus bot. Your text is NOT auto-delivered: you MUST call this tool to " +
  "be heard, whether replying to a person or posting your morning brief. Args: { text } " +
  "(required); optional { chatId } overrides the default channel. Returns { ok, chatId }.";
const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    text: { type: "string", description: "The message text to post into Ruckus's channel." },
    chatId: {
      type: "string",
      description: "Optional RingCentral chat id to override the default Ruckus channel.",
    },
  },
  required: ["text"],
  additionalProperties: false,
};

function baseUrl(): string {
  const explicit = (process.env.RUCKUS_SEND_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  return "https://crm.vestlaunch.com";
}

async function ruckusSend(args: Record<string, unknown>, forwardToken?: string): Promise<unknown> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new Error("ruckus_send requires a non-empty 'text'.");

  // Prefer the bearer the agent presented (the vault-injected CRM credential),
  // forwarded straight through; fall back to the RUCKUS_SEND_TOKEN env var.
  const token = (forwardToken ?? "").trim() || (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "ruckus_send is not configured: set RUCKUS_SEND_TOKEN in this MCP's env " +
        "(= the ffl-crm CRON_SECRET that gates /api/ringcentral/ruckus-send).",
    );
  }

  const body: Record<string, unknown> = { text };
  if (typeof args.chatId === "string" && args.chatId.trim()) body.chatId = args.chatId.trim();

  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/api/ringcentral/ruckus-send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ruckus-mcp-http/0.1.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const out = await res.text();
    let json: unknown = null;
    try {
      json = out ? JSON.parse(out) : null;
    } catch {
      json = { raw: out };
    }
    if (!res.ok) return { ok: false, status: res.status, error: json ?? out };
    return json ?? { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function buildServer(forwardToken?: string): Server {
  const server = new Server(
    { name: "ruckus-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: TOOL_NAME, description: TOOL_DESC, inputSchema: TOOL_SCHEMA }],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    if (name !== TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await ruckusSend((rawArgs ?? {}) as Record<string, unknown>, forwardToken);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error invoking ${TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
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
  // Dedicated bearer for THIS server (falls back to the shared MCP_BEARER_TOKEN).
  // Using its own token means the vault credential for /api/ruckus-mcp can be set
  // to a fresh value without needing the (write-only/unrecoverable) MCP_BEARER_TOKEN.
  // Accepts (in order) a dedicated RUCKUS_MCP_BEARER, else the already-set
  // RUCKUS_SEND_TOKEN, else the shared MCP_BEARER_TOKEN. The vault injects this as
  // the Authorization header server-side, so the model never sees it. Reusing
  // RUCKUS_SEND_TOKEN means no NEW env var is needed and the vault credential can be
  // set to that (recoverable) value.
  const expected =
    process.env.RUCKUS_MCP_BEARER || process.env.RUCKUS_SEND_TOKEN || process.env.MCP_BEARER_TOKEN;
  if (!expected || req.headers["authorization"] !== `Bearer ${expected}`) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }

  // Forward the agent's vault-provided bearer straight to ffl-crm ruckus-send, so the
  // downstream call uses the SAME credential the vault injected (the CRM CRON_SECRET) —
  // no separate RUCKUS_SEND_TOKEN sync needed. Falls back to RUCKUS_SEND_TOKEN if absent.
  const incomingBearer = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "").trim();
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
