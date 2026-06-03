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
 * SMART TOOLS (D13 — thin agent, smart tools): also registers synthetic
 * aggregation tools that return small computed answers instead of raw rows:
 *   - `count_landlord_leads` — four landlord-lead window counts. Tries the
 *     native CRM endpoint /api/v1/analytics/lead-counts first (cheap, computed
 *     server-side) and falls back to full pagination if not deployed.
 *   - `get_ffl_occupancy` — FFL portfolio occupancy (total_doors / occupied /
 *     vacant / occupancy_pct), with the zDUMMY accounting shells + the 1201
 *     Fannin office EXCLUDED. Reads the native endpoint
 *     /api/v1/analytics/ffl-portfolio (no fallback — that endpoint is the only
 *     source that can see property names to exclude dummies). READ-ONLY.
 *
 * Per-agent scoping: append `?tools=a,b,c` to the MCP URL to expose ONLY those
 * tools to a connecting agent (default = all). Lets a single-purpose agent see
 * just the tool it needs. (NOTE: if the credential vault binds the Bearer to the
 * exact base URL, confirm it still injects with a query string before relying on
 * this for a scheduled agent.)
 *
 * Safe-write scaffold (D13): writes are OFF unless VESTLAUNCH_ENABLE_WRITES=true.
 * Even when on, DELETE-method tools are NEVER exposed, and an optional
 * VESTLAUNCH_WRITE_ALLOWLIST (comma-separated tool names) restricts writes to
 * exactly those tools — least privilege for any future "acting" agent.
 *
 * Auth: a single static Bearer token (MCP_BEARER_TOKEN), injected by the
 * Managed Agents credential vault on connect.
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
  writeAllowlist: Set<string> | null;
}

function loadCfg(): Cfg {
  const baseUrl = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.VESTLAUNCH_API_KEY ?? "").trim();
  if (!baseUrl) throw new Error("Missing env: VESTLAUNCH_BASE_URL");
  if (!apiKey) throw new Error("Missing env: VESTLAUNCH_API_KEY");
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const allowRaw = (process.env.VESTLAUNCH_WRITE_ALLOWLIST ?? "").trim();
  const writeAllowlist = allowRaw
    ? new Set(allowRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  return {
    baseUrl,
    apiKey,
    enableWrites: (process.env.VESTLAUNCH_ENABLE_WRITES ?? "").trim().toLowerCase() === "true",
    timeoutMs: Number.isFinite(t) && t > 0 ? t : 30_000,
    writeAllowlist,
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
  cfg: Cfg,
  scopes: ReadonlyArray<string>,
): ToolDef | null {
  const isWrite = WRITE_METHODS.includes(tool.method);
  if (isWrite) {
    if (!cfg.enableWrites) return null;
    // Safe-write scaffold: never expose destructive DELETEs through this MCP.
    if (tool.method === "DELETE") return null;
    // If an allowlist is configured, only expose explicitly-named write tools.
    if (cfg.writeAllowlist && !cfg.writeAllowlist.has(tool.name)) return null;
  }
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

// ───────────────────────── SMART TOOL: count_landlord_leads ─────────────────────────
// Thin-agent / smart-tools (D13). Returns just the four window counts. Tries the native
// CRM endpoint /api/v1/analytics/lead-counts first (cheap, server-side); falls back to
// full pagination + in-function bucketing if that endpoint isn't deployed (404) or errors.
// READ-ONLY. Week window = Sunday–Saturday (Mo, 2026-06-02).
const COUNT_TOOL_NAME = "count_landlord_leads";
const COUNT_TOOL_DESC =
  "Smart server-side aggregation: returns the count of NEW VALID landlord leads for four " +
  "windows in America/Chicago. LOCKED valid-lead definition: pipeline.name == 'Landlord Leads', " +
  "createdAt in window, EXCLUDING stage DOESNT_QUALIFY and test contacts whose " +
  "primaryContact.email ends in @flatfeelandlord.com / @hashemre.com / @example.com / " +
  "@example.org (gmail plus-addressing kept). Windows: This Week = Sunday-Saturday; This Month " +
  "= month-to-date; Last Month = previous full calendar month; Quarter = current calendar " +
  "quarter-to-date. Returns { this_week, this_month, last_month, quarter, total_pulled, " +
  "doesnt_qualify, as_of, window_bounds, source }. Optional 'as_of' (YYYY-MM-DD). Read-only.";
const COUNT_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    as_of: {
      type: "string",
      description:
        "Optional reference date YYYY-MM-DD (America/Chicago). Windows computed as of the end " +
        "of that day. Defaults to the current time.",
    },
  },
  additionalProperties: false,
};

