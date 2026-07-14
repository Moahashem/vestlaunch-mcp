/**
 * /token — the token endpoint of VestLaunch's self-hosted OAuth 2.1
 * authorization server.
 *
 * TWO GRANTS:
 *   grant_type=authorization_code
 *     Body: code, code_verifier, redirect_uri, client_id
 *     → decrypt the authorization code (readAuthCode), verify PKCE
 *       (code_verifier vs the challenge baked into the code) and that the
 *       redirect_uri matches the one baked in. On success, mint a fresh
 *       access-token JWE (carries the CRM key) + a refresh-token JWE.
 *
 *   grant_type=refresh_token
 *     Body: refresh_token, client_id
 *     → decrypt the refresh token (readRefreshToken) and mint a fresh
 *       access token (+ rotated refresh token) from the CRM key it carries.
 *
 * The CRM key never appears in cleartext in any response — it lives only
 * inside the encrypted access/refresh tokens.
 *
 * Response (JSON): { access_token, token_type: "Bearer", expires_in,
 *                    refresh_token, scope }
 *
 * Served at /token via a rewrite in vercel.json.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  mintAccessToken,
  mintRefreshToken,
  readAuthCode,
  readRefreshToken,
  verifyPkce,
} from "./_oauth";

export const config = { maxDuration: 30 };

// Access token lifetime in seconds — must match ACCESS_TTL ("1h") in _oauth.ts.
const EXPIRES_IN = 3600;

/** Read a form-urlencoded POST body. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Send a JSON error in the OAuth 2.0 shape (RFC 6749 §5.2). */
function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  description?: string,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.end(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }));
}

/** Send a successful token response. */
function sendTokens(
  res: ServerResponse,
  accessToken: string,
  refreshToken: string,
  scope?: string,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  res.end(
    JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: EXPIRES_IN,
      refresh_token: refreshToken,
      ...(scope ? { scope } : {}),
    }),
  );
}

// ───────────────────────── handler ─────────────────────────

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Public token endpoint — allow any origin and preflight.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendError(res, 405, "invalid_request", "Use POST.");
    return;
  }

  const form = await readForm(req);
  const grantType = form.get("grant_type") ?? "";

  // ── authorization_code grant ──
  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const codeVerifier = form.get("code_verifier") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";

    if (!code) {
      sendError(res, 400, "invalid_request", "Missing code.");
      return;
    }
    if (!codeVerifier) {
      sendError(res, 400, "invalid_request", "Missing code_verifier (PKCE).");
      return;
    }

    let payload;
    try {
      payload = await readAuthCode(code);
    } catch {
      sendError(res, 400, "invalid_grant", "The authorization code is invalid or expired.");
      return;
    }

    // PKCE: the verifier the client now presents must match the challenge
    // that was baked into the code at /authorize.
    if (!verifyPkce(codeVerifier, payload.codeChallenge, payload.codeChallengeMethod)) {
      sendError(res, 400, "invalid_grant", "PKCE verification failed.");
      return;
    }

    // The redirect_uri, if sent, must match the one baked into the code.
    if (redirectUri && redirectUri !== payload.redirectUri) {
      sendError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request.");
      return;
    }

    const accessToken = await mintAccessToken(
      { crmKey: payload.crmKey, clientId: payload.clientId, scope: payload.scope },
      req,
    );
    const refreshToken = await mintRefreshToken(
      { crmKey: payload.crmKey, clientId: payload.clientId, scope: payload.scope },
      req,
    );
    sendTokens(res, accessToken, refreshToken, payload.scope);
    return;
  }

  // ── refresh_token grant ──
  if (grantType === "refresh_token") {
    const token = form.get("refresh_token") ?? "";
    if (!token) {
      sendError(res, 400, "invalid_request", "Missing refresh_token.");
      return;
    }

    let payload;
    try {
      payload = await readRefreshToken(token);
    } catch {
      sendError(res, 400, "invalid_grant", "The refresh token is invalid or expired.");
      return;
    }

    const accessToken = await mintAccessToken(
      { crmKey: payload.crmKey, clientId: payload.clientId, scope: payload.scope },
      req,
    );
    // Rotate the refresh token.
    const refreshToken = await mintRefreshToken(
      { crmKey: payload.crmKey, clientId: payload.clientId, scope: payload.scope },
      req,
    );
    sendTokens(res, accessToken, refreshToken, payload.scope);
    return;
  }

  sendError(
    res,
    400,
    "unsupported_grant_type",
    `Unsupported grant_type: ${grantType || "(none)"}`,
  );
}
