/**
 * 2026-11-06 Ruckus RingCentral review.
 *
 * 1) Ruckus could not clear a Cranbrook "needs a person" item: act_leasing_triage ran on the
 *    shared FFL key and the CRM refused it ("This API key belongs to another business"). The
 *    Cranbrook-keyed pair cranbrook_get_leasing_triage / cranbrook_act_leasing_triage is now
 *    always in Ruckus's tool list.
 * 2) A refused post is not retried with RUCKUS_SEND_TOKEN. The caller must present
 *    that exact token. A previous vault secret that no longer matches cannot be
 *    identified here, and an arbitrary bearer is not upgraded.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCranbrookTools, withExtraTools, EXTRA_TOOLS, isCranbrookTool } from "../../api/_ruckus-cranbrook.js";
import { ruckusSend, ruckusSenderAuthorized, sendFallbackToken } from "../../api/ruckus-mcp.js";

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

const VAULT = "vault-token";
const ADVERSARIAL = [
  "ffl_live_MARKED",
  "FFL_LIVE_MARKED",
  "\u200bffl_live_MARKED",
  "Bearer ffl_live_MARKED",
  "Bearer Bearer ffl_live_MARKED",
  "eyJhbGciOiJub25lIn0.eyJ0dCI6InJlZnJlc2gifQ.sig",
  "old-cron-secret",
  "not-a-credential",
  "",
  " vault-token",
  "vault-token ",
];

describe("sendFallbackToken", () => {
  it("never returns an upgrade token", () => {
    for (const presented of ADVERSARIAL) {
      expect(sendFallbackToken(presented, 401, VAULT)).toBeNull();
      expect(sendFallbackToken(presented, 403, VAULT)).toBeNull();
    }
    expect(sendFallbackToken(VAULT, 401, VAULT)).toBeNull();
    expect(sendFallbackToken("old", 200, "new")).toBeNull();
    expect(sendFallbackToken("old", 500, "new")).toBeNull();
  });
});

describe("ruckus_send confinement", () => {
  afterEach(() => {
    delete process.env.RUCKUS_SEND_TOKEN;
    delete process.env.VESTLAUNCH_BASE_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts once when the caller presents the vault token and does not retry a 401", async () => {
    process.env.RUCKUS_SEND_TOKEN = VAULT;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: "m1" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await ruckusSend({ text: "hello" }, VAULT);
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${VAULT}` });
    expect(ruckusSenderAuthorized(VAULT, VAULT)).toBe(true);
  });

  it("does not upgrade adversarial or unmarked bearers to the vault token", async () => {
    process.env.RUCKUS_SEND_TOKEN = VAULT;
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch must not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const presented of ADVERSARIAL) {
      expect(ruckusSenderAuthorized(presented, VAULT)).toBe(false);
      const result = await ruckusSend({ text: "hello" }, presented);
      expect(result).toEqual({ ok: false, error: "Unauthorized." });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