const LANDLORD_PIPELINE_NAME = "Landlord Leads";
const DISQUALIFIED_STAGE = "DOESNT_QUALIFY";
const TEST_EMAIL_SUFFIXES = ["@flatfeelandlord.com", "@hashemre.com", "@example.com", "@example.org"];
const CT_TZ = "America/Chicago";
// Week runs Sunday–Saturday (Mo, 2026-06-02). Sun=0 .. Sat=6.
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface CtParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}
function ctParts(d: Date): CtParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WD[get("weekday")] ?? 0,
  };
}
const pad2 = (n: number): string => String(n).padStart(2, "0");
const dateNum = (p: { year: number; month: number; day: number }): number =>
  p.year * 10000 + p.month * 100 + p.day;

async function countViaNativeEndpoint(cfg: Cfg, asOf: string): Promise<Record<string, unknown> | null> {
  const query: Record<string, unknown> = {};
  if (asOf) query.as_of = asOf;
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/lead-counts", query);
  if (!resp.success) return null; // 404 (not deployed yet) or error → caller falls back
  const d = resp.data;
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (typeof o.this_week !== "number") return null; // unexpected shape → fall back
  return {
    this_week: o.this_week,
    this_month: o.this_month,
    last_month: o.last_month,
    quarter: o.quarter,
    total_pulled: o.total_opportunities ?? o.total_pulled ?? null,
    doesnt_qualify: o.doesnt_qualify ?? null,
    as_of: o.as_of,
    window_bounds: o.window_bounds,
    source: "native:/api/v1/analytics/lead-counts",
  };
}

async function countViaPagination(cfg: Cfg, asOf: string): Promise<Record<string, unknown>> {
  let refDate: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    refDate = new Date(`${asOf}T12:00:00Z`);
  } else {
    refDate = new Date();
  }
  const ref = ctParts(refDate);
  const refNum = dateNum(ref);
  const refNoonUtc = new Date(`${ref.year}-${pad2(ref.month)}-${pad2(ref.day)}T12:00:00Z`);
  const weekStartDate = new Date(refNoonUtc.getTime() - ref.weekday * 86_400_000);
  const weekStart = ctParts(weekStartDate);
  const weekStartNum = dateNum(weekStart);
  const lmYear = ref.month === 1 ? ref.year - 1 : ref.year;
  const lmMonth = ref.month === 1 ? 12 : ref.month - 1;
  const quarterStartMonth = Math.floor((ref.month - 1) / 3) * 3 + 1;

  const limit = 100;
  const batch = 8;
  const all: any[] = [];
  let base = 0;
  let done = false;
  let guard = 0;
  while (!done && guard < 2000) {
    const offsets = Array.from({ length: batch }, (_, i) => base + i * limit);
    const results = await Promise.all(
      offsets.map((off) => crmRequest<any[]>(cfg, "GET", "/api/v1/opportunities", { limit, offset: off })),
    );
    for (let i = 0; i < results.length; i++) {
      const resp = results[i]!;
      if (!resp.success) {
        throw new Error(
          `opportunities fetch failed at offset ${offsets[i]} (HTTP ${resp.statusCode}): ${resp.error}`,
        );
      }
      const rows = Array.isArray(resp.data) ? resp.data : [];
      all.push(...rows);
      if (rows.length < limit) done = true;
    }
    base += batch * limit;
    guard++;
  }

  let this_week = 0;
  let this_month = 0;
  let last_month = 0;
  let quarter = 0;
  let doesnt_qualify = 0;

  for (const o of all) {
    if (o?.pipeline?.name !== LANDLORD_PIPELINE_NAME) continue;
    if (o?.stage === DISQUALIFIED_STAGE) {
      doesnt_qualify++;
      continue;
    }
    const email = String(o?.primaryContact?.email ?? "").trim().toLowerCase();
    if (TEST_EMAIL_SUFFIXES.some((s) => email.endsWith(s))) continue;
    const createdRaw = o?.createdAt;
    if (typeof createdRaw !== "string") continue;
    const cd = new Date(createdRaw);
    if (Number.isNaN(cd.getTime())) continue;
    const c = ctParts(cd);
    const cNum = dateNum(c);
    if (cNum > refNum) continue;
    if (cNum >= weekStartNum) this_week++;
    if (c.year === ref.year && c.month === ref.month) this_month++;
    if (c.year === lmYear && c.month === lmMonth) last_month++;
    if (c.year === ref.year && c.month >= quarterStartMonth && c.month <= ref.month) quarter++;
  }

  return {
    this_week,
    this_month,
    last_month,
    quarter,
    total_pulled: all.length,
    doesnt_qualify,
    as_of: `${ref.year}-${pad2(ref.month)}-${pad2(ref.day)}`,
    window_bounds: {
      timezone: CT_TZ,
      week: "Sunday–Saturday",
      this_week_start: `${weekStart.year}-${pad2(weekStart.month)}-${pad2(weekStart.day)}`,
      this_month: `${ref.year}-${pad2(ref.month)}`,
      last_month: `${lmYear}-${pad2(lmMonth)}`,
      quarter_start_month: `${ref.year}-${pad2(quarterStartMonth)}`,
    },
    source: "fallback:pagination",
  };
}

