/**
 * Ruckus's Cranbrook read tools (Mo, 2026-10-03): Ruckus sees FFL and
 * Cranbrook evenly. Cranbrook reads go through a Cranbrook-bound key, GET only,
 * a fixed allowlist, and a caller can never re-point the business.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCranbrookTools, isCranbrookTool, runCranbrookTool, CRANBROOK_READ_TOOLS } from "../../api/_ruckus-cranbrook.js";

const manifest = [
  { name: "list_contacts", method: "GET", path: "/api/v1/contacts", description: "List contacts.", inputSchema: { properties: { search: { type: "string" }, workspace_id: { type: "string" } } } },
  { name: "get_contact", method: "GET", path: "/api/v1/contacts/:id", description: "Get a contact.", inputSchema: { properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "create_contact", method: "POST", path: "/api/v1/contacts", description: "Create." },
  { name: "delete_contact", method: "DELETE", path: "/api/v1/contacts/:id", description: "Delete." },
  { name: "list_api_keys", method: "GET", path: "/api/v1/api-keys", description: "Keys." },
];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RUCKUS_CRANBROOK_API_KEY;
});

describe("cranbrook tools", () => {
  it("exposes only allowlisted GET tools, prefixed, without a workspace knob", () => {
    const tools = buildCranbrookTools(manifest);
    expect(tools.map((t) => t.name).sort()).toEqual(["cranbrook_get_contact", "cranbrook_list_contacts"]);
    const list = tools.find((t) => t.name === "cranbrook_list_contacts")!;
    expect(Object.keys(list.inputSchema.properties)).toEqual(["search"]);
    expect(list.description).toMatch(/never in Sam's sales chat/);
    expect(tools.find((t) => t.name === "cranbrook_get_contact")!.inputSchema.required).toEqual(["id"]);
  });
  it("allowlist holds no write or admin tool", () => {
    for (const n of CRANBROOK_READ_TOOLS) expect(n).toMatch(/^(search|list_|get_)/);
    expect(isCranbrookTool("cranbrook_create_contact")).toBe(false);
    expect(isCranbrookTool("cranbrook_list_contacts")).toBe(true);
  });
  it("calls the CRM with the Cranbrook key, GET, and drops any workspace override", async () => {
    process.env.RUCKUS_CRANBROOK_API_KEY = "ffl_live_cran";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { id: "c1" } }), { status: 200 });
    });
    const [, get] = buildCranbrookTools(manifest);
    await runCranbrookTool(get, { id: "c 1", workspace_id: "landlord-prospecting" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v1\/contacts\/c%201$/);
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer ffl_live_cran");
  });
  it("says so plainly when not configured", async () => {
    const [list] = buildCranbrookTools(manifest);
    expect(await runCranbrookTool(list, {})).toMatchObject({ ok: false });
  });
});
