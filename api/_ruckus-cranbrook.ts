/**
 * Ruckus's Cranbrook read tools (Mo, 2026-10-03).
 *
 * "ruckus reports to me and yuliana so it should have access to all
 * workspaces … view ffl and cranbrook evenly." The CRM binds every API key to
 * ONE business, and Ruckus's shared key is FFL's. Cranbrook Forest is a
 * separate business, so Ruckus reads it through a second key bound to the
 * Cranbrook workspace, RUCKUS_CRANBROOK_API_KEY, held only in this server's env
 * and used only here — the other agents on the shared MCP never see it.
 *
 * Read-only by construction: only the GET tools named below are exposed, each
 * as `cranbrook_<name>`, and every call is a GET. The tool list comes from the
 * CRM manifest (/api/v1/me) so paths and parameters never drift.
 *
 * Which chat hears what is NOT decided here: the CRM send path holds any
 * Cranbrook post to Sam's sales chat (ffl-crm lib/rc-chat-policy).
 */

const PREFIX = "cranbrook_";

/** CRM read tools Ruckus may use on Cranbrook. GET only. */
export const CRANBROOK_READ_TOOLS = new Set([
  "search",
  "list_contacts",
  "get_contact",
  "get_contact_activity",
  "list_opportunities",
  "get_opportunity",
  "list_tasks",
  "get_task",
  "get_activities",
  "get_pipelines",
  "list_bookings",
  "get_contact_analytics",
]);

interface ManifestTool {
  name: string;
  method: string;
  path: string;
  description: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface CranbrookTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
  path: string;
}

function baseUrl(): string {
  const v = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return v || "https://crm.vestlaunch.com";
}

export function cranbrookKey(): string {
  return (process.env.RUCKUS_CRANBROOK_API_KEY ?? "").trim();
}

async function crmGet(path: string, query: Record<string, unknown>, key: string): Promise<unknown> {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    // The key decides the business; a caller can't point it elsewhere.
    if (k === "workspace_id" || k === "workspaceId") continue;
    url.searchParams.set(k, String(v));
  }
  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "ruckus-mcp-cranbrook/0.1.0" },
    signal: AbortSignal.timeout(Number.isFinite(t) && t > 0 ? t : 30_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) return { ok: false, status: res.status, error: (json as { error?: string } | null)?.error ?? `HTTP ${res.status}` };
  return json;
}

const PARAM = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** Build the cranbrook_* tool list from the CRM manifest. [] when not configured or unreachable. */
export async function loadCranbrookTools(): Promise<CranbrookTool[]> {
  const key = cranbrookKey();
  if (!key) return [];
  try {
    const me = (await crmGet("/api/v1/me", {}, key)) as { data?: { capabilities?: ManifestTool[] } } | null;
    const caps = me?.data?.capabilities ?? [];
    return buildCranbrookTools(caps);
  } catch {
    return [];
  }
}

/** Pure: manifest → cranbrook_* tools (GET + allowlisted only). */
export function buildCranbrookTools(caps: ManifestTool[]): CranbrookTool[] {
  const out: CranbrookTool[] = [];
  for (const t of caps) {
    if (!t || t.method !== "GET" || !CRANBROOK_READ_TOOLS.has(t.name)) continue;
    const properties: Record<string, unknown> = { ...(t.inputSchema?.properties ?? {}) };
    delete properties.workspace_id;
    delete properties.workspaceId;
    const required = new Set<string>(t.inputSchema?.required ?? []);
    for (const m of t.path.matchAll(PARAM)) {
      if (!properties[m[1]]) properties[m[1]] = { type: "string", description: `Path parameter (${m[1]}).` };
      required.add(m[1]);
    }
    out.push({
      name: `${PREFIX}${t.name}`,
      description: `CRANBROOK FOREST (the apartment business, separate from FFL) — ${t.description} Read-only. Cranbrook information may be posted only in your main channel (Mo + Yuliana), never in Sam's sales chat.`,
      inputSchema: { type: "object", properties, required: required.size ? [...required] : undefined, additionalProperties: false },
      path: t.path,
    });
  }
  return out;
}

export function isCranbrookTool(name: string): boolean {
  return name.startsWith(PREFIX) && CRANBROOK_READ_TOOLS.has(name.slice(PREFIX.length));
}

/** Run one cranbrook_* tool. Always a GET with the Cranbrook-bound key. */
export async function runCranbrookTool(tool: CranbrookTool, args: Record<string, unknown>): Promise<unknown> {
  const key = cranbrookKey();
  if (!key) return { ok: false, error: "Cranbrook access is not configured (RUCKUS_CRANBROOK_API_KEY)." };
  const rest: Record<string, unknown> = { ...args };
  const path = tool.path.replace(PARAM, (_, p: string) => {
    const v = rest[p];
    delete rest[p];
    if (typeof v !== "string" || !v) throw new Error(`Missing required path parameter: ${p}`);
    return encodeURIComponent(v);
  });
  return crmGet(path, rest, key);
}
