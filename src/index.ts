#!/usr/bin/env node
/**
 * VestLaunch MCP — stdio entry point.
 *
 * Spawned by an MCP-compatible client (Claude Desktop, Claude/Cowork,
 * Claude Code, ClawBot, etc.). Reads/writes the MCP protocol on
 * stdin/stdout; all logging goes to stderr.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./log.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const { server, toolCount } = await buildServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`ready — ${toolCount} tools available over stdio`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`[vestlaunch-mcp fatal] ${msg}\n`);
  process.exit(1);
});
