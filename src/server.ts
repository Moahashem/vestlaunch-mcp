/**
 * MCP server bootstrap. Loads the CRM tool manifest, registers each
 * capability as an MCP tool, and wires the call/list handlers.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ApiClient } from "./api-client.js";
import type { Config } from "./config.js";
import { log } from "./log.js";
import { loadManifest } from "./manifest.js";
import {
  type McpToolDefinition,
  buildToolDefinition,
  executeTool,
} from "./tools.js";

const SERVER_NAME = "vestlaunch-mcp";
const SERVER_VERSION = "0.1.0";

export interface BuiltServer {
  server: Server;
  toolCount: number;
}

/**
 * WHICH BUILD IS THIS? (s31d)
 *
 * The connector is launched by absolute path from the MCP host's config, so
 * "the code running" and "the code in the repo you are editing" are two
 * different things — and for three sessions they silently were. Fixes sat on
 * `main` while the live server ran a months-old `dist/` from a second checkout
 * nobody remembered, and the only way to notice was archaeology.
 *
 * So the server now says who it is, in its first log line: the directory it
 * was actually loaded from, and the git HEAD of that directory. A stale build
 * announces itself instead of being deduced. Best-effort by design — a
 * published npm install has no .git and simply reports "not-a-checkout"
 * rather than failing to boot over a diagnostic.
 */
function buildIdentity(): { loadedFrom: string; gitHead: string } {
  const loadedFrom = path.resolve(fileURLToPath(import.meta.url), "..", "..");
  let gitHead = "not-a-checkout";
  try {
    gitHead = execFileSync("git", ["-C", loadedFrom, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["-C", loadedFrom, "status", "--porcelain", "--untracked-files=no", "--", "src"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty) gitHead += "+dirty(src)";
  } catch {
    /* not a checkout, or no git — the fallback is the answer */
  }
  return { loadedFrom, gitHead };
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  const client = new ApiClient(config);
  const identity = buildIdentity();
  log.info(`bootstrapping MCP server`, {
    version: SERVER_VERSION,
    loadedFrom: identity.loadedFrom,
    gitHead: identity.gitHead,
    baseUrl: config.baseUrl,
    enableWrites: config.enableWrites,
  });

  const manifest = await loadManifest(client);
  log.info(`agent identity confirmed`, {
    apiKeyId: manifest.identity.apiKeyId,
    agentName: manifest.identity.agentName ?? manifest.identity.name,
    scopes: manifest.identity.scopes,
    crmContext: manifest.crm,
  });

  const definitions: McpToolDefinition[] = [];
  let skipped = 0;
  for (const tool of manifest.capabilities) {
    const def = buildToolDefinition(tool, {
      enableWrites: config.enableWrites,
      availableScopes: manifest.identity.scopes,
    });
    if (def) definitions.push(def);
    else skipped++;
  }
  log.info(`registered ${definitions.length} tools (${skipped} skipped by scope/write-guard)`);

  const byName = new Map<string, McpToolDefinition>();
  for (const def of definitions) byName.set(def.name, def);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: definitions.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const def = byName.get(name);
    if (!def) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}. Available tools start with "vestlaunch_".`,
          },
        ],
        isError: true,
      };
    }
    try {
      const result = await executeTool(client, def, (rawArgs ?? {}) as Record<string, unknown>);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`tool call failed: ${name} — ${msg}`);
      return {
        content: [
          {
            type: "text",
            text: `Error invoking ${name}: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  });

  return { server, toolCount: definitions.length };
}
