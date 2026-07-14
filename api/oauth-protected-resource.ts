/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for the VestLaunch MCP server.
 *
 * WHY THIS EXISTS: Modern MCP clients (Claude Desktop's custom-connector
 * "Connect" button) don't have a field to paste a static token. Instead they
 * follow the OAuth 2.1 discovery handshake: on a 401 they read the
 * `WWW-Authenticate: Bearer resource_metadata="…"` header, fetch THIS document,
 * learn which authorization server to log in against, then run the login/consent
 * flow and come back with a real access token.
 *
 * This endpoint points clients at our SELF-HOSTED authorization server — the
 * same deployment (see api/oauth-authorization-server.ts). No third party. It
 * does NOT issue tokens and holds no secrets — it's public metadata.
 *
 * Served at /.well-known/oauth-protected-resource via a rewrite in vercel.json.
 * The token-validation + token→CRM-key unwrap lives in api/mcp.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { baseUrl, resourceUrl } from "./_oauth";

export const config = { maxDuration: 10 };

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  // Public metadata — allow any origin and preflight.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const body = {
    resource: resourceUrl(req),
    // We ARE the authorization server — point clients back at this deployment.
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
    resource_documentation:
      "https://github.com/Moahashem/vestlaunch-mcp#hosted-no-install",
  };

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  // Metadata is stable; let clients cache it for an hour.
  res.setHeader("cache-control", "public, max-age=3600");
  res.end(JSON.stringify(body));
}
