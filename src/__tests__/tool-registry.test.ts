/**
 * TOOL REGISTRATION AND ARGUMENT ROUTING (s31, s31b).
 *
 * Three separate bugs lived here, each shipped and each found only by driving
 * the live server. They are locked below:
 *
 *  1. The CRM publishes a complete flat inputSchema per tool and the wrapper
 *     threw it away, advertising an opaque `{ id, body }` blob instead — so an
 *     agent was told a body existed but never what could go in it.
 *  2. A genuinely no-argument endpoint publishes an EMPTY properties bag, and
 *     the "has a schema?" test required at least one property — so six GETs
 *     fell back to the legacy wrapper and were handed an invented `query` blob.
 *  3. Two DELETE routes read their args from searchParams while we sent
 *     body-only, making them 100% unusable and blaming the caller for it.
 */
import { describe, it, expect, vi } from "vitest";
import { buildToolDefinition, executeTool, type McpToolDefinition } from "../tools.js";
import type { ManifestTool } from "../manifest.js";

const OPTS = { enableWrites: true, availableScopes: ["*"] };

const tool = (over: Partial<ManifestTool> = {}): ManifestTool => ({
  name: "update_event_type",
  method: "PATCH",
  path: "/api/v1/event-types/:id",
  scope: "event_types:write",
  description: "Update an event type.",
  ...over,
});

/** A client stub that records exactly what the registry asked for. */
function spyClient() {
  const calls: any[] = [];
  return {
    calls,
    client: { request: async (opts: any) => (calls.push(opts), { success: true, data: null }) } as any,
  };
}

describe("the published schema is used, not replaced", () => {
  it("advertises the manifest's real field names instead of a body blob", () => {
    const def = buildToolDefinition(
      tool({
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, duration: { type: "integer" }, isActive: { type: "boolean" } },
          required: ["id"],
        },
      }),
      OPTS
    )!;
    expect(Object.keys(def.inputSchema.properties)).toEqual(["id", "duration", "isActive"]);
    expect(def.inputSchema.properties).not.toHaveProperty("body");
    expect(def.inputSchema.required).toEqual(["id"]);
    expect(def.meta.flat).toBe(true);
  });

  it("an EMPTY properties bag means 'takes nothing' — not 'undocumented'", () => {
    const def = buildToolDefinition(
      tool({ name: "get_pipelines", method: "GET", path: "/api/v1/pipelines", inputSchema: { type: "object", properties: {} } }),
      OPTS
    )!;
    expect(def.inputSchema.properties).toEqual({});
    expect(def.inputSchema.properties).not.toHaveProperty("query");
    expect(def.meta.flat).toBe(true);
  });

  it("no published schema at all still falls back to the legacy envelope", () => {
    const def = buildToolDefinition(tool({ inputSchema: undefined }), OPTS)!;
    expect(def.meta.flat).toBe(false);
    expect(def.inputSchema.properties).toHaveProperty("body");
    expect(def.inputSchema.properties).toHaveProperty("id");
  });

  it("write tools are withheld when writes are disabled", () => {
    expect(buildToolDefinition(tool(), { ...OPTS, enableWrites: false })).toBeNull();
    expect(buildToolDefinition(tool({ method: "GET", scope: "event_types:read" }), { ...OPTS, enableWrites: false })).not.toBeNull();
  });

  it("a tool whose scope the key lacks is not registered", () => {
    expect(buildToolDefinition(tool(), { enableWrites: true, availableScopes: ["contacts:read"] })).toBeNull();
    expect(buildToolDefinition(tool(), { enableWrites: true, availableScopes: ["event_types:write"] })).not.toBeNull();
  });
});

describe("argument routing", () => {
  const flatDef = () =>
    buildToolDefinition(
      tool({ inputSchema: { type: "object", properties: { id: { type: "string" }, duration: { type: "integer" } }, required: ["id"] } }),
      OPTS
    )!;

  it("path params go in the path; everything else goes in the write body", async () => {
    const { client, calls } = spyClient();
    await executeTool(client, flatDef(), { id: "evt_1", duration: 20 });
    expect(calls[0].path).toBe("/api/v1/event-types/evt_1");
    expect(calls[0].body).toEqual({ duration: 20 });
    expect(calls[0].body).not.toHaveProperty("id");
  });

  it("a GET routes its flat args to the query string, not a body", async () => {
    const def = buildToolDefinition(
      tool({ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", inputSchema: { type: "object", properties: { search: { type: "string" } } } }),
      OPTS
    )!;
    const { client, calls } = spyClient();
    await executeTool(client, def, { search: "smith" });
    expect(calls[0].query).toEqual({ search: "smith" });
    expect(calls[0].body).toBeUndefined();
  });

  it("a missing path param fails loudly rather than requesting /undefined", async () => {
    const { client } = spyClient();
    await expect(executeTool(client, flatDef(), { duration: 20 })).rejects.toThrow(/path parameter/i);
  });

  it("path params are URL-encoded", async () => {
    const { client, calls } = spyClient();
    await executeTool(client, flatDef(), { id: "a/b c" });
    expect(calls[0].path).toBe("/api/v1/event-types/a%2Fb%20c");
  });
});

describe("DELETE args reach a route that reads query params", () => {
  const deleteDef = (name: string, path: string, props: Record<string, unknown>): McpToolDefinition =>
    buildToolDefinition(
      tool({ name, method: "DELETE", path, scope: "agent:write", inputSchema: { type: "object", properties: props, required: Object.keys(props) } }),
      OPTS
    )!;

  it("delete_agent_state sends its args as BOTH query and body", async () => {
    const { client, calls } = spyClient();
    await executeTool(client, deleteDef("delete_agent_state", "/api/v1/agent/state", { agentKey: { type: "string" }, key: { type: "string" } }), {
      agentKey: "cowork", key: "phase",
    });
    // The route reads searchParams; body-only was why this tool never worked.
    expect(calls[0].query).toMatchObject({ agentKey: "cowork", key: "phase" });
    expect(calls[0].body).toMatchObject({ agentKey: "cowork", key: "phase" });
  });

  it("delete_knowledge likewise", async () => {
    const { client, calls } = spyClient();
    await executeTool(client, deleteDef("delete_knowledge", "/api/v1/agent/knowledge", { id: { type: "string" } }), { id: "k1" });
    expect(calls[0].query).toMatchObject({ id: "k1" });
  });

  it("a path-param DELETE is unaffected — nothing spurious in the query", async () => {
    const { client, calls } = spyClient();
    const def = buildToolDefinition(
      tool({ name: "delete_tag", method: "DELETE", path: "/api/v1/tags/:id", scope: "contacts:write", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }),
      OPTS
    )!;
    await executeTool(client, def, { id: "tag_1" });
    expect(calls[0].path).toBe("/api/v1/tags/tag_1");
    expect(calls[0].query ?? {}).toEqual({});
  });

  it("only scalars are duplicated into the query — objects would stringify to [object Object]", async () => {
    const { client, calls } = spyClient();
    const def = buildToolDefinition(
      tool({ name: "remove_contacts_from_segment", method: "DELETE", path: "/api/v1/segments/:id/contacts", scope: "contacts:write", inputSchema: { type: "object", properties: { id: { type: "string" }, contactIds: { type: "array" } }, required: ["id", "contactIds"] } }),
      OPTS
    )!;
    await executeTool(client, def, { id: "seg_1", contactIds: ["c1", "c2"] });
    expect(calls[0].query ?? {}).not.toHaveProperty("contactIds");
    expect(calls[0].body).toEqual({ contactIds: ["c1", "c2"] });
  });
});
