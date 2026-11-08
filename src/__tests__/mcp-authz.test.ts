/**
 * Authorization for the hosted VestLaunch MCP.
 *
 * Locks the failure cases the connection has to refuse: a missing scope, a
 * tool the key's business does not cover, a caller-supplied workspace id,
 * a pagination query that tries to change that id, a read scope used as a
 * write, and credential text in an audit line.
 */
import { createHash } from "node:crypto";
import { EncryptJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolDefinition, executeTool } from "../tools.js";
import type { ManifestTool } from "../manifest.js";
import {
  auditRecord,
  confineArguments,
  exposeTool,
  parseCallerIdentity,
  permitManifestTool,
  permitOwnerBillingAction,
  permitTool,
  redactSecrets,
  type CallerIdentity,
} from "../mcp-authz.js";

const SECRET = "test-oauth-secret-16";

function id(over: Partial<CallerIdentity> = {}): CallerIdentity {
  const authority = over.authority ?? "scoped";
  const scopes = over.scopes ?? [];
  const businesses = over.businesses ?? [];
  const workspaceIds = over.workspaceIds ?? [];
  const complete = scopes.length > 0 && businesses.length > 0 && workspaceIds.length > 0;
  return {
    authority,
    authorityOk: over.authorityOk ?? (authority === "legacy-shared" || complete),
    apiKeyId: over.apiKeyId ?? "key_test",
    name: over.name ?? "fixture",
    email: over.email,
    scopes,
    businesses,
    workspaceIds,
    authorityError: over.authorityError,
  };
}

const read = id({ scopes: ["properties:read", "opportunities:read", "contacts:read"] });
const both = id({ scopes: ["*"], businesses: ["ffl", "cranbrook"], workspaceIds: ["ws_ffl", "ws_cran"] });

describe("identity", () => {
  it("accepts only the exact business tokens and workspace ids", () => {
    const missing = parseCallerIdentity({ scopes: ["contacts:read"], name: "Cranbrook Forest" }, "scoped");
    expect(missing.authorityOk).toBe(false);
    expect(missing.businesses).toEqual([]);
    expect(missing.name).toBe("Cranbrook Forest");
    const bothBiz = parseCallerIdentity(
      { scopes: ["properties:read"], business: "both", workspaceIds: ["ws_ffl", "ws_cran"] },
      "scoped",
    );
    expect(bothBiz.authorityOk).toBe(true);
    expect(bothBiz.businesses.slice().sort()).toEqual(["cranbrook", "ffl"]);
    const display = parseCallerIdentity(
      { scopes: ["properties:read"], business: "Cranbrook Forest", workspaceIds: ["ws_cran"], workspaces: [{ slug: "cranbrook", name: "Cranbrook Forest" }] },
      "scoped",
    );
    expect(display.authorityOk).toBe(false);
    expect(display.businesses).toEqual([]);
  });
});

