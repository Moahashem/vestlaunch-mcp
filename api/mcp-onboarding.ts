/**
 * POST /api/mcp-onboarding
 *
 * Separate from /api/mcp. A key reaches this surface only when the CRM set
 * mcpProfile to "onboarding" and issued business plus workspaceIds. The shared
 * bearer is refused and is never exchanged for VESTLAUNCH_API_KEY. The only
 * tool is connection_status.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { readAccessToken } from "./_oauth";
import {
  CONNECTION_STATUS_TOOL,
  connectionStatusPayload,
  argumentsStayInsideOnboarding,
  onboardingAllows,
  readOnboardingClaims,
  type OnboardingClaims,
} from "./_mcp-onboarding-policy";
import { classifyPresentedCredential, type McpCredentialClass } from "./mcp";

const CRM_KEY_PREFIX = "ffl_live_";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function logClass(kind: McpCredentialClass): void {
  process.stdout.write(`mcp_onboarding_class=${kind}\n`);
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const legacyToken = (process.env.MCP_BEARER_TOKEN ?? "").trim();
  const presented = classifyPresentedCredential({
    bearer,
    legacyToken,
    crmKeyPrefix: CRM_KEY_PREFIX,
    oauthUnwrapped: false,
  });

  if (!bearer) {
    logClass("rejected");
    sendJson(res, 401, { error: "Onboarding requires that bot's own CRM key or OAuth token." });
    return;
  }
  if (presented === "shared_bearer") {
    logClass("rejected");
    sendJson(res, 401, { error: "The shared bearer cannot be used for onboarding." });
    return;
  }

  let crmKey = "";
  let kind: McpCredentialClass = "rejected";
  if (presented === "crm_key") {
    crmKey = bearer;
    kind = "crm_key";
  } else {
    try {
      const unwrapped = (await readAccessToken(bearer)).crmKey;
      if (!unwrapped.startsWith(CRM_KEY_PREFIX)) {
        logClass("rejected");
        sendJson(res, 401, { error: "Onboarding token did not carry a CRM key." });
        return;
      }
      crmKey = unwrapped;
      kind = "oauth";
    } catch {
      logClass("rejected");
      sendJson(res, 401, { error: "Invalid or expired sign-in token." });
      return;
    }
  }
  logClass(kind);

  const baseUrl = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    sendJson(res, 500, { error: "Onboarding is not configured." });
    return;
  }
  let identity: unknown;
  try {
    const response = await fetch(`${baseUrl}/api/v1/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${crmKey}`,
        Accept: "application/json",
        "User-Agent": "vestlaunch-mcp-onboarding/0.1.0",
      },
    });
    if (!response.ok) {
      sendJson(res, 401, { error: "Invalid or revoked API key." });
      return;
    }
    const body = (await response.json()) as { data?: { identity?: unknown } };
    identity = body.data?.identity;
  } catch {
    sendJson(res, 401, { error: "Invalid or revoked API key." });
    return;
  }

  const claims = readOnboardingClaims(identity);
  if (!claims.ok) {
    sendJson(res, 403, { error: claims.reason });
    return;
  }
  await serve(req, res, claims.claims);
}

async function serve(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  claims: OnboardingClaims,
): Promise<void> {
  const server = new Server({ name: "vestlaunch-mcp-onboarding", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: CONNECTION_STATUS_TOOL.name,
        description: "Onboarding self-check. No CRM records. The allowlist is server-owned.",
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    if (!onboardingAllows(call.params.name) || !argumentsStayInsideOnboarding(call.params.arguments)) {
      return { content: [{ type: "text", text: "This call is outside the onboarding allowlist." }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(connectionStatusPayload(claims)) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
