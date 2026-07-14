/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) for VestLaunch's
 * self-hosted authorization server.
 *
 * WHY THIS EXISTS: Claude Desktop doesn't have a pre-arranged client_id with us.
 * On first connect it POSTs its metadata here (redirect_uris, client_name, …)
 * and expects a client_id back. Because Vercel is stateless (no DB), we do NOT
 * persist registrations. We mint a random client_id and return it. That is safe
 * here because:
 *   - We are a PUBLIC-client AS: there is no client_secret to protect.
 *   - PKCE (S256) is what actually secures the authorization-code exchange, and
 *     it's verified at /token against the code we minted — not against any
 *     stored client record.
 *   - The redirect_uri the client will use is carried inside the encrypted auth
 *     code and re-checked at /token, so a client_id can't be abused to redirect
 *     a code elsewhere.
 *
 * Served at /register via a rewrite in vercel.json.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { maxDuration: 10 };

interface RegistrationRequest {
  redirect_uris?: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
}

/** Read and JSON-parse the request body. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const meta = (await readJson(req)) as RegistrationRequest;

  const redirectUris = Array.isArray(meta.redirect_uris)
    ? meta.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];

  if (redirectUris.length === 0) {
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: "invalid_client_metadata",
        error_description: "redirect_uris is required",
      }),
    );
    return;
  }

  // Random, non-persisted public-client identifier.
  const clientId = `vlc_${randomBytes(16).toString("hex")}`;
  const issuedAt = Math.floor(Date.now() / 1000);

  const body = {
    client_id: clientId,
    // No secret — public client.
    client_id_issued_at: issuedAt,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types:
      Array.isArray(meta.grant_types) && meta.grant_types.length > 0
        ? meta.grant_types
        : ["authorization_code", "refresh_token"],
    response_types:
      Array.isArray(meta.response_types) && meta.response_types.length > 0
        ? meta.response_types
        : ["code"],
    client_name:
      typeof meta.client_name === "string" ? meta.client_name : "MCP Client",
    scope: typeof meta.scope === "string" ? meta.scope : "openid profile email",
  };

  res.statusCode = 201;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