describe("tool permission", () => {
  it("a read-only key sees its business reads and not writes, sends, or the other business", () => {
    const ffl = id({ scopes: read.scopes, businesses: ["ffl"], workspaceIds: ["ws_ffl"] });
    expect(exposeTool("get_ffl_occupancy", null, ffl, { enableWrites: true })).toBe(true);
    expect(exposeTool("get_cfa_numbers", null, ffl, { enableWrites: true })).toBe(false);
    expect(exposeTool("act_leasing_triage", null, ffl, { enableWrites: true })).toBe(false);
    expect(exposeTool("owner_billing", null, ffl, { enableWrites: true })).toBe(true);
    expect(permitOwnerBillingAction(ffl, { action: "dont_charge" }, true).ok).toBe(false);
    expect(permitOwnerBillingAction(ffl, { action: "list" }, true).ok).toBe(true);
    expect(permitTool(ffl, "report_run_complete", { enableWrites: true }).ok).toBe(false);
  });

  it("the tools query cannot grant a tool the key does not already have", () => {
    const filter = new Set(["act_leasing_triage", "get_cfa_numbers", "send_sms"]);
    expect(exposeTool("act_leasing_triage", filter, read, { enableWrites: true })).toBe(false);
    expect(exposeTool("get_ffl_occupancy", filter, read, { enableWrites: true })).toBe(false);
  });

  it("keeps an explicit legacy wildcard key, and a scoped wildcard only inside its businesses", () => {
    const legacy = id({ authority: "legacy-shared", authorityOk: true, scopes: ["*"] });
    expect(permitTool(legacy, "act_leasing_triage", { enableWrites: false }).ok).toBe(true);
    const cran = id({ scopes: ["leasing:write"], businesses: ["cranbrook"], workspaceIds: ["ws_cran"] });
    expect(permitTool(cran, "record_tour_outcome", { enableWrites: true }).ok).toBe(true);
    expect(permitTool(id({ scopes: ["properties:read"], businesses: ["cranbrook"], workspaceIds: ["ws_cran"] }), "set_office_closure", { enableWrites: true }).ok).toBe(false);
    expect(permitOwnerBillingAction(id({ scopes: ["*"], businesses: ["ffl"], workspaceIds: ["ws_ffl"] }), { action: "undo" }, false).ok).toBe(true);
    expect(permitTool(id({ scopes: ["*"] }), "act_leasing_triage", { enableWrites: true }).ok).toBe(false);
    expect(permitTool(both, "get_ffl_occupancy", { enableWrites: true }).ok).toBe(true);
    expect(permitTool(both, "get_cfa_numbers", { enableWrites: true }).ok).toBe(true);
  });

  it("does not register a send or SQL tool as a read, and still registers an ordinary read", () => {
    const opts = { enableWrites: true, availableScopes: ["*"] };
    expect(buildToolDefinition({ name: "send_sms", method: "GET", path: "/api/v1/communications/send", scope: "communications:read", description: "Send." }, opts)).toBeNull();
    expect(buildToolDefinition({ name: "raw_query", method: "POST", path: "/api/v1/sql", scope: "*", description: "SQL." }, opts)).toBeNull();
    expect(buildToolDefinition({ name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List." }, opts)).not.toBeNull();
    expect(
      permitManifestTool(
        id({ scopes: ["communications:read"], businesses: ["ffl"], workspaceIds: ["ws_ffl"] }),
        { name: "send_sms", method: "POST", path: "/api/v1/communications", scope: "communications:read" },
        { enableWrites: true },
      ).ok,
    ).toBe(false);
    expect(
      permitManifestTool(
        id({ scopes: ["communications:write"], businesses: ["ffl"], workspaceIds: ["ws_ffl"] }),
        { name: "send_sms", method: "POST", path: "/api/v1/communications", scope: "communications:write" },
        { enableWrites: true },
      ).ok,
    ).toBe(true);
  });

  it("a scoped key with no business sees neither family; legacy-shared still follows scopes", () => {
    expect(exposeTool("get_ffl_occupancy", null, read, { enableWrites: true })).toBe(false);
    expect(exposeTool("get_cfa_numbers", null, read, { enableWrites: true })).toBe(false);
    const legacy = id({ authority: "legacy-shared", authorityOk: true, scopes: read.scopes });
    expect(exposeTool("get_ffl_occupancy", null, legacy, { enableWrites: true })).toBe(true);
    expect(exposeTool("get_cfa_numbers", null, legacy, { enableWrites: true })).toBe(true);
  });
});

describe("workspace and pagination", () => {
  const bound = id({ scopes: ["*"], businesses: ["ffl"], workspaceIds: ["ws_ffl"] });

  it("denies a caller-supplied workspace, including one hidden in a page query", () => {
    const denied = confineArguments(bound, { query: { workspaceId: "ws_cran", offset: 40, limit: 100 } }, "query");
    expect(denied.ok).toBe(false);
    const nested = confineArguments(bound, { search: "ada", workspaceId: "ws_other" }, "top");
    expect(nested.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain("ffl_live_");
  });

  it("pins an omitted filter to the key's workspace so paging cannot mean every business", () => {
    const pinned = confineArguments(bound, { query: { offset: 40, limit: 25 } }, "query");
    expect(pinned.ok).toBe(true);
    if (pinned.ok) expect(pinned.args.query).toMatchObject({ workspaceId: "ws_ffl", offset: 40 });
  });

  it("allows only the pinned workspace id and denies an opaque id with no allow-list", () => {
    const own = confineArguments(bound, { query: { workspaceId: "ws_ffl", offset: 10 } }, "query");
    expect(own.ok).toBe(true);
    if (own.ok) expect((own.args.query as { workspaceId: string }).workspaceId).toBe("ws_ffl");
    const legacy = confineArguments(
      id({ authority: "legacy-shared", authorityOk: true, scopes: ["contacts:read"] }),
      { query: { workspaceId: "ws_legacy", offset: 0 } },
      "query",
    );
    expect(legacy.ok).toBe(false);
  });

  it("refuses a business alias and a cleared filter", () => {
    expect(confineArguments(bound, { workspaceId: "ffl" }, "none", "ffl").ok).toBe(false);
    expect(confineArguments(bound, { workspaceId: "cranbrook" }, "none", "ffl").ok).toBe(false);
    expect(confineArguments(bound, { query: { workspaceId: "*", offset: 0 } }, "query").ok).toBe(false);
    const legacy = confineArguments(
      id({ authority: "legacy-shared", authorityOk: true, scopes: ["*"] }),
      { query: { workspaceId: "all", offset: 5 } },
      "query",
    );
    expect(legacy.ok).toBe(false);
  });

  it("does not call the CRM when the workspace is refused", async () => {
    const calls: unknown[] = [];
    const client = { request: async (opts: unknown) => (calls.push(opts), { success: true, data: null }) } as any;
    const def = buildToolDefinition(
      { name: "list_contacts", method: "GET", path: "/api/v1/contacts", scope: "contacts:read", description: "List.", inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, offset: { type: "integer" } } } } as ManifestTool,
      { enableWrites: true, availableScopes: ["*"] },
    )!;
    await expect(
      executeTool(client, def, { workspaceId: "ws_other", offset: 20 }, { scopes: ["*"], workspaceIds: ["ws_ffl"], businesses: ["ffl"] }),
    ).rejects.toThrow(/workspace/);
    expect(calls).toHaveLength(0);
  });
});

describe("audit redaction", () => {
  it("drops credential material from the record and from client-facing text", () => {
    const record = auditRecord({
      identity: id({ apiKeyId: "key_test", name: "fixture" }),
      tool: "list_contacts",
      decision: "deny",
      reason: "refused Bearer ffl_live_SUPERSECRETVALUE sk_live_abc",
    });
    const text = JSON.stringify(record);
    expect(text).not.toContain("SUPERSECRETVALUE");
    expect(text).not.toContain("sk_live_abc");
    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("key_test");
    expect(redactSecrets("key ffl_live_SUPERSECRETVALUE")).toContain("ffl_[redacted]");
    expect(redactSecrets("ffl_test_abc-def-ghi-jkl")).not.toContain("abc-def");
    expect(redactSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue")).toContain("[jwt redacted]");
    expect(redactSecrets("Authorization: Bearer ffl_live_SUPERSECRETVALUE")).not.toContain("SUPERSECRETVALUE");
  });
});

describe("expired and invalid tokens", () => {
  beforeEach(() => {
    process.env.OAUTH_JWE_SECRET = SECRET;
    vi.resetModules();
  });

  it("rejects an expired access token and a token that is not ours", async () => {
    const key = createHash("sha256").update(SECRET).digest();
    const expired = await new EncryptJWT({ tt: "access", crmKey: "ffl_live_SUPERSECRETVALUE" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .encrypt(key);
    const { readAccessToken } = await import("../../api/_oauth.js");
    await expect(readAccessToken(expired)).rejects.toThrow();
    await expect(readAccessToken("not-a-token")).rejects.toThrow();
  });
});
