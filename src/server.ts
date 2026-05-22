/**
 * MCP server bootstrap. Loads the CRM tool manifest, registers each
 * capability as an MCP tool, and wires the call/list handlers.
 */

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

export async function buildServer(config: Config): Promise<BuiltServer> {
  const client = new ApiClient(config);
  log.info(`bootstrapping MCP server`, {
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