async function countLandlordLeads(cfg: Cfg, args: Record<string, unknown>): Promise<unknown> {
  const asOf = typeof args.as_of === "string" ? args.as_of.trim() : "";
  const native = await countViaNativeEndpoint(cfg, asOf);
  if (native) return native;
  return countViaPagination(cfg, asOf);
}

// ───────────────────────── SMART TOOL: get_ffl_occupancy ─────────────────────────
// Thin-agent / smart-tools (D13). Returns FFL portfolio occupancy computed server-side
// from the AppFolio rent roll, with the zDUMMY accounting shells + the 1201 Fannin office
// EXCLUDED. Reads the native CRM endpoint /api/v1/analytics/ffl-portfolio — there is NO
// pagination fallback because only that endpoint can see property names to drop dummies.
// READ-ONLY.
const FFL_OCC_TOOL_NAME = "get_ffl_occupancy";
const FFL_OCC_TOOL_DESC =
  "Smart server-side aggregation: returns FFL portfolio occupancy with dummy accounts EXCLUDED. " +
  "Drops any property whose name matches /zdummy/i (the 'zDUMMY <STATE>-Flat Fee Landlord, LLC.' " +
  "accounting shells) and the 1201 Fannin office; every other unit is a real FFL door. Occupied = " +
  "unit status not matching /vacant/i. Returns { total_doors, occupied, vacant, occupancy_pct, " +
  "excluded_dummy_units, raw_total_units, excluded_properties, status_breakdown, as_of, source }. " +
  "Source = AppFolio rent_roll via /api/v1/analytics/ffl-portfolio. No arguments. Read-only.";
