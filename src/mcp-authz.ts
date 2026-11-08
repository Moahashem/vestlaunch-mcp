/**
 * Server-side authorization for the VestLaunch MCP.
 *
 * The CRM key is the agent identity. This module decides which tools that
 * identity may see and whether a call's workspace or business selectors are
 * allowed. It does not invent grants: an empty business or workspace list
 * means the CRM did not declare one, and a caller-supplied id is not treated
 * as a grant of the other business.
 *
 * Write, send, and payment effects are never satisfied by a `:read` scope.
 * `*` is the CRM's explicit wildcard and still satisfies them.
 */

export type Business = "ffl" | "cranbrook";
export type Effect = "read" | "write" | "send" | "payment";

/**
 * `scoped` is a per-agent CRM key or an OAuth session. It is refused unless
 * /api/v1/me matches REQUIRED_IDENTITY_SHAPE.
 * `legacy-shared` is only the explicit shared MCP_BEARER_TOKEN path (and the
 * local stdio process unless VESTLAUNCH_AUTH_MODE=scoped). It is not a silent
 * reading of a missing business field.
 */
export type AuthorityMode = "legacy-shared" | "scoped";

export interface CallerIdentity {
  authority: AuthorityMode;
  /** False when a scoped key's identity is missing, malformed, or contradictory. */
  authorityOk: boolean;
  authorityError?: string;
  apiKeyId?: string;
  name?: string;
  email?: string;
  scopes: string[];
  businesses: Business[];
  workspaceIds: string[];
}

/** Exact fields a scoped key's GET /api/v1/me data.identity must carry. */
export const REQUIRED_IDENTITY_SHAPE =
  'data.identity.scopes (non-empty array of scope strings; "*" is the wildcard grant), ' +
  'data.identity.business ("ffl" | "cranbrook" | "both"), ' +
  "and data.identity.workspaceIds (non-empty array of workspace ids). " +
  "Only those exact business tokens count. Display names, slugs, and aliases are not authority. " +
  'A manifest tool whose scope is "*" requires the key to hold "*".';

export interface ToolRule {
  name: string;
  business: Business | "any";
  effect: Effect;
  /** Any one of these scopes authorizes the tool. `*` on the key always does. */
  scopes: string[];
  /**
   * Manifest writes already consult VESTLAUNCH_ENABLE_WRITES. Synthetic tools
   * keep working for a key that actually holds the write scope (including `*`)
   * so a read-only key loses them without turning off every existing `*` agent.
   */
  writesFlag: boolean;
}

export type Decision = { ok: true } | { ok: false; reason: string };

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** How far caller arguments may nest before the call is rejected. */
export const SELECTOR_DEPTH_BUDGET = 6;

const BUSINESS_TOKENS = new Set(["ffl", "cranbrook", "both"]);
const WIDEN = new Set(["", "*", "all", "any", "none"]);
const SCOPE_TOKEN = /^[A-Za-z0-9_:*]+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type BusinessClaim = Business | "both";

/** Exact token only. "Cranbrook Forest", "FFL", and slugs are not businesses. */
function exactBusinessToken(value: unknown): BusinessClaim | "malformed" | "absent" {
  if (value === undefined || value === null) return "absent";
  if (typeof value !== "string") return "malformed";
  const s = value.trim();
  if (s === "ffl" || s === "cranbrook" || s === "both") return s;
  return "malformed";
}

function readWorkspaceIds(value: unknown): { ids: string[] } | { error: string } | { missing: true } {
  if (value === undefined || value === null) return { missing: true };
  if (!Array.isArray(value)) return { error: "workspaceIds is malformed" };
  if (value.length === 0) return { error: "workspaceIds is empty" };
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "" || item !== item.trim()) {
      return { error: "workspaceIds is malformed" };
    }
    if (BUSINESS_TOKENS.has(item) || WIDEN.has(item.toLowerCase())) {
      return { error: "workspaceIds contains a business alias, not a workspace id" };
    }
    if (!ids.includes(item)) ids.push(item);
  }
  return { ids };
}

