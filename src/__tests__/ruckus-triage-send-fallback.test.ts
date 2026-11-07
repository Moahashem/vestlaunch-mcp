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
import { describe, it, expect } from "vitest";
import { buildCranbrookTools, withExtraTools, EXTRA_TOOLS, isCranbrookTool } from "../../api/_ruckus-cranbrook.js";
import { sendFallbackToken } from "../../api/ruckus-mcp.js";

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
  it("does not retry success, other errors, the same token or no token", () => {
    expect(sendFallbackToken("old", 200, "new")).toBeNull();
    expect(sendFallbackToken("old", 500, "new")).toBeNull();
    expect(sendFallbackToken("same", 401, "same")).toBeNull();
    expect(sendFallbackToken("old", 401, "")).toBeNull();
    expect(sendFallbackToken("old", 401, undefined)).toBeNull();
  });
});
