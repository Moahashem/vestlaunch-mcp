/**
 * Cases an outside review reproduced against the previous gate:
 * businessId, a workspace alias, a selector nested past the budget,
 * and contradictory identity claims. Fixture values only.
 */
import { describe, expect, it } from "vitest";
import { buildToolDefinition, executeTool } from "../tools.js";
import {
  SELECTOR_DEPTH_BUDGET,
  confineArguments,
  connectionStatusPayload,
  exposeTool,
  onboardingAllows,
  parseCallerIdentity,
  permitManifestTool,
  redactSecrets,
  redactStructured,
  type CallerIdentity,
} from "../mcp-authz.js";

function scoped(over: Partial<CallerIdentity> = {}): CallerIdentity {
  return {
    authority: "scoped",
    authorityOk: true,
    apiKeyId: "key_test",
    name: "fixture",
    scopes: ["*"],
    businesses: ["ffl"],
    workspaceIds: ["ws_ffl"],
    ...over,
  };
}

function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let i = 0; i < levels; i++) node = { wrap: node };
  return node;
}

describe("caller selectors", () => {
  const bound = scoped();

  it("denies businessId, including a value that is not a business token", () => {
    expect(confineArguments(bound, { businessId: "ck_other_business" }, "top").ok).toBe(false);
    expect(confineArguments(bound, { query: { business_id: "ws_ffl", offset: 10 } }, "query").ok).toBe(false);
    expect(confineArguments(bound, { tenantId: "ws_ffl" }, "none").ok).toBe(false);
  });

  it("denies the workspace alias ffl even when the key's business is ffl", () => {
    expect(confineArguments(bound, { workspaceId: "ffl" }, "top").ok).toBe(false);
    expect(confineArguments(bound, { workspace_id: "ffl", offset: 3 }, "top").ok).toBe(false);
    expect(confineArguments(bound, { WorkspaceId: "FFL" }, "none").ok).toBe(false);
  });

  it("denies a selector nested past the traversal budget and still sees one inside it", () => {
    const past = confineArguments(bound, nest(SELECTOR_DEPTH_BUDGET + 1, { businessId: "ck_hidden" }), "none");
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.reason).toMatch(/budget/);
    const inside = confineArguments(bound, nest(SELECTOR_DEPTH_BUDGET, { businessId: "ck_hidden" }), "none");
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.reason).toMatch(/business or tenant/);
  });

  it("denies conflicting selectors and a second workspace beside the pinned one", () => {
    expect(confineArguments(bound, { workspaceId: "ws_ffl", businessId: "ffl" }, "top").ok).toBe(false);
    expect(confineArguments(bound, { workspaceId: "ws_ffl", query: { workspace_id: "ws_other", offset: 40 } }, "query").ok).toBe(false);
  });

  it("pins a single workspace and refuses to omit one when the key has two", () => {
    const pinned = confineArguments(bound, { offset: 4 }, "top");
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.args.workspaceId).toBe("ws_ffl");
    const both = scoped({ businesses: ["ffl", "cranbrook"], workspaceIds: ["ws_ffl", "ws_cran"] });
    expect(confineArguments(both, { offset: 4 }, "top").ok).toBe(false);
    const named = confineArguments(both, { workspaceId: "ws_ffl", offset: 4 }, "top");
    expect(named.ok).toBe(true);
    expect(confineArguments(both, { workspaceId: "ws_other" }, "top").ok).toBe(false);
  });

  it("does not forward a denied selector from the stdio executor", async () => {
    const calls: unknown[] = [];
    const client = { request: async (opts: unknown) => (calls.push(opts), { success: true, data: null }) };
    const def = buildToolDefinition(
      { name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List.", inputSchema: { type: "object", properties: { businessId: { type: "string" } } } },
      { enableWrites: true, availableScopes: ["*"] },
    )!;
    await expect(executeTool(client as never, def, { businessId: "ck_other" }, scoped())).rejects.toThrow(/business or tenant/);
    expect(calls).toHaveLength(0);
  });
});

