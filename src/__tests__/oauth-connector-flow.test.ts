/**
 * The Claude connector sign-in, end to end against the real handlers:
 * register -> /authorize (GET form, POST key) -> /token -> /api/mcp.
 * Also pins the redirect_uri allowlist that stops a sign-in link from
 * sending the code to an unknown site.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAccessToken, redirectUriAllowed } from "../../api/_oauth.js";
import authorize from "../../api/authorize.js";
import register from "../../api/oauth-register.js";
import token from "../../api/token.js";
import mcp from "../../api/mcp.js";

const KEY = "ffl_live_TESTFIXTUREKEY";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";

function resCapture() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = String(value);
    },
    end(body?: string) {
      res.body = body ?? "";
    },
    on() {
      return res;
    },
  };
  return res;
}

function request(method: string, url: string, body?: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  Object.assign(r, { method, url, headers: { host: "vestlaunch-mcp.vercel.app", ...headers } });
  return r;
}

function pkce() {
  const verifier = "v".repeat(50);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

beforeEach(() => {
  process.env.OAUTH_JWE_SECRET = "test-secret-at-least-16-chars";
  process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
});

afterEach(() => {
  delete process.env.OAUTH_JWE_SECRET;
  delete process.env.VESTLAUNCH_BASE_URL;
  delete process.env.OAUTH_REDIRECT_ALLOWLIST;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("redirectUriAllowed", () => {
  it("allows Claude's callbacks and loopback, nothing else by default", () => {
    expect(redirectUriAllowed(CLAUDE_CB, "")).toBe(true);
    expect(redirectUriAllowed("https://claude.com/api/mcp/auth_callback", "")).toBe(true);
    expect(redirectUriAllowed("http://localhost:33418/callback", "")).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:6274/oauth/callback", "")).toBe(true);

    expect(redirectUriAllowed("https://evil.example/cb", "")).toBe(false);
    expect(redirectUriAllowed("https://claude.ai.evil.example/api/mcp/auth_callback", "")).toBe(false);
    expect(redirectUriAllowed("https://claude.ai/other", "")).toBe(false);
    expect(redirectUriAllowed("http://claude.ai/api/mcp/auth_callback", "")).toBe(false);
    expect(redirectUriAllowed("https://user@claude.ai/api/mcp/auth_callback", "")).toBe(false);
    expect(redirectUriAllowed("javascript:alert(1)", "")).toBe(false);
    expect(redirectUriAllowed("not a url", "")).toBe(false);
  });

  it("honors exact URIs and origins from the env allowlist", () => {
    const extra = "https://app.example.com/oauth/cb, https://other.example.org";
    expect(redirectUriAllowed("https://app.example.com/oauth/cb", extra)).toBe(true);
    expect(redirectUriAllowed("https://app.example.com/elsewhere", extra)).toBe(false);
    expect(redirectUriAllowed("https://other.example.org/any/path", extra)).toBe(true);
    expect(redirectUriAllowed("http://other.example.org/any/path", extra)).toBe(false);
  });
});

describe("authorize blocks unknown redirect targets", () => {
  it("GET with an unknown redirect_uri shows no key form", async () => {
    const res = resCapture();
    const q = new URLSearchParams({ response_type: "code", redirect_uri: "https://evil.example/cb", code_challenge: "x" });
    await authorize(request("GET", `/authorize?${q}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("crm_key");
  });

  it("POST with an unknown redirect_uri never validates the key or mints a code", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = resCapture();
    const form = new URLSearchParams({
      response_type: "code",
      redirect_uri: "https://evil.example/cb",
      code_challenge: "x",
      crm_key: KEY,
    });
    await authorize(
      request("POST", "/authorize", form.toString(), { "content-type": "application/x-www-form-urlencoded" }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("Claude connector sign-in, end to end", () => {
  it("register -> authorize -> token -> /api/mcp acts with the signed-in key", async () => {
    const seenAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seenAuth.push(h.get("authorization") ?? "");
        if (String(url).endsWith("/api/v1/me")) {
          return new Response(
            JSON.stringify({ success: true, data: { email: "owner@example.invalid", scopes: ["*"], tools: [] } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }),
    );

    // 1. Dynamic client registration, as Claude does on first connect.
    const reg = resCapture();
    await register(
      request("POST", "/register", JSON.stringify({ redirect_uris: [CLAUDE_CB], client_name: "Claude" })),
      reg as unknown as ServerResponse,
    );
    expect(reg.statusCode).toBe(201);
    const clientId = (JSON.parse(reg.body) as { client_id: string }).client_id;
    expect(clientId).toBeTruthy();

    // 2. The sign-in page renders for Claude's callback.
    const { verifier, challenge } = pkce();
    const params = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: CLAUDE_CB,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "st-123",
      resource: "https://vestlaunch-mcp.vercel.app/api/mcp",
    };
    const page = resCapture();
    await authorize(request("GET", `/authorize?${new URLSearchParams(params)}`), page as unknown as ServerResponse);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="crm_key"');

    // 3. Pasting the key redirects back to Claude with a code and the state.
    const post = resCapture();
    await authorize(
      request("POST", "/authorize", new URLSearchParams({ ...params, crm_key: KEY }).toString()),
      post as unknown as ServerResponse,
    );
    expect(post.statusCode).toBe(302);
    const back = new URL(post.headers.location);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CB);
    expect(back.searchParams.get("state")).toBe("st-123");
    const code = back.searchParams.get("code") ?? "";
    expect(code).not.toContain("ffl_live_");

    // 4. Token exchange with the PKCE verifier.
    const tok = resCapture();
    await token(
      request(
        "POST",
        "/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: CLAUDE_CB,
          client_id: clientId,
        }).toString(),
      ),
      tok as unknown as ServerResponse,
    );
    expect(tok.statusCode).toBe(200);
    const tokens = JSON.parse(tok.body) as { access_token: string; refresh_token: string };
    expect(tokens.access_token).not.toContain("ffl_live_");
    expect((await readAccessToken(tokens.access_token)).crmKey).toBe(KEY);

    // A wrong verifier is refused.
    const bad = resCapture();
    await token(
      request("POST", "/token", new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "w".repeat(50) }).toString()),
      bad as unknown as ServerResponse,
    );
    expect(bad.statusCode).toBe(400);

    // 5. /api/mcp accepts the access token and calls the CRM with the key.
    seenAuth.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const mres = resCapture();
    await mcp(
      Object.assign(request("POST", "/api/mcp", undefined, { authorization: `Bearer ${tokens.access_token}` }), {
        body: undefined,
      }),
      mres as unknown as ServerResponse,
    ).catch(() => undefined); // transport needs a real socket; reaching the CRM is what we check
    expect(seenAuth[0]).toBe(`Bearer ${KEY}`);
  });
});
