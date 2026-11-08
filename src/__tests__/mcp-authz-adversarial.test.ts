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
  parseCallerIdentity,
  permitManifestTool,
  redactSecrets,
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
    expect(permitManifestTool(scoped({ scopes: ["*"] }), tool, { enableWrites: true }).ok).toBe(true);
  });
});

describe("redaction tails", () => {
  it("redacts ffl_test, a jwt, and a hyphenated token tail", () => {
    const text = redactSecrets("ffl_test_abc-def-ghi-jkl eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue tail a1b2c3-d4e5-f6a7-b8c9-d0e1f2");
    expect(text).not.toContain("abc-def");
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("a1b2c3");
    expect(text).toContain("[jwt redacted]");
    expect(text).toContain("[token redacted]");
  });
});
