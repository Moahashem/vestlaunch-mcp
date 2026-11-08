/**
 * Credential class is a fixed word on stdout. The auth responses stay the
 * ones this handler already returned.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { classifyPresentedCredential, mcpCredentialClassLine } from "../../api/mcp.js";

const SECRET = "ffl_live_SUPERSECRETVALUE";
const SHARED = "shared-fixture-token";

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

function req(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {}, url: "/api/mcp" } as IncomingMessage;
}

afterEach(() => {
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.VESTLAUNCH_API_KEY;
  delete process.env.VESTLAUNCH_BASE_URL;
  delete process.env.WORKOS_AUTHKIT_DOMAIN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("classifyPresentedCredential", () => {
  it("uses only the four class names, and legacy wins over a key-shaped token", () => {
    expect(mcpCredentialClassLine("shared_bearer")).toBe("mcp_credential_class=shared_bearer\n");
    expect(mcpCredentialClassLine("crm_key")).toBe("mcp_credential_class=crm_key\n");
    expect(mcpCredentialClassLine("oauth")).toBe("mcp_credential_class=oauth\n");
    expect(mcpCredentialClassLine("rejected")).toBe("mcp_credential_class=rejected\n");
    expect(
      classifyPresentedCredential({ bearer: "", legacyToken: SHARED, crmKeyPrefix: "ffl_live_", oauthUnwrapped: false }),
    ).toBe("rejected");
    expect(
      classifyPresentedCredential({ bearer: SHARED, legacyToken: SHARED, crmKeyPrefix: "ffl_live_", oauthUnwrapped: false }),
    ).toBe("shared_bearer");
    expect(
      classifyPresentedCredential({
        bearer: SECRET,
        legacyToken: SECRET,
        crmKeyPrefix: "ffl_live_",
        oauthUnwrapped: false,
      }),
    ).toBe("shared_bearer");
    expect(
      classifyPresentedCredential({ bearer: SECRET, legacyToken: "", crmKeyPrefix: "ffl_live_", oauthUnwrapped: false }),
    ).toBe("crm_key");
    expect(
      classifyPresentedCredential({ bearer: "opaque-token", legacyToken: "", crmKeyPrefix: "ffl_live_", oauthUnwrapped: true }),
    ).toBe("oauth");
    expect(
      classifyPresentedCredential({ bearer: "opaque-token", legacyToken: "", crmKeyPrefix: "ffl_live_", oauthUnwrapped: false }),
    ).toBe("rejected");
  });
});

describe("handler auth is unchanged aside from the class line", () => {
  async function capture(run: () => Promise<void>) {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    await run();
    spy.mockRestore();
    return lines.join("");
  }

  it("rejects a missing credential with 401 and logs rejected only", async () => {
    const res = resCapture();
    const logged = await capture(() => handler(req(), res as unknown as ServerResponse));
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("resource_metadata");
    expect(logged).toBe("mcp_credential_class=rejected\n");
    expect(res.body).not.toContain("ffl_");
  });

  it("rejects an unrecognized bearer with 401 and does not log the token", async () => {
    const res = resCapture();
    const logged = await capture(() => handler(req("Bearer opaque-token"), res as unknown as ServerResponse));
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Invalid or expired");
    expect(logged).toBe("mcp_credential_class=rejected\n");
    expect(logged).not.toContain("opaque-token");
    expect(res.body).not.toContain("opaque-token");
  });

  it("logs crm_key and still returns the revoked-key 401", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: `nope ${SECRET}` }), { status: 401 })));
    const res = resCapture();
    const logged = await capture(() => handler(req(`Bearer ${SECRET}`), res as unknown as ServerResponse));
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain("Invalid or revoked API key");
    expect(logged).toBe("mcp_credential_class=crm_key\n");
    expect(logged).not.toContain(SECRET);
    expect(res.body).not.toContain("SUPERSECRETVALUE");
  });

  it("logs shared_bearer and still fails the same way when the env key is missing", async () => {
    process.env.MCP_BEARER_TOKEN = SHARED;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const res = resCapture();
    const logged = await capture(() => handler(req(`Bearer ${SHARED}`), res as unknown as ServerResponse));
    expect(res.statusCode).toBe(500);
    expect(res.body).toContain("VESTLAUNCH_API_KEY");
    expect(logged).toBe("mcp_credential_class=shared_bearer\n");
    expect(logged).not.toContain(SHARED);
    expect(res.body).not.toContain(SHARED);
  });
});
