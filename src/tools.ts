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
import { extractPathParams, substitutePath } from "./manifest.js";

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

const TOOL_PREFIX = "";
const WRITE_METHODS: ReadonlyArray<HttpMethod> = ["POST", "PATCH", "PUT", "DELETE"];

export interface BuildOptions {
  enableWrites: boolean;
  availableScopes: ReadonlyArray<string>;
}

/**
 * Convert a manifest entry to an MCP tool definition. Returns null if
 * the tool should be skipped (writes disabled, or the key lacks the
 * required scope).
 */
export function buildToolDefinition(
  tool: ManifestTool,
  opts: BuildOptions,
): McpToolDefinition | null {
  const isWrite = WRITE_METHODS.includes(tool.method);
  if (isWrite && !opts.enableWrites) return null;
  if (!hasScopeFor(tool.scope, opts.availableScopes)) return null;

  const writeBanner = isWrite ? "[WRITE] " : "";
  const description =
    `${writeBanner}${tool.description} ` +
    `(${tool.method} ${tool.path}, scope: ${tool.scope})`;

  // ── Preferred: schema-driven (the CRM manifest published an inputSchema) ──
  // Register the tool with the manifest's flat argument schema directly, so
  // every parameter is named, typed, and documented to the model.
  // s31 — an EMPTY `properties` bag is a real answer, not a missing one. The
  // old `length > 0` test demoted every genuinely no-argument endpoint
  // (get_pipelines, list_tags, list_lead_sources, get_me, list_api_keys,
  // list_webhooks) to the legacy fallback, which then invented a `query` blob
  // and told the model to fill it. "This tool takes nothing" is more useful
  // than "this tool takes an undocumented object".
  const schema = tool.inputSchema;
  if (schema && isPlainObject(schema.properties)) {
    const req = Array.isArray(schema.required) ? schema.required : [];
    return {
      name: `${TOOL_PREFIX}${tool.name}`,
      description,
      inputSchema: {
        type: "object",
        properties: schema.properties as Record<string, unknown>,
        required: req.length > 0 ? req : undefined,
        additionalProperties: schema.additionalProperties === true,
      },
      meta: {
        method: tool.method,
        pathTemplate: tool.path,
        scope: tool.scope,
        isWrite,
        flat: true,
      },
    };
  }

  // ── Fallback (legacy): path params + a generic query/body blob ──
  // Used only for tools the manifest hasn't given a schema yet.
  const pathParams = extractPathParams(tool.path);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

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
      description:
        "Optional query-string parameters. Keys are passed as ?key=value. " +
        "See description for supported filters (limit, offset, search, etc.).",
      additionalProperties: { type: ["string", "number", "boolean", "null"] },
    };
  } else {
    properties.body = {
      type: "object",
      description:
        "Request body sent as JSON. See description for required and " +
        "optional fields.",
      additionalProperties: true,
    };
  }

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
      flat: false,
    },
  };
}

function hasScopeFor(required: string, available: ReadonlyArray<string>): boolean {
  // Wildcard scope handling — the CRM uses "*" to mean "any scope".
  if (required === "*") return true;
  if (available.includes("*")) return true;
  return available.includes(required);
}

/**
 * Execute a tool against the CRM. Inputs are validated minimally —
 * heavy validation lives server-side in the route handler.
 */
export async function executeTool(
  client: ApiClient,
  def: McpToolDefinition,
  rawInput: Record<string, unknown>,
): Promise<unknown> {
  const pathParams = extractPathParams(def.meta.pathTemplate);
  const paramValues: Record<string, string> = {};
  for (const param of pathParams) {
    const raw = rawInput[param];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`Missing or invalid path parameter: ${param}`);
    }
    paramValues[param] = raw;
  }
  const path = substitutePath(def.meta.pathTemplate, paramValues);

  let query: Record<string, string | number | boolean | undefined | null> | undefined;
  let body: unknown;

  if (def.meta.flat) {
    // Flat args: everything except path params routes to the query string
    // (GET) or the JSON body (writes).
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawInput)) {
      if (pathParams.includes(key) || value === undefined) continue;
      rest[key] = value;
    }
    if (def.meta.method === "GET") {
      query = rest as Record<string, string | number | boolean | undefined | null>;
    } else {
      body = rest;
    }
  } else {
    // Legacy shape: a single `query` / `body` object argument.
    query =
      def.meta.method === "GET" && isPlainObject(rawInput.query)
        ? (rawInput.query as Record<string, string | number | boolean | undefined | null>)
        : undefined;
    // s31 — a write ALWAYS carries an object, even an empty one. Leaving this
    // `undefined` sent `Content-Type: application/json` with no payload, and
    // the CRM route's `await req.json()` answered 400 "Invalid JSON" before it
    // ever read a field. `{}` earns the route's real validation message
    // ("No updatable fields provided") instead of a parse error that looks
    // like a connector bug. See the encoding contract in api-client.ts.
    body =
      def.meta.method === "GET"
        ? undefined
        : isPlainObject(rawInput.body)
          ? rawInput.body
          : {};
  }

  // s31 — DELETE carries its arguments in BOTH the query string and the body.
  //
  // A DELETE has no settled convention for where parameters live, and the CRM
  // is split down the middle: the nine `/:id` deletes take theirs in the path,
  // but `delete_agent_state` (`agentKey`, `key`) and `delete_knowledge` (`id`)
  // read `request.nextUrl.searchParams`. We sent body-only, so both tools were
  // 100% unusable — they answered "…query params required" for parameters the
  // caller had supplied, which reads as a caller error and is not one.
  //
  // Duplicating into the query string costs nothing (a route that reads the
  // body ignores it, and vice versa) and means the connector no longer has to
  // know which convention each route picked. Scalars only — a nested object
  // would stringify to "[object Object]" in a URL, and any route wanting
  // structure reads the body anyway.
  if (def.meta.method === "DELETE" && isPlainObject(body)) {
    const scalars: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") scalars[k] = v;
    }
    if (Object.keys(scalars).length > 0) query = { ...(query ?? {}), ...scalars };
  }

  const response = await client.request({
    method: def.meta.method,
    path,
    query,
    body,
  });
  return response;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
