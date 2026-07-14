/**
 * Shared crypto + helpers for VestLaunch's SELF-HOSTED OAuth 2.1 authorization
 * server. No third party involved — this server logs users in, issues its own
 * tokens, and validates them. (WorkOS is abandoned.)
 *
 * WHY JWE (encrypted JWT): Vercel is stateless (no DB). Instead of storing auth
 * codes / access tokens / refresh tokens in a database, we encode all the state
 * we need INSIDE the token itself, encrypted so only this server can read it.
 * The token wraps the user's CRM key (ffl_live_…), which therefore never appears
 * in cleartext anywhere in the client's stored credentials.
 *
 * All tokens are `dir` + `A256GCM` JWEs. A256GCM is authenticated encryption, so
 * a tampered token fails to decrypt — no separate signature check needed.
 *
 * Files prefixed `_` in api/ are NOT routed by Vercel but are still bundled as
 * imports, so this is a safe home for shared helpers.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { EncryptJWT, jwtDecrypt } from "jose";

// ───────────────────────── key derivation ─────────────────────────

/**
 * Derive a stable 32-byte (256-bit) key from the OAUTH_JWE_SECRET env var via
 * SHA-256. Any length secret works; we always end up with exactly 32 bytes,
 * which is what A256GCM requires.
 */
let cachedKey: Uint8Array | null = null;
function encKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const secret = (process.env.OAUTH_JWE_SECRET ?? "").trim();
  if (!secret) throw new Error("Missing env: OAUTH_JWE_SECRET");
  if (secret.length < 16) {
    throw new Error("OAUTH_JWE_SECRET is too short — use at least 16 characters");
  }
  cachedKey = new Uint8Array(createHash("sha256").update(secret).digest());
  return cachedKey;
}

// ───────────────────────── base URL / issuer ─────────────────────────

/**
 * Public base URL of this deployment (no trailing slash), e.g.
 * "https://vestlaunch-mcp.vercel.app". Used as the OAuth `issuer` and to build
 * the authorize/token/register endpoint URLs in metadata.
 *
 * Preference order:
 *   1. MCP_RESOURCE_URL (explicit, strips a trailing /api/mcp) — most reliable.
 *   2. The request's forwarded host/proto headers — correct per-request even on
 *      preview deployments.
 *   3. The known production URL as a last resort.
 *
 * We derive from request headers (not VERCEL_URL) because VERCEL_URL is the
 * deployment-specific hostname and would make issuer/metadata URLs mismatch the
 * host the client actually connected to.
 */