/**
 * Read /api/v1/me data.identity.
 * `mode` chooses the contract. Scoped keys do not treat a missing business as
 * access to both companies. Names and slugs are never read as grants.
 */
export function parseCallerIdentity(raw: unknown, mode: AuthorityMode): CallerIdentity {
  const o = isObj(raw) ? raw : {};
  const name =
    (typeof o.agentName === "string" && o.agentName) ||
    (typeof o.name === "string" && o.name) ||
    undefined;
  const base = {
    authority: mode,
    apiKeyId: typeof o.apiKeyId === "string" ? o.apiKeyId : undefined,
    name,
    email: typeof o.email === "string" ? o.email : undefined,
  };

  let scopeError: string | undefined;
  const scopes: string[] = [];
  if (!Array.isArray(o.scopes)) scopeError = "scopes is missing or malformed";
  else {
    for (const scope of o.scopes) {
      if (typeof scope !== "string" || !SCOPE_TOKEN.test(scope)) {
        scopeError = "scopes is malformed";
        break;
      }
      scopes.push(scope);
    }
    if (!scopeError && scopes.length === 0) scopeError = "scopes is empty";
  }

  const businessToken = exactBusinessToken(o.business);
  let fromList: Business[] | undefined;
  let listError: string | undefined;
  if (o.businesses !== undefined) {
    if (!Array.isArray(o.businesses)) listError = "businesses is malformed";
    else {
      fromList = [];
      for (const item of o.businesses) {
        const token = exactBusinessToken(item);
        if (token === "absent" || token === "malformed" || token === "both") {
          listError = "businesses is malformed";
          break;
        }
        if (!fromList.includes(token)) fromList.push(token);
      }
    }
  }

  const workspaces = readWorkspaceIds(o.workspaceIds);
  let businesses: Business[] = [];
  let conflict: string | undefined;
  if (businessToken === "malformed") conflict = "business is malformed";
  else if (listError) conflict = listError;
  else if (businessToken === "both") {
    if (fromList && (fromList.length !== 2 || !fromList.includes("ffl") || !fromList.includes("cranbrook"))) {
      conflict = "business claims conflict";
    }
    businesses = ["ffl", "cranbrook"];
  } else if (businessToken === "ffl" || businessToken === "cranbrook") {
    if (fromList && (fromList.length !== 1 || fromList[0] !== businessToken)) conflict = "business claims conflict";
    businesses = [businessToken];
  } else if (fromList && fromList.length > 0) {
    businesses = fromList;
  }

  const workspaceIds = "ids" in workspaces ? workspaces.ids : [];
  const parts = [scopeError, conflict, "error" in workspaces ? workspaces.error : undefined].filter(Boolean);
  if (mode === "legacy-shared") {
    return {
      ...base,
      authorityOk: true,
      scopes: scopeError ? [] : scopes,
      businesses,
      workspaceIds,
      authorityError: parts.length > 0 ? `Legacy shared token is not tenant-scoped. ${parts.join("; ")}` : undefined,
    };
  }

  if ("missing" in workspaces) parts.push("workspaceIds is missing");
  if (businesses.length === 0 && !conflict && businessToken !== "malformed") parts.push("business is missing");
  const authorityError = parts.length > 0 ? `${parts.join("; ")}. ${REQUIRED_IDENTITY_SHAPE}` : undefined;
  return {
    ...base,
    authorityOk: !authorityError,
    authorityError,
    scopes: scopeError ? [] : scopes,
    businesses: authorityError ? [] : businesses,
    workspaceIds: authorityError ? [] : workspaceIds,
  };
}

function rule(
  name: string,
  business: Business | "any",
  effect: Effect,
  scopes: string[],
): ToolRule {
  return { name, business, effect, scopes, writesFlag: false };
}

const FFL_PROPERTY_READS = [
  "get_ffl_occupancy",
  "get_ffl_guest_cards",
  "get_ffl_renewals",
  "get_ffl_delinquency",
  "get_delinquency_worklist",
  "get_ffl_homes",
  "get_ffl_onboarding",
  "get_ffl_churn_risk",
  "get_ffl_leasing",
  "get_ffl_huddle_appfolio",
  "appfolio_ledger",
];

