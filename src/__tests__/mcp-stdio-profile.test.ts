/**
 * The npx/stdio server reads the same marker as the HTTP routes.
 * A marked or non-object identity registers no tools.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readMcpProfile as httpProfile } from "../../api/_mcp-onboarding-policy.js";
import { readMcpProfile as stdioProfile } from "../mcp-profile.js";
import { buildServer } from "../server.js";

const config = {
  baseUrl: "https://crm.example.invalid",
  apiKey: "ffl_live_STDIO",
  enableWrites: false,
  blockAdmin: true,
  logLevel: "silent" as const,
  timeoutMs: 1000,
};

function me(identity: unknown) {
  return new Response(JSON.stringify({
    data: {
      identity,
      capabilities: [{
        name: "list_contacts",
        method: "GET",
        path: "/api/v1/contacts",
        scope: "contacts:read",
        description: "List.",
      }],
    },
  }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("stdio profile gate", () => {
  it("agrees with the HTTP marker on objects, arrays, and strings", () => {
    const samples = [
      undefined,
      null,
      "ffl",
      ["onboarding"],
      1,
      true,
      {},
      { scopes: ["contacts:read"], name: "Existing" },
      { mcpProfile: "onboarding" },
      { mcpProfile: "legacy" },
      { mcpProfile: ["onboarding"] },
    ];
    for (const sample of samples) expect(stdioProfile(sample)).toBe(httpProfile(sample));
  });

  it("registers a manifest tool for an object identity that omits the marker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => me({ scopes: ["contacts:read"], apiKeyId: "k", name: "Existing", actorType: "agent", keyPrefix: "ffl_live" })));
    const built = await buildServer(config);
    expect(built.toolCount).toBeGreaterThan(0);
  });

  it("registers no tools for a marked identity or a non-object identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => me({
      mcpProfile: "onboarding",
      scopes: ["mcp:onboarding"],
      business: "ffl",
      workspaceIds: ["ws_ffl"],
    })));
    await expect(buildServer(config)).rejects.toThrow("onboarding MCP");
    vi.stubGlobal("fetch", vi.fn(async () => me("Cranbrook Forest")));
    await expect(buildServer(config)).rejects.toThrow("onboarding MCP");
    vi.stubGlobal("fetch", vi.fn(async () => me(["ffl"])));
    await expect(buildServer(config)).rejects.toThrow("onboarding MCP");
  });
});
