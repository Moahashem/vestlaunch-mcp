/**
 * Refresh and code exchange re-check the CRM key. A revoked key does not
 * receive a new access token, and the refusal does not contain the key.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-oauth-secret-16";
const KEY = "ffl_live_SUPERSECRETVALUE";

function formReq(body: URLSearchParams): IncomingMessage {
  const stream = Readable.from([Buffer.from(body.toString())]);
  return Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    url: "/token",
  }) as IncomingMessage;
}

function resCapture() {
  const res = {
    statusCode: 0,
    body: "",
    setHeader() {},
    end(body?: string) {
      res.body = body ?? "";
    },
  };
  return res;
}

beforeEach(() => {
  process.env.OAUTH_JWE_SECRET = SECRET;
  process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("token revocation", () => {
  it("does not mint a new access token for a revoked refresh token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 })),
    );
    const { mintRefreshToken } = await import("../../api/_oauth.js");
    const { default: handler } = await import("../../api/token.js");
    const refresh = await mintRefreshToken({ crmKey: KEY, clientId: "client" });
    const res = resCapture();
    await handler(
      formReq(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "client" })),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("invalid_grant");
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(res.body).not.toContain("access_token");
  });

  it("fails closed when the CRM cannot be reached to re-check the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(`network ${KEY}`);
      }),
    );
    const { mintRefreshToken } = await import("../../api/_oauth.js");
    const { default: handler } = await import("../../api/token.js");
    const refresh = await mintRefreshToken({ crmKey: KEY, clientId: "client" });
    const res = resCapture();
    await handler(
      formReq(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "client" })),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(res.body).not.toContain("access_token");
  });
});
