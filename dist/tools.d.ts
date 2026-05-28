/**
 * Manifest-driven tool registry.
 *
 * Each entry in the CRM's tool manifest becomes one MCP tool. Path
 * parameters (`:id`, `:stepId`, etc.) surface as required string args.
 * GET tools also accept an optional `query` object; non-GET tools
 * accept an optional `body` object.
 *
 * Tools are registered under the `vestlaunch_` prefix to avoid name
 * collisions with other MCP servers loaded into the same agent.
 */
import type { ApiClient, HttpMethod } from "./api-client.js";
import type { ManifestTool } from "./manifest.js";
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties: boolean;
    };
    meta: {
        method: HttpMethod;
        pathTemplate: string;
        scope: string;
        isWrite: boolean;
    };
}
export interface BuildOptions {
    enableWrites: boolean;
    availableScopes: ReadonlyArray<string>;
}
/**
 * Convert a manifest entry to an MCP tool definition. Returns null if
 * the tool should be skipped (writes disabled, or the key lacks the
 * required scope).
 */
export declare function buildToolDefinition(tool: ManifestTool, opts: BuildOptions): McpToolDefinition | null;
/**
 * Execute a tool against the CRM. Inputs are validated minimally —
 * heavy validation lives server-side in the route handler.
 */
export declare function executeTool(client: ApiClient, def: McpToolDefinition, rawInput: Record<string, unknown>): Promise<unknown>;
//# sourceMappingURL=tools.d.ts.map