/**
 * MCP server bootstrap. Loads the CRM tool manifest, registers each
 * capability as an MCP tool, and wires the call/list handlers.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Config } from "./config.js";
export interface BuiltServer {
    server: Server;
    toolCount: number;
}
export declare function buildServer(config: Config): Promise<BuiltServer>;
//# sourceMappingURL=server.d.ts.map