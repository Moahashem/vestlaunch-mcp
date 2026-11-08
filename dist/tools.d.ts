/**
 * Manifest-driven tool registry.
 *
 * Each entry in the CRM's tool manifest becomes one MCP tool. Path
 * parameters (`:id`, `:stepId`, etc.) surface as required string args.
 * GET tools also accept an optional `query` object; non-GET tools
 * accept an optional `body` object.
 *
 * Tool names are used as-is. The MCP host already namespaces every tool
 * by server (e.g. `mcp__vestlaunch__create_segment`), so an extra
 * `vestlaunch_` prefix would be redundant double-namespacing. Keeping the
 * bare CRM capability name keeps tool names stable and clean.
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
        /**
         * true  → args are FLAT (top-level), routed to path/query/body by name+method
         *         (used when the manifest published an inputSchema).
         * false → legacy shape: path params + a single `query`/`body` object arg.
         */
        flat: boolean;
    };
}
export interface BuildOptions {
    enableWrites: boolean;
    availableScopes: ReadonlyArray<string>;
    /**
     * Hide account administration even when writes are on: creating or
     * deleting workspaces, API keys and webhooks. Set per connector with
     * VESTLAUNCH_BLOCK_ADMIN=true (Mo, 2026-10-13 — the Cranbrook desktop
     * connector gets full read/write on Cranbrook records, not the keys to
     * the building). Reads are never hidden.
     */
    blockAdmin?: boolean;
}
/** Account administration: workspace, API-key and webhook changes. Reads excluded. */
export declare function isAdminTool(tool: {
    method: string;
    name: string;
    scope?: string;
}): boolean;
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