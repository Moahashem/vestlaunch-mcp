/**
 * Existing /api/mcp stays as it is unless the CRM marked the key onboarding.
 * The onboarding route is the only strict surface, and it has no data tools.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const oauth = vi.hoisted(() => ({
  readAccessToken: vi.fn(async (_token: string) => {
    throw new Error("not an oauth token");
  }),
}));
vi.mock("../../api/_oauth.js", () => ({
  readAccessToken: oauth.readAccessToken,
}));

import { argumentsStayInsideOnboarding, legacySurfaceDecision, onboardingAllows, readOnboardingClaims } from "../../api/_mcp-onboarding-policy.js";
import mcp from "../../api/mcp.js";
import onboarding from "../../api/mcp-onboarding.js";
import migration from "../../api/company-numbers-agent-migration.js";
import sheets from "../../api/sheets-mcp.js";

const KEY = "ffl_live_SCOPEDBOTVALUE";
const SHARED = "shared-fixture-token";
const ENV_KEY = "ffl_live_PRIVILEGEDVALUE";

function resCapture() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = String(value);
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) {
        for (const [key, value] of Object.entries(headers)) res.headers[key.toLowerCase()] = String(value);
      }
      return res;
    },
    write(chunk?: string | Uint8Array) {
      res.body += typeof chunk === "string" ? chunk : Buffer.from(chunk ?? new Uint8Array()).toString();
      return true;
    },
    end(body?: string) {
      if (body) res.body += body;
    },
    on() {
      return res;
    },
  };
  return res;
}

function req(authorization?: string, body?: unknown): IncomingMessage & { body?: unknown } {
  return { headers: authorization ? { authorization } : {}, url: "/api/mcp-onboarding", body } as IncomingMessage & { body?: unknown };
}

async function post(
  handler: (request: IncomingMessage & { body?: unknown }, response: ServerResponse) => Promise<void>,
  path: string,
  authorization: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const parsed = Buffer.concat(chunks).toString();
      void handler(Object.assign(request, { body: parsed ? JSON.parse(parsed) : undefined }), response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const classified = {
  mcpProfile: "onboarding",
  scopes: ["mcp:onboarding"],
  business: "ffl",
  workspaceIds: ["ws_ffl"],
  name: "Cranbrook Forest",
};

afterEach(() => {
  delete process.env.MCP_BEARER_TOKEN;
  delete process.env.VESTLAUNCH_API_KEY;
  delete process.env.VESTLAUNCH_BASE_URL;
  delete process.env.WORKOS_AUTHKIT_DOMAIN;
  delete process.env.COMPANY_NUMBERS_MIGRATION_API_KEY_ID;
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  oauth.readAccessToken.mockReset();
  oauth.readAccessToken.mockImplementation(async () => {
    throw new Error("not an oauth token");
  });
});

describe("legacy /api/mcp profile gate", () => {
  it("leaves an unmarked key, including a display name, on the existing surface", () => {
    expect(legacySurfaceDecision({ scopes: ["*"], name: "Cranbrook Forest" }).ok).toBe(true);
    expect(legacySurfaceDecision({ scopes: ["properties:read"], business: "ffl", workspaceIds: ["ws_ffl"] }).ok).toBe(true);
    expect(legacySurfaceDecision(undefined).ok).toBe(false);
    expect(legacySurfaceDecision(null).ok).toBe(false);
  });

  it("refuses a server-marked onboarding key and a malformed profile", () => {
    expect(legacySurfaceDecision(classified).ok).toBe(false);
    expect(legacySurfaceDecision({ mcpProfile: "legacy", scopes: ["*"] }).ok).toBe(false);
  });

  it("still lists a manifest tool when the key is not marked onboarding", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://crm.example.invalid")) {
        return new Response(JSON.stringify({
          data: {
            identity: { scopes: ["contacts:read"], name: "Existing" },
            capabilities: [{ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List." }],
          },
        }), { status: 200 });
      }
      return realFetch(url, init);
    }));
    const result = await post(mcp, "/api/mcp", `Bearer ${KEY}`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(result.status).not.toBe(403);
    expect(result.text).toContain("list_contacts");
    expect(result.text).not.toContain("PRIVILEGEDVALUE");
    expect(result.text).not.toContain("SCOPEDBOTVALUE");
  });

  it("does not serve /api/mcp for an onboarding key and does not use the env key", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      data: { identity: classified, capabilities: [{ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List." }] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = resCapture();
    await mcp(req(`Bearer ${KEY}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("onboarding MCP");
    expect(res.body).not.toContain("list_contacts");
    expect(res.body).not.toContain("SCOPEDBOTVALUE");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("onboarding route", () => {
  it("rejects the shared bearer before calling the CRM", async () => {
    process.env.MCP_BEARER_TOKEN = SHARED;
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const res = resCapture();
    await onboarding(req(`Bearer ${SHARED}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join("")).toBe("mcp_onboarding_class=rejected\n");
    expect(lines.join("")).not.toContain(SHARED);
  });

  it("does not treat an unclassified or name-only key as onboarded", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { identity: { scopes: ["*"], name: "Cranbrook Forest" } },
    }), { status: 200 })));
    const res = resCapture();
    await onboarding(req(`Bearer ${KEY}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("not marked");
    expect(readOnboardingClaims({ scopes: ["*"], name: "Cranbrook Forest" }).ok).toBe(false);
  });

  it("requires classified claims and exposes only connection_status", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://crm.example.invalid")) {
        return new Response(JSON.stringify({ data: { identity: classified } }), { status: 200 });
      }
      return realFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await post(onboarding, "/api/mcp-onboarding", `Bearer ${KEY}`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(result.status).not.toBe(403);
    expect(result.text).toContain("connection_status");
    expect(result.text).not.toContain("list_contacts");
    expect(result.text).not.toContain("get_ffl_occupancy");
    expect(result.text).not.toContain("SCOPEDBOTVALUE");
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("crm.example.invalid"))).toHaveLength(1);
    expect(onboardingAllows("owner_billing")).toBe(false);
    expect(onboardingAllows("connection_status")).toBe(true);
  });

  it("a tools query cannot add a data tool", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://crm.example.invalid")) {
        return new Response(JSON.stringify({ data: { identity: classified } }), { status: 200 });
      }
      return realFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await post(
      onboarding,
      "/api/mcp-onboarding?tools=list_contacts,get_ffl_occupancy",
      `Bearer ${KEY}`,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_contacts", arguments: { tools: "list_contacts" } } },
    );
    expect(result.text).toContain("outside the onboarding allowlist");
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("crm.example.invalid"))).toHaveLength(1);
  });

  it("rejects selector objects and does not echo them, and keeps a workspace UUID intact", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const identity = { ...classified, workspaceIds: ["550e8400-e29b-41d4-a716-446655440000"] };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://crm.example.invalid")) {
        return new Response(JSON.stringify({ data: { identity } }), { status: 200 });
      }
      return realFetch(url, init);
    }));
    const nested: Record<string, unknown> = { note: "ok" };
    let cursor = nested;
    for (let i = 0; i < 7; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.inner = next;
      cursor = next;
    }
    cursor.workspaceIds = ["not-a-workspace"];
    expect(argumentsStayInsideOnboarding(nested)).toBe(false);
    expect(argumentsStayInsideOnboarding({ filters: { workspaceId: { id: "ws_ffl" } } })).toBe(false);
    const rejected = await post(onboarding, "/api/mcp-onboarding", `Bearer ${KEY}`, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "connection_status", arguments: { filters: { businessId: ["ffl"], marker: "not-a-workspace" } } },
    });
    expect(rejected.text).toContain("outside the onboarding allowlist");
    expect(rejected.text).not.toContain("not-a-workspace");
    const status = await post(onboarding, "/api/mcp-onboarding", `Bearer ${KEY}`, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "connection_status", arguments: {} },
    });
    expect(status.text).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(status.text).toContain("dataRoutesCleared");
    expect(status.text).not.toContain("/api/v1/");
  });

  it("refuses a shared bearer that also looks like a CRM key", async () => {
    process.env.MCP_BEARER_TOKEN = "ffl_live_SHAREDBEARER";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = resCapture();
    await onboarding(req("Bearer ffl_live_SHAREDBEARER"), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a display name used as the business claim", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { identity: { ...classified, business: "Cranbrook Forest" } },
    }), { status: 200 })));
    const res = resCapture();
    await onboarding(req(`Bearer ${KEY}`), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("business must be");
    expect(readOnboardingClaims({ ...classified, scopes: ["*"] }).ok).toBe(false);
    expect(readOnboardingClaims({ ...classified, scopes: ["properties:read"] }).ok).toBe(false);
    expect(readOnboardingClaims({ ...classified, workspaceIds: ["ffl"] }).ok).toBe(false);
    expect(readOnboardingClaims({ ...classified, businesses: ["both"] }).ok).toBe(false);
    expect(readOnboardingClaims({ ...classified, business: "both", businesses: ["ffl"] }).ok).toBe(false);
  });

  it("refuses a malformed profile on both routes", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { identity: { mcpProfile: ["onboarding"], scopes: ["*"], business: "ffl", workspaceIds: ["ws_ffl"] } },
    }), { status: 200 })));
    const legacy = resCapture();
    await mcp(req(`Bearer ${KEY}`), legacy as unknown as ServerResponse);
    expect(legacy.statusCode).toBe(403);
    const scoped = resCapture();
    await onboarding(req(`Bearer ${KEY}`), scoped as unknown as ServerResponse);
    expect(scoped.statusCode).toBe(403);
    expect(scoped.body).not.toContain("PRIVILEGEDVALUE");
  });

  it("keeps an unmarked OAuth grant on /api/mcp and blocks one the CRM marked onboarding", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    oauth.readAccessToken.mockImplementation(async (token: string) => {
      if (token !== "oauth-fixture") throw new Error("no");
      return { crmKey: KEY, tt: "access" };
    });
    const realFetch = globalThis.fetch;
    let identity: unknown = { scopes: ["contacts:read"], name: "Existing" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://crm.example.invalid")) {
        return new Response(JSON.stringify({
          data: {
            identity,
            capabilities: [{ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List." }],
          },
        }), { status: 200 });
      }
      return realFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    const open = await post(mcp, "/api/mcp", "Bearer oauth-fixture", { jsonrpc: "2.0", id: 6, method: "tools/list" });
    expect(open.text).toContain("list_contacts");
    identity = classified;
    const closed = await post(mcp, "/api/mcp", "Bearer oauth-fixture", { jsonrpc: "2.0", id: 7, method: "tools/list" });
    expect(closed.status).toBe(403);
    expect(closed.text).not.toContain("list_contacts");
    const authorizations = fetchMock.mock.calls
      .filter((call) => String(call[0]).includes("crm.example.invalid"))
      .map((call) => (call[1] as RequestInit).headers as Record<string, string>);
    expect(authorizations.every((headers) => headers.Authorization === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.stringify(authorizations)).not.toContain("PRIVILEGEDVALUE");
  });

  it("does not grant tools when identity is null or missing", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { identity: null, capabilities: [{ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List." }] },
    }), { status: 200 })));
    const missing = resCapture();
    await mcp(req(`Bearer ${KEY}`), missing as unknown as ServerResponse);
    expect(missing.statusCode).toBe(403);
    expect(missing.body).toContain("malformed");
    expect(missing.body).not.toContain("list_contacts");
    const onboard = resCapture();
    await onboarding(req(`Bearer ${KEY}`), onboard as unknown as ServerResponse);
    expect(onboard.statusCode).toBe(403);
    expect(onboard.body).toContain("malformed");
  });

  it("treats a string or array identity as malformed on both HTTP routes", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: { identity: "Cranbrook Forest", capabilities: [] },
    }), { status: 200 })));
    const legacy = resCapture();
    await mcp(req(`Bearer ${KEY}`), legacy as unknown as ServerResponse);
    expect(legacy.statusCode).toBe(403);
    const scoped = resCapture();
    await onboarding(req(`Bearer ${KEY}`), scoped as unknown as ServerResponse);
    expect(scoped.statusCode).toBe(403);
    expect(legacy.body).not.toContain("PRIVILEGEDVALUE");
  });

  it("does not let a marked key list sheet tools", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.VESTLAUNCH_API_KEY = ENV_KEY;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: {
        identity: classified,
        capabilities: [{ name: "sheets_read", method: "GET", path: "/api/v1/sheets/read", scope: "properties:read", description: "Read." }],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = resCapture();
    const request = req(`Bearer ${KEY}`);
    request.url = "/api/sheets-mcp";
    await sheets(request, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("sheets_read");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
  });

  it("does not let an onboarding key use the company-numbers inspection route", async () => {
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    process.env.COMPANY_NUMBERS_MIGRATION_API_KEY_ID = "key_admin";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("anthropic.com")) throw new Error("anthropic must not be called");
      return new Response(JSON.stringify({
        data: { identity: { ...classified, apiKeyId: "key_admin", scopes: ["*"] } },
      }), { status: 200 });
    }));
    const res = resCapture();
    const request = req(`Bearer ${KEY}`);
    request.method = "GET";
    request.url = "/api/company-numbers-agent-migration?agent_key=showmojo";
    await migration(request, res as unknown as ServerResponse);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("onboarding MCP");
  });
});
