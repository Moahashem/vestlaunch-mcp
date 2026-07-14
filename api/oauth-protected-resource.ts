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
 * This endpoint just points clients at our authorization server (WorkOS
 * AuthKit). It does NOT issue tokens and holds no secrets — it's public metadata.
 *
 * Served at /.well-known/oauth-protected-resource via a rewrite in vercel.json.
 * The token-validation + identity→CRM-key mapping lives in api/mcp.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { maxDuration: 10 };

/**
 * Canonical URI of the protected resource (this MCP server's endpoint).
 * Must match the `resource` the client indicates to the authorization server.
 */
function resourceUrl(): string {
  const explicit = (process.env.MCP_RESOURCE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  // Fall back to the Vercel-provided deployment URL, else the known prod URL.
  const vercel = (process.env.VERCEL_URL ?? "").trim();
  const base = vercel ? `https://${vercel}` : "https://vestlaunch-mcp.vercel.app";
  return `${base}/api/mcp`;
}

/** The AuthKit domain that runs login/consent and issues tokens. */
function authorizationServer(): string {
  return (process.env.WORKOS_AUTHKIT_DOMAIN ?? "").trim().replace(/\/+$/, "");
}

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

  const authServer = authorizationServer();
  if (!authServer) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "server_misconfigured",
        error_description: "WORKOS_AUTHKIT_DOMAIN is not set on the server.",
      }),
    );
    return;
  }

  const body = {
    resource: resourceUrl(),
    authorization_servers: [authServer],
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
