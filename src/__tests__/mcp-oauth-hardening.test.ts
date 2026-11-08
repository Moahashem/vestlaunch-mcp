/**
 * OAuth hardening that does not depend on a durable store:
 * redirect_uri, S256-only PKCE, and refresh tokens bound to client_id.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateRedirectUri, verifyPkce } from "../../api/_oauth.js";

const SECRET = "test-oauth-secret-16";
const KEY = "ffl_live_SUPERSECRETVALUE";

function formReq(body: URLSearchParams): IncomingMessage {
  const stream = Readable.from([Buffer.from(body.toString())]);
  return Object.assign(stream, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, url: "/token" }) as IncomingMessage;
}

function resCapture() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res;
}

describe("redirect and PKCE", () => {
  it("allows loopback and https and rejects an open redirect", () => {
    expect(validateRedirectUri("http://127.0.0.1:3847/callback")).toBe(true);
    expect(validateRedirectUri("http://localhost:1/cb")).toBe(true);
    expect(validateRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validateRedirectUri("cursor://anysphere.cursor-mcp/callback")).toBe(true);
    expect(validateRedirectUri("http://evil.example/cb")).toBe(false);
    expect(validateRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validateRedirectUri("https://user:pass@claude.ai/cb")).toBe(false);
    expect(validateRedirectUri("https://claude.ai/cb#frag")).toBe(false);
  });

  it("rejects the plain PKCE method", () => {
    expect(verifyPkce("same", "same", "plain")).toBe(false);
    const challenge = createHash("sha256").update("verifier").digest().toString("base64url");
    expect(verifyPkce("verifier", challenge, "S256")).toBe(true);
  });
});

describe("refresh client binding", () => {
  beforeEach(() => {
    process.env.OAUTH_JWE_SECRET = SECRET;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not exchange an authorization code while no durable store exists", async () => {
    process.env.OAUTH_CODE_STORE = "memory";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { mintAuthCode } = await import("../../api/_oauth.js");
    const { default: handler } = await import("../../api/token.js");
    const code = await mintAuthCode({
      crmKey: KEY,
      clientId: "client-a",
      redirectUri: "http://127.0.0.1:9/callback",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
    });
    const res = resCapture();
    await handler(
      formReq(new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "verifier",
        client_id: "client-a",
        redirect_uri: "http://127.0.0.1:9/callback",
      })),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("disabled");
    expect(res.body).not.toContain("access_token");
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("advertises refresh only while authorization codes are disabled", async () => {
    const { default: metadata } = await import("../../api/oauth-authorization-server.js");
    const res = resCapture();
    metadata({ method: "GET", headers: {}, url: "/.well-known/oauth-authorization-server" } as IncomingMessage, res as unknown as ServerResponse);
    const body = JSON.parse(res.body) as { grant_types_supported: string[]; response_types_supported: string[] };
    expect(body.grant_types_supported).toEqual(["refresh_token"]);
    expect(body.response_types_supported).toEqual([]);
  });

  it("rejects a refresh presented by a different client and does not echo the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { mintRefreshToken } = await import("../../api/_oauth.js");
    const { default: handler } = await import("../../api/token.js");
    const refresh = await mintRefreshToken({ crmKey: KEY, clientId: "client-a" });
    const res = resCapture();
    await handler(
      formReq(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "client-b" })),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("client_id");
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(res.body).not.toContain("access_token");
  });
});
