/**
 * 2026-11-06 Ruckus RingCentral review.
 *
 * 1) Ruckus could not clear a Cranbrook "needs a person" item: act_leasing_triage ran on the
 *    shared FFL key and the CRM refused it ("This API key belongs to another business"). The
 *    Cranbrook-keyed pair cranbrook_get_leasing_triage / cranbrook_act_leasing_triage is now
 *    always in Ruckus's tool list.
 * 2) The CRM's CRON_SECRET was rotated and the vault credential kept the old value: every
 *    ruckus_send was refused (401) for five hours. A refused post is retried once with this
 *    server's RUCKUS_SEND_TOKEN when that token is different.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCranbrookTools, withExtraTools, EXTRA_TOOLS, isCranbrookTool } from "../../api/_ruckus-cranbrook.js";
import { ruckusSend, sendFallbackToken } from "../../api/ruckus-mcp.js";

describe("Cranbrook triage tools", () => {
  it("are added to an ordinary manifest", () => {
    const tools = withExtraTools(buildCranbrookTools([{ name: "list_contacts", method: "GET", path: "/api/v1/contacts", description: "x", scope: "contacts:read" }]));
    const names = tools.map((t) => t.name);
    expect(names).toContain("cranbrook_list_contacts");
    expect(names).toContain("cranbrook_get_leasing_triage");
    expect(names).toContain("cranbrook_act_leasing_triage");
    expect(isCranbrookTool("cranbrook_act_leasing_triage")).toBe(true);
  });
  it("hit the leasing triage endpoint with the right verbs and require a reason to act", () => {
    const get = EXTRA_TOOLS.find((t) => t.name === "cranbrook_get_leasing_triage")!;
    const act = EXTRA_TOOLS.find((t) => t.name === "cranbrook_act_leasing_triage")!;
    expect([get.method, get.path]).toEqual(["GET", "/api/v1/analytics/leasing-triage"]);
    expect([act.method, act.path]).toEqual(["POST", "/api/v1/analytics/leasing-triage"]);
    expect(act.inputSchema.required).toEqual(["action", "conversationId", "reason"]);
  });
  it("never duplicate a tool the manifest already lists", () => {
    const fromManifest = buildCranbrookTools([{ name: "get_leasing_triage", method: "GET", path: "/api/v1/analytics/leasing-triage", description: "manifest", scope: "properties:read" }]);
    const tools = withExtraTools(fromManifest);
    expect(tools.filter((t) => t.name === "cranbrook_get_leasing_triage")).toHaveLength(1);
    expect(tools.find((t) => t.name === "cranbrook_get_leasing_triage")!.description).toContain("manifest");
  });
});

describe("sendFallbackToken", () => {
  it("retries a refused post with a different server token", () => {
    expect(sendFallbackToken("old", 401, "new")).toBe("new");
    expect(sendFallbackToken("old", 403, " new ")).toBe("new");
  });
  it("does not retry success, other errors, the same token, no token, or a CRM key", () => {
    expect(sendFallbackToken("old", 200, "new")).toBeNull();
    expect(sendFallbackToken("old", 500, "new")).toBeNull();
    expect(sendFallbackToken("same", 401, "same")).toBeNull();
    expect(sendFallbackToken("old", 401, "")).toBeNull();
    expect(sendFallbackToken("old", 401, undefined)).toBeNull();
    expect(sendFallbackToken("ffl_live_MARKED", 401, "vault-token")).toBeNull();
    expect(sendFallbackToken("ffl_live_MARKED", 403, "vault-token")).toBeNull();
  });
});

describe("ruckus_send confinement", () => {
  afterEach(() => {
    delete process.env.RUCKUS_SEND_TOKEN;
    delete process.env.VESTLAUNCH_BASE_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not retry a marked or malformed CRM key with the vault token", async () => {
    process.env.RUCKUS_SEND_TOKEN = "vault-token";
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      if (String(url).endsWith("/api/v1/me")) {
        const identity = auth.endsWith("MARKED")
          ? { mcpProfile: "onboarding", scopes: ["mcp:onboarding"], business: "ffl", workspaceIds: ["ws"] }
          : "Cranbrook Forest";
        return new Response(JSON.stringify({ data: { identity } }), { status: 200 });
      }
      throw new Error("ruckus-send must not be called");
    });
    vi.stubGlobal("fetch", fetchMock);
    const marked = await ruckusSend({ text: "hello" }, "ffl_live_MARKED");
    expect(marked).toEqual({ ok: false, error: "This key cannot use Ruckus." });
    const malformed = await ruckusSend({ text: "hello" }, "ffl_live_OTHER");
    expect(malformed).toEqual({ ok: false, error: "This key cannot use Ruckus." });
    expect(fetchMock.mock.calls.every((call) => String(call[0]).endsWith("/api/v1/me"))).toBe(true);
  });

  it("forwards an unmarked CRM key once and does not upgrade a 401", async () => {
    process.env.RUCKUS_SEND_TOKEN = "vault-token";
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/me")) {
        return new Response(JSON.stringify({ data: { identity: { scopes: ["contacts:read"], name: "Existing" } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "refused" }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await ruckusSend({ text: "hello" }, "ffl_live_EXISTING");
    expect(result).toMatchObject({ ok: false, status: 401 });
    const posts = fetchMock.mock.calls.filter((call) => String(call[0]).includes("ruckus-send"));
    expect(posts).toHaveLength(1);
    expect((posts[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer ffl_live_EXISTING" });
  });

  it("still retries a refused non-CRM vault bearer once", async () => {
    process.env.RUCKUS_SEND_TOKEN = "vault-token";
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const bearers: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      bearers.push(headers.Authorization);
      return new Response("{}", { status: bearers.length === 1 ? 401 : 200 });
    }));
    const result = await ruckusSend({ text: "hello" }, "old-cron-secret");
    expect(bearers).toEqual(["Bearer old-cron-secret", "Bearer vault-token"]);
    expect(result).toEqual({});
  });
});
