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
 * Auth (three modes, decided by the Bearer token each request carries):
 *   1. SIGN-IN / OAuth (preferred for humans in Claude Desktop): the client has
 *      no field to paste a key. It follows the OAuth 2.1 discovery handshake —
 *      on a 401 it reads our `WWW-Authenticate: Bearer resource_metadata="…"`
 *      header, fetches /.well-known/oauth-protected-resource, logs the person in
 *      against WorkOS AuthKit, and returns with a real WorkOS access token. We
 *      VERIFY that token against AuthKit's JWKS (jose), read the person's email,
 *      then map it to their CRM `ffl_live_` key via MCP_USER_KEY_MAP. The CRM key
 *      never leaves the server; each person acts as themselves in the CRM.
 *   2. PER-USER CRM API KEY: connect with your own CRM key (`ffl_live_...`,
 *      minted in CRM Settings -> API Keys) as the Bearer token. The key is
 *      proxied straight to the CRM, which validates it and returns ONLY the
 *      tools its scopes allow — revoke the key in the CRM and MCP access dies
 *      instantly. Writes are governed by the key's scopes (server-side), so
 *      VESTLAUNCH_ENABLE_WRITES does not apply; DELETE-method tools are still
 *      NEVER exposed.
 *   3. LEGACY shared token (MCP_BEARER_TOKEN): behaves exactly as before —
 *      uses the env VESTLAUNCH_API_KEY, writes gated by
 *      VESTLAUNCH_ENABLE_WRITES + VESTLAUNCH_WRITE_ALLOWLIST. Kept for
 *      existing agents; migrate them to per-user keys over time.
 *
 * The OAuth authorization server (login/consent/token issuance) is WorkOS
 * AuthKit — we do NOT hand-build auth. This file is the OAuth *resource server*:
 * it only verifies tokens and maps identity -> CRM key. See docs/OAUTH-SETUP.md.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { readAccessToken } from "./_oauth";
import {
  APPFOLIO_ENTRY_TOOLS,
  APPFOLIO_ENTRY_TOOL_NAMES,
  appfolioEntryToolsEnabled,
  callAppfolioEntryTool,
} from "./appfolio-entry-tools";

/** The CRM scope a caller's OWN key must carry to see/call the AppFolio
 *  entry-agent tools (they proxy a privileged token — env-present alone is
 *  NOT authorization; adversarial-review fix). */
const APPFOLIO_ENTRY_REQUIRED_SCOPE = "agent:write";

export const config = { maxDuration: 60 };

/** CRM API keys minted in Settings -> API Keys always start with this. */
const CRM_KEY_PREFIX = "ffl_live_";

// ───────────────────────── config ─────────────────────────
type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

interface Cfg {
  baseUrl: string;
  apiKey: string;
  enableWrites: boolean;
  timeoutMs: number;
  writeAllowlist: Set<string> | null;
}

