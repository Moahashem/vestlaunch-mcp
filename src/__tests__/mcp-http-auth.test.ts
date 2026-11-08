/**
 * The hosted endpoint's fail-closed credential checks, using a fixture key.
 * No live CRM call is made.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EncryptJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-oauth-secret-16";
const KEY = "ffl_live_SUPERSECRETVALUE";

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
    on() {
      return res;
    },
  };
  return res;
}

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {}, url: "/api/mcp" } as IncomingMessage;
}

beforeEach(() => {
  process.env.OAUTH_JWE_SECRET = SECRET;
  process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
  delete process.env.WORKOS_AUTHKIT_DOMAIN;
  delete process.env.MCP_BEARER_TOKEN;
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("hosted MCP credentials", () => {
  it("rejects a missing credential and points the client at discovery", async () => {
    const { default: handler } = await import("../../api/mcp.js");
    const res = resCapture();
    await handler(req(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("oauth-protected-resource");
    expect(res.body).not.toContain(KEY);
  });

  it("rejects a credential that is not a CRM key or a token we minted", async () => {
    const { default: handler } = await import("../../api/mcp.js");
    const res = resCapture();
    await handler(req("Bearer not-a-token"), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Invalid or expired");
    expect(res.body).not.toContain("not-a-token");
  });

  it("rejects an expired access token", async () => {
    const encryptKey = createHash("sha256").update(SECRET).digest();
    const expired = await new EncryptJWT({ tt: "access", crmKey: KEY })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .encrypt(encryptKey);
    const { default: handler } = await import("../../api/mcp.js");
    const res = resCapture();
    await handler(req(`Bearer ${expired}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(KEY);
    expect(res.body).not.toContain(expired);
  });

  it("rejects a revoked CRM key and does not echo it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: `revoked ${KEY}` }), { status: 401 })),
    );
    const { default: handler } = await import("../../api/mcp.js");
    const res = resCapture();
    await handler(req(`Bearer ${KEY}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("revoked");
    expect(res.body).not.toContain("SUPERSECRETVALUE");
  });

  it("redacts a credential if the CRM puts one in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: `upstream ${KEY}` }), { status: 500 })),
    );
    const { default: handler } = await import("../../api/mcp.js");
    const res = resCapture();
    await handler(req(`Bearer ${KEY}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("SUPERSECRETVALUE");
    expect(res.body).toContain("ffl_live_[redacted]");
  });
});