const FFL_OPPORTUNITY_READS = [
  "count_landlord_leads",
  "get_ffl_sales_calls",
  "get_ffl_sales_signups",
  "get_ffl_huddle_sales",
];

const CRANBROOK_READS = [
  "get_cfa_numbers",
  "get_leasing_triage",
  "get_office_closures",
  "get_cf_lead_numbers",
];

const CRANBROOK_WRITES = [
  "act_leasing_triage",
  "record_tour_outcome",
  "close_lead_lost",
  "set_office_closure",
];

const APPFOLIO_ENTRY = [
  "appfolio_entry_claim",
  "appfolio_entry_packet",
  "appfolio_entry_mark_entered",
  "appfolio_entry_release",
  "appfolio_entry_renew",
];

const RULES: ToolRule[] = [
  ...FFL_PROPERTY_READS.map((name) => rule(name, "ffl", "read", ["properties:read"])),
  ...FFL_OPPORTUNITY_READS.map((name) => rule(name, "ffl", "read", ["opportunities:read"])),
  rule("owner_billing", "ffl", "read", ["properties:read"]),
  ...CRANBROOK_READS.map((name) => rule(name, "cranbrook", "read", ["properties:read"])),
  ...CRANBROOK_WRITES.map((name) => rule(name, "cranbrook", "write", ["leasing:write"])),
  rule("report_run_complete", "any", "write", ["agent:write"]),
  ...APPFOLIO_ENTRY.map((name) => rule(name, "ffl", "write", ["agent:write"])),
];

const BY_NAME = new Map(RULES.map((r) => [r.name, r]));

export function ruleFor(name: string): ToolRule | undefined {
  return BY_NAME.get(name);
}

export function listToolRules(): readonly ToolRule[] {
  return RULES;
}

/**
 * A tool scope of `*` is a requirement that the key hold `*`.
 * It does not authorize a key with no scopes. A key that holds `*` still
 * satisfies a specific scope. A `:read` scope never satisfies a write,
 * send, or payment.
 */
export function scopeGrants(effect: Effect, granted: readonly string[], required: string): boolean {
  if (granted.length === 0 || required.length === 0) return false;
  if (required === "*") return granted.includes("*");
  if (granted.includes("*")) return true;
  if (!granted.includes(required)) return false;
  if (effect === "read") return true;
  return !required.endsWith(":read");
}

function businessAllowed(identity: CallerIdentity, business: Business | "any"): Decision | null {
  if (identity.authority === "scoped" && !identity.authorityOk) {
    return { ok: false, reason: identity.authorityError ?? "This agent's CRM identity has no business authority." };
  }
  // Legacy shared mode is explicit: it is not filtered by business, because
  // the CRM has not been asked to describe that token's business. Callers
  // still cannot pass a workspace or business selector.
  if (identity.authority === "legacy-shared") return null;
  if (business === "any") return null;
  if (identity.businesses.includes(business)) return null;
  return { ok: false, reason: "This agent's key is not authorized for that business." };
}

function decide(identity: CallerIdentity, tool: ToolRule, enableWrites: boolean): Decision {
  const business = businessAllowed(identity, tool.business);
  if (business) return business;
  if (tool.effect !== "read" && tool.writesFlag && !enableWrites) {
    return { ok: false, reason: "Writes are not enabled for this connection." };
  }
  if (!tool.scopes.some((required) => scopeGrants(tool.effect, identity.scopes, required))) {
    return { ok: false, reason: "This agent's key does not include the scope for that tool." };
  }
  return { ok: true };
}

/**
 * Server-owned onboarding surface for a new scoped key.
 * Nothing here reads or writes CRM business records. A route is added only
 * after the CRM reviewer attests it. `?tools=` cannot add to this list.
 */
export const CONNECTION_STATUS_TOOL = {
  name: "connection_status",
  method: "GET",
  path: "mcp://connection-status",
} as const;

export const ONBOARDING_ALLOWLIST: readonly { name: string; method: string; path: string }[] = [
  CONNECTION_STATUS_TOOL,
];