const FFL_OCC_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflOccupancy(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-portfolio");
  if (!resp.success) {
    throw new Error(
      `ffl-portfolio endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-portfolio (ffl-crm PR #527) to be deployed " +
        "and the Bearer key to have scope properties:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).total_doors !== "number") {
    throw new Error("ffl-portfolio endpoint returned an unexpected shape (no numeric total_doors).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-portfolio" };
}

// ───────────────────────── server bootstrap ─────────────────────────
// --- SMART TOOL: get_ffl_renewals ---
// Thin-agent / smart-tools (D13). Returns FFL lease-renewal metrics (Company Numbers
// row 9, B9-F9) computed server-side from AppFolio, dummy accounts EXCLUDED. Reads the
// native CRM endpoint /api/v1/analytics/ffl-renewals - no fallback (only that endpoint
// can see property names to drop dummies and stitch lease_expiration_detail + lease_history).
// READ-ONLY.
const FFL_REN_TOOL_NAME = "get_ffl_renewals";
const FFL_REN_TOOL_DESC =
  "Smart server-side aggregation: returns FFL lease-renewal metrics for Company Numbers " +
  "row 9 (B9-F9), dummy accounts EXCLUDED (/zdummy/i + 1201 Fannin). Computed from AppFolio " +
  "rent_roll + lease_expiration_detail + lease_history. Returns { this_month_expiring (B9), " +
  "this_month_expiring_detail, pending_signature (C9), signed_renewals_this_month (D9), " +
  "eligible_label (E9, e.g. 'Jun(2) - Jul(1) - Aug(8)'), eligible_buckets, renewal_pct_90d (F9), " +
  "renewal_pct_components, window, excluded_properties, as_of, source }. today = America/Chicago, " +
  "+90 strict. Source = /api/v1/analytics/ffl-renewals. No arguments. Read-only.";
const FFL_REN_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflRenewals(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-renewals");
  if (!resp.success) {
    throw new Error(
      `ffl-renewals endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-renewals (ffl-crm PR #540) to be deployed " +
        "and the Bearer key to have scope properties:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).this_month_expiring !== "number") {
    throw new Error("ffl-renewals endpoint returned an unexpected shape (no numeric this_month_expiring).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-renewals" };
}

// --- SMART TOOL: get_ffl_delinquency ---
// Thin-agent / smart-tools (D13). Returns FFL delinquency metrics (Company Numbers
// row 14, B14-F14) computed server-side from AppFolio, dummy accounts EXCLUDED. Reads
// the native CRM endpoint /api/v1/analytics/ffl-delinquency - no fallback (only that
// endpoint can see property names to drop dummies and sum charge_detail/delinquency).
// READ-ONLY.
const FFL_DEL_TOOL_NAME = "get_ffl_delinquency";
const FFL_DEL_TOOL_DESC =
  "Smart server-side aggregation: returns FFL delinquency metrics for Company Numbers " +
  "row 14 (B14-F14), dummy accounts EXCLUDED (/zdummy/i + 1201 Fannin). Computed from AppFolio " +
  "delinquency + charge_detail + rent_roll. Returns { delinquency_pct (B14, LIVE 'today'), " +
  "start_of_week_pct (C14), balances_over_500 (D14), evictions_filed (E14), last_month_pct (F14, " +
  "null until a month-end is observed => skip the cell), delinquency_components, " +
  "charge_detail_diagnostics, evictions_detail, delinquency_history, window, excluded_properties, " +
  "as_of, source }. B14 = gross aging-bucket balance / sum(charge_detail Occupancy charges " +
  "this month); it is date-sensitive (high right after the 1st, falls as auto-pay clears). today = " +
  "America/Chicago. Source = /api/v1/analytics/ffl-delinquency. No arguments. Read-only.";
const FFL_DEL_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflDelinquency(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-delinquency");
  if (!resp.success) {
    throw new Error(
      `ffl-delinquency endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-delinquency (ffl-crm PR #542) to be deployed " +
        "and the Bearer key to have scope properties:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).delinquency_pct !== "number") {
    throw new Error("ffl-delinquency endpoint returned an unexpected shape (no numeric delinquency_pct).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-delinquency" };
}

// --- SMART TOOL: get_ffl_homes ---
// Thin-agent / smart-tools (D13). Returns FFL "Homes" metrics (Company Numbers row 20,
// A20/B20/D20/E20) computed server-side from ShowMojo + AppFolio. Reads the native CRM
// endpoint /api/v1/analytics/ffl-homes - no fallback (only that endpoint can join
// ShowMojo listings with the AppFolio rent roll and exclude Z-named/dummy properties).
// READ-ONLY.
const FFL_HOMES_TOOL_NAME = "get_ffl_homes";
const FFL_HOMES_TOOL_DESC =
  "Smart server-side aggregation: returns FFL 'Homes' metrics for Company Numbers row 20 " +
  "(A20/B20/D20/E20). Combines ShowMojo listings with the AppFolio rent roll. Returns " +
  "{ homes_listed (A20 = count of ShowMojo RENT + STATUS_ACTIVE listings), listed_rent_total " +
  "(B20 = sum of their rent), homes_to_list (D20 = AppFolio Vacant-Unrented/Notice-Unrented, " +
  "not pre-leased, name not starting with Z, 1201 Fannin excluded, and NOT already on ShowMojo), " +
  "fmr_potential (E20 = sum of advertised->market->current rent over D20), homes_components, " +
  "showmojo_diagnostics, rent_roll_status_breakdown, rent_roll_sample_keys, to_list_sample, " +
  "window, cells, as_of, source }. C20 is a blank separator (never written). IMPORTANT: if " +
  "showmojo_diagnostics.ok is false or auth_style is null, the ShowMojo token/header failed - " +
  "A20/B20 read 0 and D20 is over-counted; do NOT write the sheet in that case. " +
  "Source = /api/v1/analytics/ffl-homes. No arguments. Read-only.";
const FFL_HOMES_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflHomes(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-homes");
  if (!resp.success) {
    throw new Error(
      `ffl-homes endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-homes (ffl-crm PR #552) to be deployed, " +
        "SHOWMOJO_API_TOKEN set in ffl-crm env, and the Bearer key to have scope properties:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).homes_listed !== "number") {
    throw new Error("ffl-homes endpoint returned an unexpected shape (no numeric homes_listed).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-homes" };
}

const VALID_METHODS: ReadonlyArray<HttpMethod> = ["GET", "POST", "PATCH", "DELETE", "PUT"];

async function buildServer(cfg: Cfg, toolFilter: Set<string> | null): Promise<Server> {
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
    if (toolFilter && !toolFilter.has(t.name)) continue;
    const d = buildToolDef(t, cfg, scopes);
    if (d) defs.push(d);
  }
  const byName = new Map<string, ToolDef>();
  for (const d of defs) byName.set(d.name, d);

  const includeCountTool = !toolFilter || toolFilter.has(COUNT_TOOL_NAME);
  const includeFflOccTool = !toolFilter || toolFilter.has(FFL_OCC_TOOL_NAME);
  const includeFflRenTool = !toolFilter || toolFilter.has(FFL_REN_TOOL_NAME);
  const includeFflDelTool = !toolFilter || toolFilter.has(FFL_DEL_TOOL_NAME);
  const includeFflHomesTool = !toolFilter || toolFilter.has(FFL_HOMES_TOOL_NAME);

  const server = new Server({ name: "vestlaunch-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema })),
      ...(includeCountTool
        ? [{ name: COUNT_TOOL_NAME, description: COUNT_TOOL_DESC, inputSchema: COUNT_TOOL_SCHEMA }]
        : []),
      ...(includeFflOccTool
        ? [{ name: FFL_OCC_TOOL_NAME, description: FFL_OCC_TOOL_DESC, inputSchema: FFL_OCC_TOOL_SCHEMA }]
        : []),
      ...(includeFflRenTool
        ? [{ name: FFL_REN_TOOL_NAME, description: FFL_REN_TOOL_DESC, inputSchema: FFL_REN_TOOL_SCHEMA }]
        : []),
      ...(includeFflDelTool
        ? [{ name: FFL_DEL_TOOL_NAME, description: FFL_DEL_TOOL_DESC, inputSchema: FFL_DEL_TOOL_SCHEMA }]
        : []),
      ...(includeFflHomesTool
        ? [{ name: FFL_HOMES_TOOL_NAME, description: FFL_HOMES_TOOL_DESC, inputSchema: FFL_HOMES_TOOL_SCHEMA }]
        : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    if (name === COUNT_TOOL_NAME) {
      if (!includeCountTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await countLandlordLeads(cfg, (rawArgs ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${COUNT_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_OCC_TOOL_NAME) {
      if (!includeFflOccTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflOccupancy(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_OCC_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_REN_TOOL_NAME) {
      if (!includeFflRenTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflRenewals(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_REN_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_DEL_TOOL_NAME) {
      if (!includeFflDelTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflDelinquency(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_DEL_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_HOMES_TOOL_NAME) {
      if (!includeFflHomesTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflHomes(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_HOMES_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

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

function parseToolFilter(reqUrl: string | undefined): Set<string> | null {
  if (!reqUrl) return null;
  try {
    const u = new URL(reqUrl, "http://localhost");
    const raw = u.searchParams.get("tools");
    if (!raw) return null;
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return names.length > 0 ? new Set(names) : null;
  } catch {
    return null;
  }
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

  const toolFilter = parseToolFilter(req.url);

  let server: Server;
  try {
    server = await buildServer(loadCfg(), toolFilter);
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