export function baseUrl(req?: IncomingMessage): string {
  const explicit = (process.env.MCP_RESOURCE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit.replace(/\/api\/mcp$/, "");

  if (req) {
    const h = req.headers;
    const host =
      (typeof h["x-forwarded-host"] === "string" && h["x-forwarded-host"]) ||
      (typeof h["host"] === "string" && h["host"]) ||
      "";
    const proto =
      (typeof h["x-forwarded-proto"] === "string" && h["x-forwarded-proto"].split(",")[0]) ||
      "https";
    if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  }

  const vercel = (process.env.VERCEL_URL ?? "").trim();
  if (vercel) return `https://${vercel}`;
  return "https://vestlaunch-mcp.vercel.app";
}

/** The canonical resource identifier this AS issues tokens for (the MCP endpoint). */
export function resourceUrl(req?: IncomingMessage): string {
  return `${baseUrl(req)}/api/mcp`;
}

// ───────────────────────── token minting / reading ─────────────────────────
//
// Three token kinds, distinguished by the `tt` (token type) claim so a token of
// one kind can never be replayed as another:
//   - "code"    short-lived authorization code (carries PKCE + request context)
//   - "access"  bearer token presented to /api/mcp (carries the CRM key)
//   - "refresh" long-lived token exchanged at /token for a fresh access token

const CODE_TTL = "10m";
const ACCESS_TTL = "1h";
const REFRESH_TTL = "30d";

export interface AuthCodePayload {
  /** The CRM key the user proved they own during login. */
  crmKey: string;
  clientId: string;
  redirectUri: string;
  /** PKCE code challenge (S256) + method, verified at the token endpoint. */
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
  /** RFC 8707 resource indicator, if the client sent one. */
  resource?: string;
}

export interface AccessPayload {
  crmKey: string;
  clientId?: string;
  scope?: string;
}

export interface RefreshPayload {
  crmKey: string;
  clientId: string;
  scope?: string;
}

async function encrypt(
  claims: Record<string, unknown>,
  tt: "code" | "access" | "refresh",
  ttl: string,
  issuer: string,
): Promise<string> {
  return await new EncryptJWT({ ...claims, tt })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setExpirationTime(ttl)
    .encrypt(encKey());
}

async function decrypt<T>(token: string, tt: "code" | "access" | "refresh"): Promise<T> {
  // jwtDecrypt verifies A256GCM integrity AND enforces exp. We do NOT verify
  // issuer on decrypt: A256GCM already proves WE minted it, and the issuer host
  // can legitimately vary across preview vs prod deployments.
  const { payload } = await jwtDecrypt(token, encKey());
  if (payload.tt !== tt) throw new Error(`Wrong token type: expected ${tt}, got ${String(payload.tt)}`);
  return payload as unknown as T;
}

// Authorization code ────────────────────────────
export function mintAuthCode(p: AuthCodePayload, req?: IncomingMessage): Promise<string> {
  return encrypt({ ...p }, "code", CODE_TTL, baseUrl(req));
}
export function readAuthCode(token: string): Promise<AuthCodePayload & { tt: string }> {
  return decrypt<AuthCodePayload & { tt: string }>(token, "code");
}

// Access token ────────────────────────────
export function mintAccessToken(p: AccessPayload, req?: IncomingMessage): Promise<string> {
  return encrypt({ ...p }, "access", ACCESS_TTL, baseUrl(req));
}
export function readAccessToken(token: string): Promise<AccessPayload & { tt: string }> {
  return decrypt<AccessPayload & { tt: string }>(token, "access");
}

// Refresh token ────────────────────────────
export function mintRefreshToken(p: RefreshPayload, req?: IncomingMessage): Promise<string> {
  return encrypt({ ...p }, "refresh", REFRESH_TTL, baseUrl(req));
}
export function readRefreshToken(token: string): Promise<RefreshPayload & { tt: string }> {
  return decrypt<RefreshPayload & { tt: string }>(token, "refresh");
}

// ───────────────────────── PKCE verification ─────────────────────────

/**
 * Verify an RFC 7636 PKCE code_verifier against the stored code_challenge.
 * Supports S256 (required by OAuth 2.1) and plain (fallback if a client ever
 * registers it — Claude uses S256).
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: string,
): boolean {
  if (!verifier || !challenge) return false;
  if (method === "plain") return verifier === challenge;
  // S256: BASE64URL(SHA256(verifier)) === challenge
  const hash = createHash("sha256").update(verifier).digest();
  const computed = Buffer.from(hash)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return computed === challenge;
}

// ───────────────────────── CRM key validation ─────────────────────────

/** CRM keys minted in Settings → API Keys always start with this. */
export const CRM_KEY_PREFIX = "ffl_live_";

/**
 * Validate a CRM key by calling the CRM's /api/v1/me. Returns the identity on
 * success, or null if the key is invalid/revoked. This is the "login" check:
 * a user proves they own a key by pasting it and us confirming it with the CRM.
 */
export async function validateCrmKey(
  crmKey: string,
): Promise<{ ok: boolean; identity?: { email?: string; name?: string; id?: string } }> {
  const baseCrm = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseCrm) throw new Error("Missing env: VESTLAUNCH_BASE_URL");
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseCrm}/api/v1/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${crmKey}`,
        "Content-Type": "application/json",
        "User-Agent": "vestlaunch-mcp-oauth/0.1.0",
      },
      signal: controller.signal,
    });
    if (!r.ok) return { ok: false };
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    return {
      ok: true,
      identity: {
        email: typeof data.email === "string" ? data.email : undefined,
        name: typeof data.name === "string" ? data.name : undefined,
        id: typeof data.id === "string" ? data.id : undefined,
      },
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