export function onboardingAllows(tool: { name: string; method: string; path: string }): boolean {
  return ONBOARDING_ALLOWLIST.some(
    (entry) => entry.name === tool.name && entry.method === tool.method && entry.path === tool.path,
  );
}

export function connectionStatusPayload(identity: CallerIdentity): Record<string, unknown> {
  return {
    profile: "onboarding",
    authority: identity.authority,
    businesses: identity.businesses,
    workspaceIds: identity.workspaceIds,
    scopes: identity.scopes,
    allowlist: ONBOARDING_ALLOWLIST.map((entry) => ({ ...entry, clearsData: false })),
    dataRoutesCleared: [],
  };
}

function scopedAllowlist(
  identity: CallerIdentity,
  tool: { name: string; method: string; path: string },
): Decision | null {
  if (identity.authority !== "scoped") return null;
  if (!identity.authorityOk) {
    return { ok: false, reason: identity.authorityError ?? "This agent's CRM identity has no business authority." };
  }
  if (!onboardingAllows(tool)) {
    return { ok: false, reason: "This tool is not on the onboarding allowlist." };
  }
  return { ok: true };
}

/** Whether a synthetic tool may be listed or called. The URL `?tools=` filter is not an input. */
export function permitTool(
  identity: CallerIdentity,
  name: string,
  opts: { enableWrites: boolean },
): Decision {
  if (identity.authority === "scoped") {
    return { ok: false, reason: "This tool is not on the onboarding allowlist." };
  }
  const tool = ruleFor(name);
  if (!tool) return { ok: false, reason: "Unknown tool." };
  if (name === "owner_billing") {
    const list = decide(identity, tool, opts.enableWrites);
    if (list.ok) return list;
    return decide(
      identity,
      { ...tool, effect: "payment", scopes: ["properties:write"] },
      opts.enableWrites,
    );
  }
  return decide(identity, tool, opts.enableWrites);
}

/**
 * `?tools=` may only narrow. It cannot grant a tool the key's scopes and
 * business do not already allow.
 */
export function exposeTool(
  name: string,
  filter: ReadonlySet<string> | null,
  identity: CallerIdentity,
  opts: { enableWrites: boolean },
): boolean {
  if (filter && !filter.has(name)) return false;
  return permitTool(identity, name, opts).ok;
}

const OWNER_BILLING_WRITES = new Set(["dont_charge", "undo"]);

/** list stays a read. dont_charge and undo change the billing list and are not reads. */
export function permitOwnerBillingAction(
  identity: CallerIdentity,
  args: Record<string, unknown>,
  enableWrites: boolean,
): Decision {
  if (identity.authority === "scoped") {
    return { ok: false, reason: "This tool is not on the onboarding allowlist." };
  }
  const action = typeof args.action === "string" && args.action.trim() ? args.action.trim() : "list";
  if (action === "list") return permitTool(identity, "owner_billing", { enableWrites });
  if (!OWNER_BILLING_WRITES.has(action)) {
    return { ok: false, reason: "action must be list, dont_charge, or undo." };
  }
  return decide(
    identity,
    {
      name: "owner_billing",
      business: "ffl",
      effect: "payment",
      scopes: ["properties:write"],
      writesFlag: false,
    },
    enableWrites,
  );
}

export interface ManifestCapability {
  name: string;
  method: string;
  path: string;
  scope: string;
}

const FORBIDDEN = /(?:^|[_\-/])(sql|raw_query|raw-query|eval|shell|exec_code|remote_code|browser_cookie)(?:$|[_\-/])/i;
const SEND_OR_PAY = /(?:^|[_\-/])(send_email|send_sms|send_message|send|pay|payment|charge_card|transfer)(?:$|[_\-/])/i;

export function isForbiddenCapability(tool: { name: string; path: string }): boolean {
  return FORBIDDEN.test(`${tool.name} ${tool.path}`);
}

/** A GET whose name or path is a send or payment. Those stay write tools. */
export function isExecutableHiddenAsRead(tool: { name: string; method: string; path: string }): boolean {
  if (tool.method !== "GET") return false;
  return SEND_OR_PAY.test(`${tool.name} ${tool.path}`);
}

