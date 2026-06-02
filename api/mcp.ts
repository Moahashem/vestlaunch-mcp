/**
 * VestLaunch MCP — HTTP (Streamable) transport for Vercel.
 *
 * SELF-CONTAINED on purpose: this file imports ONLY the MCP SDK and node:http,
 * with no relative imports into ../src or ../dist. That keeps Vercel from
 * auto-detecting the repo's stdio entry point (src/index.ts) as a root server
 * and lets it deploy this as a normal /api serverless function. The repo's
 * stdio MCP (src/*, dist/*) is unchanged and still used by local clients.
 *
 * Mirrors the stdio server's behavior: loads the CRM tool manifest from
 * /api/v1/me, registers each capability as an MCP tool (read-only unless
 * VESTLAUNCH_ENABLE_WRITES=true — left off here), and proxies tool calls to
 * the CRM /api/v1/* surface with the agent's Bearer key.
 *
 * Auth: a single static Bearer token (MCP_BEARER_TOKEN). The Claude Managed
 * Agents credential vault stores this token bound to this URL and injects it
 * on connect; requests without the matching Bearer are rejected.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const config = { maxDuration: 60 };

// ───────────────────────── config ─────────────────────────
type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

interface Cfg {
  baseUrl: string;
  apiKey: string;
  enableWrites: boolean;
  timeoutMs: number;
}

function loadCfg(): Cfg {
  const baseUrl = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.VESTLAUNCH_API_KEY ?? "").trim();
  if (!baseUrl) throw new Error("Missing env: VESTLAUNCH_BASE_URL");
  if (!apiKey) throw new Error("Missing env: VESTLAUNCH_API_KEY");
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  return {
    baseUrl,
    apiKey,
    enableWrites: (process.env.VESTLAUNCH_ENABLE_WRITES ?? "").trim().toLowerCase() === "true",
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 30_000,
  };
}

// ───────────────────────── CRM client ─────────────────────────
type ApiResp<T = unknown> =
  | ({ success: true; data: T } & Record<string, unknown>)
  | { success: false; error: string; statusCode: number };

async function crmRequest<T = unknown>(
  cfg: Cfg,
  method: HttpMethod,
  path: string,
  query?: Record<string, unknown>,
  body?: unknown,
): Promise<ApiResp<T>> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${cfg.baseUrl}${trimmed}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "vestlaunch-mcp-http/0.1.0",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text };
      }
    }
    if (!res.ok) {
      const err =
        json && typeof json === "object" && typeof (json as Record<string, unknown>).error === "string"
          ? ((json as Record<string, unknown>).error as string)
          : `HTTP ${res.status} ${res.statusText}`;
      return { success: false, error: err, statusCode: res.status };
    }
    const b = (json ?? {}) as Record<string, unknown>;
    const meta = (b.meta && typeof b.meta === "object" ? b.meta : {}) as Record<string, unknown>;
    return { success: true, data: (b.data === undefined ? null : b.data) as T, ...meta };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), statusCode: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── manifest + tools ─────────────────────────
interface ManifestTool {
  name: string;
  method: HttpMethod;
  path: string;
  scope: string;
  description: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: boolean;
  };
  meta: { method: HttpMethod; pathTemplate: string; isWrite: boolean; flat: boolean };
}

const WRITE_METHODS: ReadonlyArray<HttpMethod> = ["POST", "PATCH", "PUT", "DELETE"];
const PARAM_PATTERN = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

function pathParams(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(PARAM_PATTERN)) if (m[1]) out.push(m[1]);
  return out;
}
function substitute(path: string, params: Record<string, string>): string {
  return path.replace(PARAM_PATTERN, (_, k: string) => {
    const v = params[k];
    if (v === undefined || v === "") throw new Error(`Missing required path parameter: ${k}`);
    return encodeURIComponent(v);
  });
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function hasScope(required: string, available: ReadonlyArray<string>): boolean {
  return required === "*" || available.includes("*") || available.includes(required);
}

function buildToolDef(
  tool: ManifestTool,
  enableWrites: boolean,
  scopes: ReadonlyArray<string>,
): ToolDef | null {
  const isWrite = WRITE_METHODS.includes(tool.method);
  if (isWrite && !enableWrites) return null;
  if (!hasScope(tool.scope, scopes)) return null;
  const desc = `${isWrite ? "[WRITE] " : ""}${tool.description} (${tool.method} ${tool.path}, scope: ${tool.scope})`;
  const schema = tool.inputSchema;
  if (schema && isObj(schema.properties) && Object.keys(schema.properties).length > 0) {
    const req = Array.isArray(schema.required) ? schema.required : [];
    return {
      name: tool.name,
      description: desc,
      inputSchema: {
        type: "object",
        properties: schema.properties,
        required: req.length > 0 ? req : undefined,
        additionalProperties: schema.additionalProperties === true,
      },
      meta: { method: tool.method, pathTemplate: tool.path, isWrite, flat: true },
    };
  }
  const params = pathParams(tool.path);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p] = { type: "string", description: `Path parameter (${p}).` };
    required.push(p);
  }
  if (tool.method === "GET") {
    properties.query = {
      type: "object",
      description: "Optional query-string parameters (limit, offset, search, etc.).",
      additionalProperties: { type: ["string", "number", "boolean", "null"] },
    };
  } else {
    properties.body = { type: "object", description: "Request body sent as JSON.", additionalProperties: true };
  }
  return {
    name: tool.name,
    description: desc,
    inputSchema: {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    },
    meta: { method: tool.method, pathTemplate: tool.path, isWrite, flat: false },
  };
}

async function executeTool(cfg: Cfg, def: ToolDef, raw: Record<string, unknown>): Promise<unknown> {
  const params = pathParams(def.meta.pathTemplate);
  const pv: Record<string, string> = {};
  for (const p of params) {
    const v = raw[p];
    if (typeof v !== "string" || v.length === 0) throw new Error(`Missing or invalid path parameter: ${p}`);
    pv[p] = v;
  }
  const path = substitute(def.meta.pathTemplate, pv);
  let query: Record<string, unknown> | undefined;
  let body: unknown;
  if (def.meta.flat) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (params.includes(k) || v === undefined) continue;
      rest[k] = v;
    }
    if (def.meta.method === "GET") query = rest;
    else body = rest;
  } else {
    query = def.meta.method === "GET" && isObj(raw.query) ? raw.query : undefined;
    body = def.meta.method !== "GET" && isObj(raw.body) ? raw.body : undefined;
  }
  return crmRequest(cfg, def.meta.method, path, query, body);
}

// ───────────────────────── server bootstrap ─────────────────────────
const VALID_METHODS: ReadonlyArray<HttpMethod> = ["GET", "POST", "PATCH", "DELETE", "PUT"];

async function buildServer(cfg: Cfg): Promise<Server> {
  const me = await crmRequest<{ identity?: { scopes?: string[] }; capabilities?: ManifestTool[] }>(
    cfg,
    "GET",
    "/api/v1/me",
  );
  if (!me.success) {
    throw new Error(`Failed to load tool manifest from /api/v1/me (HTTP ${me.statusCode}): ${me.error}`);
  }
  const data = me.data ?? {};
  const caps = Array.isArray(data.capabilities) ? data.capabilities : [];
  const scopes = data.identity?.scopes ?? [];
  const tools = caps.filter(
    (t): t is ManifestTool =>
      !!t &&
      typeof t.name === "string" &&
      typeof t.method === "string" &&
      VALID_METHODS.includes(t.method as HttpMethod) &&
      typeof t.path === "string" &&
      typeof t.scope === "string" &&
      typeof t.description === "string",
  );
  if (tools.length === 0) throw new Error("Manifest has 0 valid tools.");

  const defs: ToolDef[] = [];
  for (const t of tools) {
    const d = buildToolDef(t, cfg.enableWrites, scopes);
    if (d) defs.push(d);
  }
  const byName = new Map<string, ToolDef>();
  for (const d of defs) byName.set(d.name, d);

  const server = new Server({ name: "vestlaunch-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const def = byName.get(name);
    if (!def) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await executeTool(cfg, def, (rawArgs ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error invoking ${name}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ───────────────────────── HTTP handler ─────────────────────────
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || req.headers["authorization"] !== `Bearer ${expected}`) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }

  let server: Server;
  try {
    server = await buildServer(loadCfg());
  } catch (err) {
    sendJson(res, 500, {
      jsonrpc: "2.0",
      error: { code: -32002, message: `MCP server init failed: ${err instanceof Error ? err.message : String(err)}` },
      id: null,
    });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