function loadCfg(perUserApiKey?: string): Cfg {
  const baseUrl = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Missing env: VESTLAUNCH_BASE_URL");
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : 30_000;

  if (perUserApiKey) {
    // Per-user mode: the connecting user's own CRM key. The CRM enforces the
    // key's scopes server-side (and the blast guardrail is server-enforced),
    // so writes are allowed here and scoping comes from /api/v1/me.
    return { baseUrl, apiKey: perUserApiKey, enableWrites: true, timeoutMs, writeAllowlist: null };
  }

  // Legacy mode: shared env key, writes gated by env flags (unchanged).
  const apiKey = (process.env.VESTLAUNCH_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("Missing env: VESTLAUNCH_API_KEY");
  const allowRaw = (process.env.VESTLAUNCH_WRITE_ALLOWLIST ?? "").trim();
  const writeAllowlist = allowRaw
    ? new Set(allowRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  return {
    baseUrl,
    apiKey,
    enableWrites: (process.env.VESTLAUNCH_ENABLE_WRITES ?? "").trim().toLowerCase() === "true",
    timeoutMs,
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

// --- SMART TOOL: get_ffl_leasing ---
// Thin-agent / smart-tools (D13). Returns FFL "Apps & Leases" metrics (Company Numbers
// row 23, A23-E23) computed server-side. Leases-signed (C23/D23/E23) come from AppFolio
// lease_history (NEW leases = Renewal="No", by countersigned date). Apps (A23/B23) come
// from BoomPay once wired into the endpoint (null + apps_available:false until then; the
// agent must not write A23/B23 while apps_available is false). Reads the native CRM
// endpoint /api/v1/analytics/ffl-leasing - no fallback. READ-ONLY.
const FFL_LEASING_TOOL_NAME = "get_ffl_leasing";
const FFL_LEASING_TOOL_DESC =
  "Smart server-side aggregation: returns FFL 'Apps & Leases' metrics for Company Numbers " +
  "row 23 (A23-E23), dummy accounts EXCLUDED (/zdummy/i + 1201 Fannin). Returns " +
  "{ apps_this_month (A23), apps_last_month (B23), apps_available, apps_diagnostics, " +
  "leases_signed_week (C23), leases_signed_month (D23), leases_signed_last_month (E23), " +
  "per-window detail lists, leases_components, excluded_properties, window, cells, as_of, source }. " +
  "Leases = AppFolio lease_history NEW leases (Renewal='No') keyed on countersigned_date; week is " +
  "Sun-Sat. IMPORTANT: apps_this_month/apps_last_month are the BoomPay 'true source' and are NULL " +
  "until BoomPay is wired - if apps_available is false, do NOT write A23/B23 (write only C23/D23/E23). " +
  "Source = /api/v1/analytics/ffl-leasing. No arguments. Read-only.";
const FFL_LEASING_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflLeasing(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-leasing");
  if (!resp.success) {
    throw new Error(
      `ffl-leasing endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-leasing (ffl-crm PR #561) to be deployed " +
        "and the Bearer key to have scope properties:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).leases_signed_month !== "number") {
    throw new Error("ffl-leasing endpoint returned an unexpected shape (no numeric leases_signed_month).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-leasing" };
}

// --- SMART TOOL: get_ffl_sales_calls ---
// Thin-agent / smart-tools (D13). Returns FFL "Sales - Calls (made contact or discovery
// call)" metrics (Company Numbers row 27, B27-E27) computed server-side. MATCHES the
// Smarketing scorecard's "Appointments Completed" definition (locked with Mo 2026-06-04).
// Reads the native CRM endpoint /api/v1/analytics/ffl-sales-calls - no fallback. READ-ONLY.
const FFL_SALES_TOOL_NAME = "get_ffl_sales_calls";
const FFL_SALES_TOOL_DESC =
  "Smart server-side aggregation: returns FFL 'Sales - Calls (made contact or discovery call)' " +
  "metrics for Company Numbers row 27 (B27-E27). MATCHES the scorecard 'Appointments Completed' " +
  "rule: each SALES-workspace opportunity counts ONCE, in the period of its earliest appointment " +
  "evidence - (a) a logged phone call >5 min before signing, (b) a stage move into Discovery " +
  "Completed / Proposal Sent / Decision Pending / Agreement Out, or (c) a human (non-self-serve) " +
  "SIGNED_CLIENT signing. Opps with no evidence (only 'made contact'/Connected, or self-serve " +
  "signups) are NOT counted. Returns { this_week (B27), this_month (C27), last_month (D27), " +
  "quarter (E27), appts_considered, as_of, window_bounds, cells, definition }. Windows = " +
  "America/Chicago, week Sun-Sat (lines up with row 26). Optional 'as_of' (YYYY-MM-DD). " +
  "Source = /api/v1/analytics/ffl-sales-calls. Read-only.";
const FFL_SALES_TOOL_SCHEMA = {
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

async function getFflSalesCalls(cfg: Cfg, args: Record<string, unknown>): Promise<unknown> {
  const asOf = typeof args.as_of === "string" ? args.as_of.trim() : "";
  const query: Record<string, unknown> = {};
  if (asOf) query.as_of = asOf;
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-sales-calls", query);
  if (!resp.success) {
    throw new Error(
      `ffl-sales-calls endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-sales-calls (ffl-crm PR #579) to be deployed " +
        "and the Bearer key to have scope opportunities:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).this_week !== "number") {
    throw new Error("ffl-sales-calls endpoint returned an unexpected shape (no numeric this_week).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-sales-calls" };
}

// --- SMART TOOL: get_cfa_numbers ---
// Thin-agent / smart-tools (D13). Returns the CFA (Cranbrook Forest / ResMan) Company
// Numbers rows computed server-side: Occupancy row 5 (B5/F5/G5), Renewals row 10
// (B10-F10), Delinquency row 15 (B15-F15) - mirrors the FFL row definitions (Mo
// 2026-06-10). ResMan has NO API: a fetcher on the FFL VPS exports the Cranbrook CSVs
// headlessly pre-dawn and pushes them to ffl-crm; /api/v1/analytics/cfa-numbers computes
// on read. Reads that native endpoint - no fallback. READ-ONLY.
const CFA_TOOL_NAME = "get_cfa_numbers";
const CFA_TOOL_DESC =
  "Smart server-side aggregation: returns the CFA (Cranbrook Forest Apartments / ResMan) " +
  "Company Numbers rows - Occupancy row 5 (B5/F5/G5), Renewals row 10 (B10-F10), Delinquency " +
  "row 15 (B15-F15) - mirroring the FFL row definitions. Data comes from the pre-dawn VPS " +
  "ResMan fetcher via ffl-crm. CRITICAL: response includes `stale` - when stale=true the data " +
  "is NOT from today (America/Chicago) and the agent MUST NOT write any CFA cell (write " +
  "nothing + flag). Cells that return null are unmapped/unavailable and MUST be skipped, " +
  "never guessed. Returns { stale, data_date_ct, occupancy, renewals, delinquency, " +
  "report_status, raw_previews, cells, definition }. " +
  "Source = /api/v1/analytics/cfa-numbers. No arguments. Read-only.";
const CFA_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getCfaNumbers(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/cfa-numbers");
  if (!resp.success) {
    throw new Error(
      `cfa-numbers endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/cfa-numbers (ffl-crm PR #583) to be deployed, " +
        "the Bearer key to have scope properties:read (or *), and the VPS ResMan fetcher to have " +
        "pushed at least once (check /opt/ffl-resman-fetcher/last-run.json on the VPS).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).stale !== "boolean") {
    throw new Error("cfa-numbers endpoint returned an unexpected shape (no boolean stale flag).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/cfa-numbers" };
}

// --- SMART TOOL: get_cf_lead_numbers ---
// Thin-agent / smart-tools (D13). Returns the Cranbrook "CF Leasing Leads" (LeadSimple)
// lead counts for the Company Numbers "CFA Leasing -> Leads" row (B35:E35). LeadSimple has
// NO counting API: a fetcher on the FFL VPS logs in headlessly each morning, reads the
// server-computed Count per window, and pushes the numbers to ffl-crm; this reads
// /api/v1/analytics/cf-lead-numbers - no fallback. READ-ONLY.
const CF_LEADS_TOOL_NAME = "get_cf_lead_numbers";
const CF_LEADS_TOOL_DESC =
  "Smart server-side relay: returns the Cranbrook 'CF Leasing Leads' (LeadSimple) lead counts " +
  "for the Company Numbers 'CFA Leasing -> Leads' row - this_week (B35, Sunday-start), this_month " +
  "(C35), last_month (D35), new_30d (E35 = in 'New' stage created last 30 days). Definition: leads " +
  "CREATED in window, all sources, excluding the 'Doesn't Qualify' stage. Data comes from the " +
  "pre-dawn VPS LeadSimple fetcher via ffl-crm. CRITICAL: response includes `stale` - when " +
  "stale=true the data is NOT from today (America/Chicago) and the agent MUST NOT write any cell " +
  "(write nothing + flag). Returns { cells, stale, ct_date, today_ct, fetched_at_ct, definition }. " +
  "Source = /api/v1/analytics/cf-lead-numbers. No arguments. Read-only.";
const CF_LEADS_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getCfLeadNumbers(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/cf-lead-numbers");
  if (!resp.success) {
    throw new Error(
      `cf-lead-numbers endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/cf-lead-numbers (ffl-crm) to be deployed, the Bearer " +
        "key to have scope properties:read (or *), and the VPS LeadSimple fetcher to have pushed at " +
        "least once (check /opt/ffl-resman-fetcher/last-run-leadsimple.json on the VPS).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).stale !== "boolean") {
    throw new Error("cf-lead-numbers endpoint returned an unexpected shape (no boolean stale flag).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/cf-lead-numbers" };
}

// --- SMART TOOL: get_ffl_sales_signups ---
// Thin-agent / smart-tools (D13). Returns FFL "Sales - Sign Ups" metrics (Company
// Numbers row 29, B29-E29) computed server-side. LOCKED with Mo 2026-06-10: a Sign Up
// = a WON landlord lead - a "Landlord Leads"-pipeline opportunity at SIGNED_CLIENT,
// counted in the period it SIGNED (signedAt -> closedAt -> stageChangedAt). Reads the
// native CRM endpoint /api/v1/analytics/ffl-sales-signups - no fallback. READ-ONLY.
const FFL_SIGNUPS_TOOL_NAME = "get_ffl_sales_signups";
const FFL_SIGNUPS_TOOL_DESC =
  "Smart server-side aggregation: returns FFL 'Sales - Sign Ups' metrics for Company Numbers " +
  "row 29 (B29-E29). A Sign Up = a WON landlord lead: a 'Landlord Leads'-pipeline opportunity " +
  "whose stage is SIGNED_CLIENT, counted in the period it SIGNED (signedAt, fallback closedAt, " +
  "fallback stageChangedAt; self-serve counts). Returns { this_week (B29), this_month (C29), " +
  "last_month (D29), quarter (E29), total_signed_all_time, signed_missing_dates, as_of, " +
  "window_bounds, cells, definition }. Windows = America/Chicago, week Sun-Sat - identical to " +
  "rows 26/27. Optional 'as_of' (YYYY-MM-DD). Source = /api/v1/analytics/ffl-sales-signups. Read-only.";
const FFL_SIGNUPS_TOOL_SCHEMA = {
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

async function getFflSalesSignups(cfg: Cfg, args: Record<string, unknown>): Promise<unknown> {
  const asOf = typeof args.as_of === "string" ? args.as_of.trim() : "";
  const query: Record<string, unknown> = {};
  if (asOf) query.as_of = asOf;
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-sales-signups", query);
  if (!resp.success) {
    throw new Error(
      `ffl-sales-signups endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "This tool requires GET /api/v1/analytics/ffl-sales-signups (ffl-crm PR #586) to be deployed " +
        "and the Bearer key to have scope opportunities:read (or *).",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).this_week !== "number") {
    throw new Error("ffl-sales-signups endpoint returned an unexpected shape (no numeric this_week).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-sales-signups" };
}

// --- SMART TOOL: get_ffl_huddle_sales ---
// Morning-huddle sales brief (Mo 2026-06-10): server-composed notes block for
// Company Numbers H47 (H46 = header). READ-ONLY.
const FFL_HUDDLE_TOOL_NAME = "get_ffl_huddle_sales";
const FFL_HUDDLE_TOOL_DESC =
  "Morning-huddle sales brief for Company Numbers H46/H47: returns { h46_header, " +
  "h47_notes_block (write VERBATIM into H47), components { new_leads_24h, hot_email_opens_24h, " +
  "decision_pending } }. Contents: new landlord leads in the last 24h, HOT leads that opened " +
  "our emails in the last 24h (open counts + hours ago), decision-pending (only when > 0). " +
  "Source = /api/v1/analytics/ffl-huddle-sales (v2). No arguments. Read-only.";
const FFL_HUDDLE_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflHuddleSales(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-huddle-sales");
  if (!resp.success) {
    throw new Error(
      `ffl-huddle-sales endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "Requires GET /api/v1/analytics/ffl-huddle-sales (ffl-crm PR #588) deployed and scope opportunities:read.",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).h47_notes_block !== "string") {
    throw new Error("ffl-huddle-sales endpoint returned an unexpected shape (no h47_notes_block).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-huddle-sales" };
}

// --- SMART TOOL: get_ffl_huddle_appfolio ---
// Morning-huddle AppFolio brief (Mo 2026-06-10): server-composed notes block for
// Company Numbers H40/H41 — upcoming move-ins this+next week with deposit /
// first-month payment status. READ-ONLY.
const FFL_HUDAF_TOOL_NAME = "get_ffl_huddle_appfolio";
const FFL_HUDAF_TOOL_DESC =
  "Morning-huddle AppFolio brief for Company Numbers H40/H41: returns { h40_header, " +
  "h41_notes_block (write VERBATIM into H41), move_ins_this_week, move_ins_next_week, " +
  "receipts_available }. Contents: scheduled move-ins this week and next week (Sun-Sat CT) " +
  "with whether the tenant has paid the security deposit and first month's rent " +
  "(deposit_register receipts vs amounts due). Source = /api/v1/analytics/ffl-huddle-appfolio. " +
  "No arguments. Read-only.";
const FFL_HUDAF_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

async function getFflHuddleAppfolio(cfg: Cfg): Promise<unknown> {
  const resp = await crmRequest<Record<string, unknown>>(cfg, "GET", "/api/v1/analytics/ffl-huddle-appfolio");
  if (!resp.success) {
    throw new Error(
      `ffl-huddle-appfolio endpoint failed (HTTP ${resp.statusCode}): ${resp.error}. ` +
        "Requires GET /api/v1/analytics/ffl-huddle-appfolio (ffl-crm PR #589) deployed and scope properties:read.",
    );
  }
  const d = resp.data;
  if (!d || typeof d !== "object" || typeof (d as Record<string, unknown>).h41_notes_block !== "string") {
    throw new Error("ffl-huddle-appfolio endpoint returned an unexpected shape (no h41_notes_block).");
  }
  return { ...(d as Record<string, unknown>), source: "native:/api/v1/analytics/ffl-huddle-appfolio" };
}

const VALID_METHODS: ReadonlyArray<HttpMethod> = ["GET", "POST", "PATCH", "DELETE", "PUT"];

async function buildServer(cfg: Cfg, toolFilter: Set<string> | null): Promise<Server> {
  const me = await crmRequest<{
    identity?: { scopes?: string[]; name?: string; email?: string };
    capabilities?: ManifestTool[];
  }>(
    cfg,
    "GET",
    "/api/v1/me",
  );
  if (!me.success) {
    const e = new Error(
      `Failed to load tool manifest from /api/v1/me (HTTP ${me.statusCode}): ${me.error}`,
    ) as Error & { statusCode?: number };
    e.statusCode = me.statusCode;
    throw e;
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
  const includeFflLeasingTool = !toolFilter || toolFilter.has(FFL_LEASING_TOOL_NAME);
  const includeFflSalesCallsTool = !toolFilter || toolFilter.has(FFL_SALES_TOOL_NAME);
  const includeCfaTool = !toolFilter || toolFilter.has(CFA_TOOL_NAME);
  const includeCfLeadsTool = !toolFilter || toolFilter.has(CF_LEADS_TOOL_NAME);
  const includeSignupsTool = !toolFilter || toolFilter.has(FFL_SIGNUPS_TOOL_NAME);
  const includeHuddleTool = !toolFilter || toolFilter.has(FFL_HUDDLE_TOOL_NAME);
  const includeHudAfTool = !toolFilter || toolFilter.has(FFL_HUDAF_TOOL_NAME);

  // AppFolio entry-agent smart tools (Phase 3, owner onboarding). They proxy
  // a PRIVILEGED token (never the caller's key), so exposure requires BOTH:
  // the token configured here AND the caller's own key carrying agent:write
  // (or *) — the ?tools= filter is cosmetic and grants nothing.
  const appfolioAuthorized =
    appfolioEntryToolsEnabled() && hasScope(APPFOLIO_ENTRY_REQUIRED_SCOPE, scopes);
  const appfolioTools = appfolioAuthorized
    ? APPFOLIO_ENTRY_TOOLS.filter((t) => !toolFilter || toolFilter.has(t.name))
    : [];
  // Audit attribution for these tools comes from the AUTHENTICATED identity,
  // never from tool arguments (callers must not spoof the review history).
  const appfolioCallerIdentity = data.identity?.email || data.identity?.name || undefined;

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
      ...(includeFflLeasingTool
        ? [{ name: FFL_LEASING_TOOL_NAME, description: FFL_LEASING_TOOL_DESC, inputSchema: FFL_LEASING_TOOL_SCHEMA }]
        : []),
      ...(includeFflSalesCallsTool
        ? [{ name: FFL_SALES_TOOL_NAME, description: FFL_SALES_TOOL_DESC, inputSchema: FFL_SALES_TOOL_SCHEMA }]
        : []),
  ...(includeCfaTool
        ? [{ name: CFA_TOOL_NAME, description: CFA_TOOL_DESC, inputSchema: CFA_TOOL_SCHEMA }]
        : []),
      ...(includeCfLeadsTool
        ? [{ name: CF_LEADS_TOOL_NAME, description: CF_LEADS_TOOL_DESC, inputSchema: CF_LEADS_TOOL_SCHEMA }]
        : []),
      ...(includeSignupsTool
        ? [{ name: FFL_SIGNUPS_TOOL_NAME, description: FFL_SIGNUPS_TOOL_DESC, inputSchema: FFL_SIGNUPS_TOOL_SCHEMA }]
        : []),
      ...(includeHuddleTool
        ? [{ name: FFL_HUDDLE_TOOL_NAME, description: FFL_HUDDLE_TOOL_DESC, inputSchema: FFL_HUDDLE_TOOL_SCHEMA }]
        : []),
      ...(includeHudAfTool
        ? [{ name: FFL_HUDAF_TOOL_NAME, description: FFL_HUDAF_TOOL_DESC, inputSchema: FFL_HUDAF_TOOL_SCHEMA }]
        : []),
      ...appfolioTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    if (APPFOLIO_ENTRY_TOOL_NAMES.has(name)) {
      if (!appfolioTools.some((t) => t.name === name)) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await callAppfolioEntryTool(
          name,
          (rawArgs ?? {}) as Record<string, unknown>,
          appfolioCallerIdentity,
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error invoking ${name}: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }

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

    if (name === FFL_LEASING_TOOL_NAME) {
      if (!includeFflLeasingTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflLeasing(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_LEASING_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_SALES_TOOL_NAME) {
      if (!includeFflSalesCallsTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflSalesCalls(cfg, (rawArgs ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_SALES_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === CFA_TOOL_NAME) {
      if (!includeCfaTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getCfaNumbers(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${CFA_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === CF_LEADS_TOOL_NAME) {
      if (!includeCfLeadsTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getCfLeadNumbers(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${CF_LEADS_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_SIGNUPS_TOOL_NAME) {
      if (!includeSignupsTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflSalesSignups(cfg, (rawArgs ?? {}) as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_SIGNUPS_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_HUDDLE_TOOL_NAME) {
      if (!includeHuddleTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflHuddleSales(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_HUDDLE_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    }

    if (name === FFL_HUDAF_TOOL_NAME) {
      if (!includeHudAfTool) {
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      try {
        const result = await getFflHuddleAppfolio(cfg);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error invoking ${FFL_HUDAF_TOOL_NAME}: ${err instanceof Error ? err.message : String(err)}` },
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

// ───────────────────────── OAuth (resource server) ─────────────────────────
// This server VERIFIES WorkOS-issued access tokens; it never issues them.
// WorkOS AuthKit is the authorization server (login/consent/tokens).

/** AuthKit domain that runs login/consent and issues tokens, e.g. https://x.authkit.app */
function authkitDomain(): string {
  return (process.env.WORKOS_AUTHKIT_DOMAIN ?? "").trim().replace(/\/+$/, "");
}

/** Public URL of THIS resource, echoed to clients in the 401 challenge. */
function resourceMetadataUrl(): string {
  const explicit = (process.env.MCP_RESOURCE_URL ?? "").trim().replace(/\/+$/, "");
  const base = explicit
    ? explicit.replace(/\/api\/mcp$/, "")
    : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://vestlaunch-mcp.vercel.app");
  return `${base}/.well-known/oauth-protected-resource`;
}

/**
 * Send an RFC 6750 / RFC 9728 401 that points the client at our discovery doc.
 * This is what makes Claude Desktop's "Connect" button start the login flow.
 */
function sendUnauthorized(res: ServerResponse, message = "Unauthorized"): void {
  res.setHeader(
    "www-authenticate",
    `Bearer resource_metadata="${resourceMetadataUrl()}"`,
  );
  sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message }, id: null });
}

// Cache the AuthKit metadata document + its JWKS across warm invocations.
type AsMetadata = { issuer: string; jwks_uri: string; userinfo_endpoint?: string };
let asMetaCache: { at: number; meta: AsMetadata } | null = null;
let jwksCache: { uri: string; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;
const AS_META_TTL_MS = 60 * 60 * 1000; // 1h

async function getAsMetadata(): Promise<AsMetadata> {
  const domain = authkitDomain();
  if (!domain) throw new Error("WORKOS_AUTHKIT_DOMAIN is not set");
  if (asMetaCache && Date.now() - asMetaCache.at < AS_META_TTL_MS) return asMetaCache.meta;
  const url = `${domain}/.well-known/oauth-authorization-server`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`AuthKit metadata fetch failed (${r.status})`);
  const meta = (await r.json()) as AsMetadata;
  if (!meta.issuer || !meta.jwks_uri) throw new Error("AuthKit metadata missing issuer/jwks_uri");
  asMetaCache = { at: Date.now(), meta };
  return meta;
}

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksCache && jwksCache.uri === uri) return jwksCache.jwks;
  const jwks = createRemoteJWKSet(new URL(uri));
  jwksCache = { uri, jwks };
  return jwks;
}

type Identity = { email?: string; sub?: string };

/**
 * Verify a WorkOS access token against AuthKit's JWKS and return the identity.
 * Throws if the token is invalid/expired. NOTE: audience (`aud`) is intentionally
 * not enforced for launch — safe here because we never forward this token to the
 * CRM and always resolve identity -> our own CRM key. TODO: bind + check `aud`.
 */
async function verifyWorkosToken(token: string): Promise<Identity> {
  const meta = await getAsMetadata();
  const jwks = jwksFor(meta.jwks_uri);
  const { payload } = await jwtVerify(token, jwks, { issuer: meta.issuer });
  let email = typeof payload.email === "string" ? payload.email : undefined;
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  // Some access tokens omit email; fall back to the userinfo endpoint.
  if (!email && meta.userinfo_endpoint) {
    try {
      const r = await fetch(meta.userinfo_endpoint, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const info = (await r.json()) as { email?: unknown };
        if (typeof info.email === "string") email = info.email;
      }
    } catch {
      /* userinfo is best-effort; identity by sub still works if mapped */
    }
  }
  return { email, sub };
}

/**
 * Map a verified identity to that person's CRM key using MCP_USER_KEY_MAP
 * (a one-line JSON object of loginEmail -> ffl_live_ key, with optional
 * sub -> key entries). Returns undefined if the person isn't provisioned.
 */
function crmKeyForIdentity(id: Identity): string | undefined {
  const raw = (process.env.MCP_USER_KEY_MAP ?? "").trim();
  if (!raw) return undefined;
  let map: Record<string, string>;
  try {
    map = JSON.parse(raw) as Record<string, string>;
  } catch {
    return undefined;
  }
  const byEmail = id.email
    ? map[id.email] ?? map[id.email.toLowerCase()]
    : undefined;
  if (byEmail) return byEmail;
  return id.sub ? map[id.sub] : undefined;
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const authHeader = req.headers["authorization"];
  const bearer =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : "";
  const legacyToken = (process.env.MCP_BEARER_TOKEN ?? "").trim();

  let perUserApiKey: string | undefined;
  if (legacyToken && bearer === legacyToken) {
    perUserApiKey = undefined; // legacy shared-token mode (env VESTLAUNCH_API_KEY)
  } else if (bearer.startsWith(CRM_KEY_PREFIX)) {
    perUserApiKey = bearer; // per-user CRM key; validated by /api/v1/me below
  } else if (bearer) {
    // Primary path: an access token minted by OUR self-hosted OAuth server
    // (this is what Claude Desktop's "Connect" flow returns). The token is an
    // encrypted JWE that carries the user's CRM key. Decrypt it and use that key.
    let ownKey: string | undefined;
    try {
      ownKey = (await readAccessToken(bearer)).crmKey;
    } catch {
      ownKey = undefined;
    }
    if (ownKey) {
      perUserApiKey = ownKey;
    } else if (authkitDomain()) {
      // Legacy fallback: a WorkOS access token from the old sign-in flow.
      // Verify -> map identity to a CRM key. Only active if WorkOS is configured.
      let identity: Identity;
      try {
        identity = await verifyWorkosToken(bearer);
      } catch {
        sendUnauthorized(res, "Invalid or expired sign-in token");
        return;
      }
      const mapped = crmKeyForIdentity(identity);
      if (!mapped) {
        // Authenticated, but no CRM access provisioned for this person.
        sendJson(res, 403, {
          jsonrpc: "2.0",
          error: {
            code: -32003,
            message:
              "Signed in, but no CRM access is provisioned for your account yet. Ask the VestLaunch owner to add you.",
          },
          id: null,
        });
        return;
      }
      perUserApiKey = mapped;
    } else {
      // Token isn't one of ours and WorkOS isn't configured — reject.
      sendUnauthorized(res, "Invalid or expired sign-in token");
      return;
    }
  } else {
    // No usable credential — challenge the client to start the sign-in flow.
    sendUnauthorized(res);
    return;
  }

  const toolFilter = parseToolFilter(req.url);

  let server: Server;
  try {
    server = await buildServer(loadCfg(perUserApiKey), toolFilter);
  } catch (err) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (perUserApiKey && (status === 401 || status === 403)) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or revoked API key" },
        id: null,
      });
      return;
    }
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