function effectOfManifest(tool: ManifestCapability): Effect {
  const blob = `${tool.name} ${tool.path}`;
  if (/(?:^|[_\-/])(send_email|send_sms|send_message|send)(?:$|[_\-/])/i.test(blob)) return "send";
  if (/(?:^|[_\-/])(pay|payment|charge_card|transfer|owner-billing|owner_billing)(?:$|[_\-/])/i.test(blob)) {
    return "payment";
  }
  return "write";
}

function businessOfManifest(tool: ManifestCapability): Business | "any" {
  const blob = `${tool.name} ${tool.path}`.toLowerCase();
  const ffl = /ffl|appfolio|showmojo|landlord/.test(blob);
  const cran = /cranbrook|cf-lead|cfa-numbers|leasing-triage|leasing-office/.test(blob);
  if (ffl && !cran) return "ffl";
  if (cran && !ffl) return "cranbrook";
  return "any";
}

export function permitManifestTool(
  identity: CallerIdentity,
  tool: ManifestCapability,
  opts: { enableWrites: boolean },
): Decision {
  const surface = scopedAllowlist(identity, tool);
  if (surface && !surface.ok) return surface;
  if (isForbiddenCapability(tool)) {
    return { ok: false, reason: "This server does not expose that capability." };
  }
  if (isExecutableHiddenAsRead(tool)) {
    return { ok: false, reason: "Send and payment operations are not available as read tools." };
  }
  const isWrite = WRITE_METHODS.has(tool.method);
  if (isWrite && !opts.enableWrites) {
    return { ok: false, reason: "Writes are not enabled for this connection." };
  }
  const effect: Effect = isWrite ? effectOfManifest(tool) : "read";
  if (!scopeGrants(effect, identity.scopes, tool.scope)) {
    return { ok: false, reason: "This agent's key does not include the scope for that tool." };
  }
  const business = businessAllowed(identity, businessOfManifest(tool));
  if (business) return business;
  return { ok: true };
}

export type ConfineWhere = "top" | "query" | "none";

export type ConfineResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

type SelectorKind = "workspace" | "business" | "tenant";

interface SelectorHit {
  kind: SelectorKind;
  plural: boolean;
  key: string;
  value: unknown;
  parent: Record<string, unknown>;
}

/** The key is a selector even when the value is an object, an array, or null. */
function selectorKind(key: string): { kind: SelectorKind; plural: boolean } | null {
  const flat = key.replace(/[_-]/g, "").toLowerCase();
  if (flat === "workspaceid" || flat === "workspace") return { kind: "workspace", plural: false };
  if (flat === "workspaceids" || flat === "workspaces") return { kind: "workspace", plural: true };
  if (flat === "businessid" || flat === "business") return { kind: "business", plural: false };
  if (flat === "businessids" || flat === "businesses") return { kind: "business", plural: true };
  if (flat === "tenantid" || flat === "tenant") return { kind: "tenant", plural: false };
  if (flat === "tenantids" || flat === "tenants") return { kind: "tenant", plural: true };
  return null;
}

function walkSelectors(node: unknown, hits: SelectorHit[], depth: number): "ok" | "too-deep" {
  if (depth > SELECTOR_DEPTH_BUDGET) return "too-deep";
  if (Array.isArray(node)) {
    for (const item of node) {
      if (walkSelectors(item, hits, depth + 1) === "too-deep") return "too-deep";
    }
    return "ok";
  }
  if (!isObj(node)) return "ok";
  for (const [key, value] of Object.entries(node)) {
    const kind = selectorKind(key);
    if (kind) {
      hits.push({ kind: kind.kind, plural: kind.plural, key, value, parent: node });
      continue;
    }
    if (isObj(value) || Array.isArray(value)) {
      if (depth === SELECTOR_DEPTH_BUDGET) return "too-deep";
      if (walkSelectors(value, hits, depth + 1) === "too-deep") return "too-deep";
    }
  }
  return "ok";
}

function stripSelectors(hits: SelectorHit[]): void {
  for (const hit of hits) delete hit.parent[hit.key];
}

