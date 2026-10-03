/**
 * Ruckus's Cranbrook tools (Mo, 2026-10-03): full read and write through a
 * Cranbrook-bound key — everything but deletes and account administration —
 * and a caller can never re-point the business.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCranbrookTools, isCranbrookTool, isExcludedTool, runCranbrookTool } from "../../api/_ruckus-cranbrook.js";

const manifest = [
  { name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List contacts.", inputSchema: { properties: { search: { type: "string" }, workspace_id: { type: "string" } } } },
  { name: "get_contact", method: "GET", path: "/api/v1/contacts/:id", scope: "contacts:read", description: "Get a contact.", inputSchema: { properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "update_contact", method: "PATCH", path: "/api/v1/contacts/:id", scope: "contacts:write", description: "Update a contact.", inputSchema: { properties: { id: { type: "string" }, firstName: { type: "string" } }, required: ["id"] } },
  { name: "send_sms", method: "POST", path: "/api/v1/communications", scope: "communications:write", description: "Send SMS." },
  { name: "delete_contact", method: "DELETE", path: "/api/v1/contacts/:id", scope: "contacts:delete", description: "Delete." },
  { name: "create_api_key", method: "POST", path: "/api/v1/api-keys", scope: "admin:api_keys", description: "Keys." },
  { name: "create_webhook", method: "POST", path: "/api/v1/webhooks", scope: "webhooks:write", description: "Hooks." },
  { name: "create_workspace", method: "POST", path: "/api/v1/workspaces", scope: "workspaces:write", description: "WS." },
  { name: "list_workspaces", method: "GET", path: "/api/v1/workspaces", scope: "workspaces:read", description: "List WS." },
];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RUCKUS_CRANBROOK_API_KEY;
});

describe("cranbrook tools", () => {
  it("exposes reads and writes, never deletes or administration", () => {
    expect(buildCranbrookTools(manifest).map((t) => t.name).sort()).toEqual([
      "cranbrook_get_contact", "cranbrook_list_contacts", "cranbrook_list_workspaces", "cranbrook_send_sms", "cranbrook_update_contact",
    ]);
    expect(isExcludedTool({ name: "delete_task", method: "DELETE", scope: "tasks:delete" })).toBe(true);
  });
  it("labels writes and drops the workspace knob", () => {
    const tools = buildCranbrookTools(manifest);
    const list = tools.find((t) => t.name === "cranbrook_list_contacts")!;
    expect(Object.keys(list.inputSchema.properties)).toEqual(["search"]);
    expect(list.description).not.toMatch(/\[WRITE\]/);
    const upd = tools.find((t) => t.name === "cranbrook_update_contact")!;
    expect(upd.description).toMatch(/^\[WRITE\] CRANBROOK FOREST/);
    expect(upd.description).toMatch(/never in Sam's sales chat/);
    expect(isCranbrookTool("cranbrook_update_contact")).toBe(true);
    expect(isCranbrookTool("update_contact")).toBe(false);
  });
  it("GET sends query params; writes send a JSON body; both use the Cranbrook key and never a workspace override", async () => {
    process.env.RUCKUS_CRANBROOK_API_KEY = "ffl_live_cran";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });
    const tools = buildCranbrookTools(manifest);
    await runCranbrookTool(tools.find((t) => t.name === "cranbrook_get_contact")!, { id: "c 1", workspace_id: "landlord-prospecting" });
    expect(calls[0].url).toMatch(/\/api\/v1\/contacts\/c%201$/);
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ffl_live_cran");
    await runCranbrookTool(tools.find((t) => t.name === "cranbrook_update_contact")!, { id: "c1", firstName: "Ana", workspaceId: "ffl" });
    expect(calls[1].url).toMatch(/\/api\/v1\/contacts\/c1$/);
    expect(calls[1].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ firstName: "Ana" });
  });
  it("says so plainly when not configured", async () => {
    const [list] = buildCranbrookTools(manifest);
    expect(await runCranbrookTool(list, {})).toMatchObject({ ok: false });
  });
});