describe("identity contract", () => {
  it("fails closed on missing, malformed, and contradictory authority", () => {
    expect(parseCallerIdentity({ scopes: ["properties:read"] }, "scoped").authorityOk).toBe(false);
    expect(parseCallerIdentity({ scopes: ["properties:read"], business: "ffl" }, "scoped").authorityOk).toBe(false);
    expect(parseCallerIdentity({ scopes: [], business: "ffl", workspaceIds: ["ws_ffl"] }, "scoped").authorityOk).toBe(false);
    expect(parseCallerIdentity({ scopes: ["properties:read"], business: "FFL", workspaceIds: ["ws_ffl"] }, "scoped").authorityOk).toBe(false);
    expect(parseCallerIdentity({ scopes: ["properties:read"], business: "ffl", workspaceIds: ["ffl"] }, "scoped").authorityOk).toBe(false);
    const conflict = parseCallerIdentity(
      { scopes: ["properties:read"], business: "ffl", businesses: ["cranbrook"], workspaceIds: ["ws_ffl"] },
      "scoped",
    );
    expect(conflict.authorityOk).toBe(false);
    expect(conflict.businesses).toEqual([]);
    const ok = parseCallerIdentity(
      { scopes: ["properties:read"], business: "ffl", workspaceIds: ["ws_ffl"], name: "Cranbrook Forest" },
      "scoped",
    );
    expect(ok.authorityOk).toBe(true);
    expect(ok.businesses).toEqual(["ffl"]);
  });

  it("does not let a manifest scope of * authorize a key with no scopes or only a specific scope", () => {
    const tool = { name: "get_me", method: "GET" as const, path: "/api/v1/me", scope: "*", description: "Who." };
    expect(buildToolDefinition(tool, { enableWrites: true, availableScopes: [] })).toBeNull();
    expect(buildToolDefinition(tool, { enableWrites: true, availableScopes: ["contacts:read"] })).toBeNull();
    expect(buildToolDefinition(tool, { enableWrites: true, availableScopes: ["*"] })).not.toBeNull();
    const none = scoped({ scopes: [], authorityOk: false, businesses: [], workspaceIds: [] });
    expect(permitManifestTool(none, tool, { enableWrites: true }).ok).toBe(false);
    expect(permitManifestTool(scoped({ scopes: ["contacts:read"] }), tool, { enableWrites: true }).ok).toBe(false);
    expect(permitManifestTool(scoped({ scopes: ["*"] }), tool, { enableWrites: true }).ok).toBe(false);
  });
});

describe("selector shapes", () => {
  const bound = scoped();

  it("rejects a plural workspaceIds array even when a single workspace would be pinned", () => {
    const result = confineArguments(bound, { workspaceIds: ["ws_other", "ws_ffl"], offset: 1 }, "top");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ws_other");
  });

  it("rejects an object workspaceId nested under filters, for scoped and legacy", () => {
    const nested = { filters: { workspaceId: { in: ["ws_other"] } }, business: { slug: "cranbrook" } };
    expect(confineArguments(bound, nested, "none").ok).toBe(false);
    const legacy = confineArguments(
      { ...bound, authority: "legacy-shared" },
      { filters: { workspaceId: { id: "ws_ffl" } } },
      "query",
    );
    expect(legacy.ok).toBe(false);
  });

  it("pins one allowlisted id and does not leave a second selector behind", () => {
    const result = confineArguments(bound, { workspace_id: "ws_ffl", note: "keep" }, "none");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args.workspaceId).toBe("ws_ffl");
      expect(result.args).not.toHaveProperty("workspace_id");
      expect(JSON.stringify(result.args)).not.toContain("workspaceIds");
    }
  });
});

describe("onboarding allowlist", () => {
  it("denies manifest and synthetic tools for a scoped key, including a tools query and a wildcard scope", () => {
    const ident = scoped({ scopes: ["*"] });
    expect(onboardingAllows({ name: "connection_status", method: "GET", path: "mcp://connection-status" })).toBe(true);
    for (const name of ["get_ffl_occupancy", "get_cfa_numbers", "owner_billing", "act_leasing_triage", "get_leasing_triage"]) {
      expect(exposeTool(name, new Set([name]), ident, { enableWrites: true })).toBe(false);
    }
    expect(permitManifestTool(ident, { name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "*" }, { enableWrites: true }).ok).toBe(false);
    expect(permitManifestTool(ident, { name: "get_me", method: "GET", path: "/api/v1/me", scope: "*" }, { enableWrites: true }).ok).toBe(false);
    const status = connectionStatusPayload(ident);
    expect(status.dataRoutesCleared).toEqual([]);
    expect(JSON.stringify(status)).not.toMatch(/\/api\/v1\/(?!me)/);
    expect(JSON.stringify(status.allowlist)).not.toContain("/api/v1/");
  });
});

describe("redaction", () => {
  it("keeps a record UUID and redacts credential fields and secret prefixes", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const body = redactStructured({
      id,
      note: "paid",
      access_token: "ffl_live_SUPERSECRETVALUE",
      nested: { crmKey: "ffl_test_abc-def-ghi-jkl" },
    }) as { id: string; note: string; access_token: string; nested: { crmKey: string } };
    expect(body.id).toBe(id);
    expect(body.note).toBe("paid");
    expect(body.access_token).toBe("[redacted]");
    expect(body.nested.crmKey).toBe("[redacted]");
    expect(JSON.stringify(body)).not.toContain("SUPERSECRETVALUE");
    const text = redactSecrets(`ffl_test_abc-def-ghi-jkl ${id}`);
    expect(text).toContain(id);
    expect(text).not.toContain("abc-def");
  });
});