/**
 * Caller selectors never choose a business. The only value that may be
 * supplied is the key's single pinned workspace id, on a workspace field.
 * businessId, tenant, aliases such as "ffl", and anything nested past the
 * budget are denied. The same rules apply to synthetic tools, manifest
 * tools, and stdio.
 */
export function confineArguments(
  identity: CallerIdentity,
  args: Record<string, unknown>,
  where: ConfineWhere,
  _toolBusiness: Business | "any" = "any",
): ConfineResult {
  if (identity.authority === "scoped" && !identity.authorityOk) {
    return { ok: false, reason: identity.authorityError ?? "This agent's CRM identity has no business authority." };
  }
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "Tool arguments could not be read." };
  }
  const hits: SelectorHit[] = [];
  if (walkSelectors(copy, hits, 0) === "too-deep") {
    return { ok: false, reason: "Tool arguments nest past the traversal budget." };
  }

  const allowed = new Set(identity.workspaceIds);
  const chosen = new Set<string>();
  for (const hit of hits) {
    if (hit.plural || typeof hit.value !== "string") {
      return { ok: false, reason: "A workspace, business, or tenant selector must be one allowlisted id." };
    }
    if (hit.kind !== "workspace") {
      return { ok: false, reason: "A caller cannot set business or tenant. The CRM key decides that." };
    }
    const value = hit.value.trim();
    if (WIDEN.has(value.toLowerCase()) || BUSINESS_TOKENS.has(value) || !allowed.has(value)) {
      return { ok: false, reason: "This agent's key is not authorized for that workspace." };
    }
    chosen.add(value);
  }
  if (chosen.size > 1) {
    return { ok: false, reason: "This agent's key is not authorized for that workspace." };
  }

  stripSelectors(hits);
  const pinned = identity.workspaceIds.length === 1 ? identity.workspaceIds[0] : undefined;
  const selected = chosen.size === 1 ? [...chosen][0] : undefined;
  if (where !== "none" && identity.workspaceIds.length > 1 && !selected) {
    return { ok: false, reason: "This key has more than one workspace. Name the one authorized workspace id." };
  }
  const canonical = selected ?? pinned;
  if (canonical) {
    if (where === "query") {
      const query = isObj(copy.query) ? copy.query : {};
      query.workspaceId = canonical;
      copy.query = query;
    } else {
      copy.workspaceId = canonical;
    }
  }
  return { ok: true, args: copy };
}

const CREDENTIAL_KEY = /^(authorization|proxyauthorization|apikey|token|accesstoken|refreshtoken|idtoken|secret|password|crmkey|bearer|cookie|setcookie|jwt|privatekey|clientsecret)$/;

function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key.replace(/[_-]/g, "").toLowerCase());
}

/** Prefix and bearer redaction. Does not treat record ids or UUIDs as secrets. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt redacted]")
    .replace(/ffl_[a-z0-9]+_[A-Za-z0-9_-]+/gi, "ffl_[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]+/g, "sk_[redacted]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
}

/** Redact credential fields by key, and secret prefixes inside other strings. */
export function redactStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactStructured(item));
  if (!isObj(value)) return typeof value === "string" ? redactSecrets(value) : value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isCredentialKey(key) ? "[redacted]" : redactStructured(item);
  }
  return out;
}

export interface AuditRecord {
  authority: AuthorityMode;
  authorityOk: boolean;
  apiKeyId?: string;
  agent?: string;
  tool: string;
  decision: "allow" | "deny";
  reason: string;
  businesses: Business[];
}

export function auditRecord(input: {
  identity: CallerIdentity;
  tool: string;
  decision: "allow" | "deny";
  reason?: string;
}): AuditRecord {
  return {
    authority: input.identity.authority,
    authorityOk: input.identity.authorityOk,
    apiKeyId: input.identity.apiKeyId,
    agent: input.identity.name,
    tool: input.tool,
    decision: input.decision,
    reason: redactSecrets(input.reason ?? ""),
    businesses: input.identity.businesses,
  };
}

export function formatAudit(record: AuditRecord): string {
  return redactSecrets(JSON.stringify(record));
}
