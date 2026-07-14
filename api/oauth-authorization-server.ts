/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414) for VestLaunch's
 * SELF-HOSTED authorization server. No third party.
 *
 * WHY THIS EXISTS: after a client reads the protected-resource metadata
 * (api/oauth-protected-resource.ts) and learns WHICH authorization server to
 * use, it fetches THIS document to learn that server's endpoint URLs — where to
 * send the user to log in (/authorize), where to swap a code for a token
 * (/token), and where to register itself (/register). We are that authorization
 * server, so every URL below points back at this same deployment.
 *
 * Served at /.well-known/oauth-authorization-server via a rewrite in vercel.json.
 * Public metadata: no secrets, cacheable.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { baseUrl } from "./_oauth";

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

  const base = baseUrl(req);

  const body = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    // We are a public-client AS: PKCE is required, no client secrets.
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["openid", "profile", "email"],
    // RFC 8707 — we honor a resource indicator if the client sends one.
    resource_indicators_supported: true,
  };

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "public, max-age=3600");
  res.end(JSON.stringify(body));
}
