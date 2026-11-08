/**
 * The published bin is dist/index.js. These checks run that file and the
 * compiled server, not the TypeScript source.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../dist/server.js";

const config = {
  baseUrl: "https://crm.example.invalid",
  apiKey: "ffl_live_DIST",
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

describe("committed dist stdio gate", () => {
  it("registers tools only for an object that omits the marker", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => me({ scopes: ["contacts:read"], apiKeyId: "k", name: "Existing", actorType: "agent", keyPrefix: "ffl_live" })) as typeof fetch;
    try {
      const built = await buildServer(config);
      expect(built.toolCount).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("the compiled server refuses a marked, null, or missing identity", async () => {
    const real = globalThis.fetch;
    for (const identity of [
      { mcpProfile: "onboarding", scopes: ["mcp:onboarding"], business: "ffl", workspaceIds: ["ws"] },
      null,
      undefined,
    ]) {
      globalThis.fetch = (async () => me(identity)) as typeof fetch;
      await expect(buildServer(config)).rejects.toThrow("onboarding MCP");
    }
    globalThis.fetch = real;
  });
});

function listen(): Promise<{ url: string; close: () => Promise<void>; setIdentity: (identity: unknown) => void }> {
  let identity: unknown = { scopes: ["contacts:read"], name: "Existing" };
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
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
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
        setIdentity(next) {
          identity = next;
        },
      });
    });
  });
}

function runBin(baseUrl: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VESTLAUNCH_BASE_URL: baseUrl,
        VESTLAUNCH_API_KEY: "ffl_live_DISTBIN",
        VESTLAUNCH_LOG_LEVEL: "info",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, 2500);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

describe("dist/index.js bin", () => {
  it("exits for a marked identity and stays up for an unmarked object", async () => {
    const crm = await listen();
    try {
      crm.setIdentity({ mcpProfile: "onboarding", scopes: ["mcp:onboarding"], business: "ffl", workspaceIds: ["ws"] });
      const marked = await runBin(crm.url);
      expect(marked.code).toBe(1);
      expect(marked.stderr).toContain("onboarding MCP");
      expect(marked.stderr).not.toContain("ffl_live_DISTBIN");
      crm.setIdentity({ scopes: ["contacts:read"], apiKeyId: "k", name: "Existing", actorType: "agent", keyPrefix: "ffl_live" });
      const open = await runBin(crm.url);
      expect(open.code).toBe(0);
      expect(open.stderr).toContain("tools available");
      expect(open.stderr).not.toContain("onboarding MCP");
      expect(marked.stderr).not.toContain("tools available");
    } finally {
      await crm.close();
    }
  });
});
