/**
 * VestLaunch MCP — HTTP (Streamable) transport for Vercel.
 *
 * Hosts the SAME tool surface as the stdio entry point (src/index.ts), but
 * over HTTP so Anthropic's Claude Managed Agents can reach it as a remote
 * MCP server (the platform has no env-secret field — the only credential
 * path is a vault that injects auth onto a remote MCP URL; see project D8).
 *
 * Auth: a single static Bearer token (MCP_BEARER_TOKEN). The Managed Agents
 * credential vault stores this token bound to this URL and injects it as
 * `Authorization: Bearer <token>` on every connect. Any request without the
 * matching Bearer is rejected.
 *
 * Read-only by default: loadConfig() leaves VESTLAUNCH_ENABLE_WRITES=false
 * unless explicitly set, so this hosted server exposes read tools only.
 *
 * Stateless: a fresh Server + transport is built per request. That is the
 * recommended pattern for serverless (no shared in-memory session state
 * across lambda invocations).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Import the COMPILED server (Vercel runs `npm run build` first, producing dist/).
import { loadConfig } from "../dist/config.js";
import { buildServer } from "../dist/server.js";

// Give the function room for the agent's paginated pulls.
export const config = { maxDuration: 60 };

function rejectUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
  );
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  // --- Bearer auth (the vault injects this on the MCP URL) ---
  const expected = process.env.MCP_BEARER_TOKEN;
  const auth = req.headers["authorization"];
  if (!expected || auth !== `Bearer ${expected}`) {
    rejectUnauthorized(res);
    return;
  }

  // --- Build a fresh MCP server + stateless transport for this request ---
  let server;
  try {
    ({ server } = await buildServer(loadConfig()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32002, message: `MCP server init failed: ${msg}` },
        id: null,
      }),
    );
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    enableJsonResponse: true, // return a single JSON response (serverless-friendly)
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  // Vercel parses JSON bodies into req.body; pass it through to the transport.
  await transport.handleRequest(req, res, req.body);
}
