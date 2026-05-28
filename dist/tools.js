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
import { extractPathParams, substitutePath } from "./manifest.js";
const TOOL_PREFIX = "vestlaunch_";
const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];
/**
 * Convert a manifest entry to an MCP tool definition. Returns null if
 * the tool should be skipped (writes disabled, or the key lacks the
 * required scope).
 */
export function buildToolDefinition(tool, opts) {
    const isWrite = WRITE_METHODS.includes(tool.method);
    if (isWrite && !opts.enableWrites)
        return null;
    if (!hasScopeFor(tool.scope, opts.availableScopes))
        return null;
    const pathParams = extractPathParams(tool.path);
    const properties = {};
    const required = [];
    for (const param of pathParams) {
        properties[param] = {
            type: "string",
            description: `Path parameter (${param}) — the CRM record id to operate on.`,
        };
        required.push(param);
    }
    if (tool.method === "GET") {
        properties.query = {
            type: "object",
            description: "Optional query-string parameters. Keys are passed as ?key=value. " +
                "See description for supported filters (limit, offset, search, etc.).",
            additionalProperties: { type: ["string", "number", "boolean", "null"] },
        };
    }
    else {
        properties.body = {
            type: "object",
            description: "Request body sent as JSON. See description for required and " +
                "optional fields.",
            additionalProperties: true,
        };
    }
    const writeBanner = isWrite ? "[WRITE] " : "";
    const description = `${writeBanner}${tool.description} ` +
        `(${tool.method} ${tool.path}, scope: ${tool.scope})`;
    return {
        name: `${TOOL_PREFIX}${tool.name}`,
        description,
        inputSchema: {
            type: "object",
            properties,
            required: required.length > 0 ? required : undefined,
            additionalProperties: false,
        },
        meta: {
            method: tool.method,
            pathTemplate: tool.path,
            scope: tool.scope,
            isWrite,
        },
    };
}
function hasScopeFor(required, available) {
    // Wildcard scope handling — the CRM uses "*" to mean "any scope".
    if (required === "*")
        return true;
    if (available.includes("*"))
        return true;
    return available.includes(required);
}
/**
 * Execute a tool against the CRM. Inputs are validated minimally —
 * heavy validation lives server-side in the route handler.
 */
export async function executeTool(client, def, rawInput) {
    const pathParams = extractPathParams(def.meta.pathTemplate);
    const paramValues = {};
    for (const param of pathParams) {
        const raw = rawInput[param];
        if (typeof raw !== "string" || raw.length === 0) {
            throw new Error(`Missing or invalid path parameter: ${param}`);
        }
        paramValues[param] = raw;
    }
    const path = substitutePath(def.meta.pathTemplate, paramValues);
    const query = def.meta.method === "GET" && isPlainObject(rawInput.query)
        ? rawInput.query
        : undefined;
    const body = def.meta.method !== "GET" && isPlainObject(rawInput.body)
        ? rawInput.body
        : undefined;
    const response = await client.request({
        method: def.meta.method,
        path,
        query,
        body,
    });
    return response;
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=tools.js.map