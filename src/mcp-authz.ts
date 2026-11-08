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

export interface CallerIdentity {
  apiKeyId?: string;
  name?: string;
  email?: string;
  scopes: string[];
  /** Empty when /api/v1/me did not declare a business. Not a grant of both. */
  businesses: Business[];
  /** Empty when /api/v1/me did not declare workspace ids. */
  workspaceIds: string[];
}

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

const FFL_ALIASES = new Set([
  "ffl",
  "flat fee landlord",
  "flatfeelandlord",
  "flat-fee-landlord",
  "landlord",
]);
const CRANBROOK_ALIASES = new Set([
  "cranbrook",
  "cranbrook forest",
  "cranbrook-forest",
  "cfa",
  "resman",
]);

const SELECTOR_KEYS = new Set([
  "workspaceId",
  "workspace_id",
  "workspace",
  "business",
  "businessId",
  "business_id",
  "tenant",
  "tenantId",
  "tenant_id",
]);

const WORKSPACE_KEYS = new Set([
  "workspaceId",
  "workspace_id",
  "workspace",
  "tenant",
  "tenantId",
  "tenant_id",
]);

const WIDEN = new Set(["", "*", "all", "any", "none"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normalizeBusiness(value: string): Business | null {
  const s = value.trim().toLowerCase();
  if (FFL_ALIASES.has(s)) return "ffl";
  if (CRANBROOK_ALIASES.has(s)) return "cranbrook";
  return null;
}

function addBusiness(into: Set<Business>, value: unknown): void {
  if (typeof value !== "string") return;
  const b = normalizeBusiness(value);
  if (b) into.add(b);
}

function addWorkspaceId(into: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const id = value.trim();
  if (!id || normalizeBusiness(id)) return;
  into.add(id);
}

function absorbBinding(value: unknown, businesses: Set<Business>, workspaceIds: Set<string>): void {
  if (typeof value === "string") {
    addBusiness(businesses, value);
    addWorkspaceId(workspaceIds, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) absorbBinding(item, businesses, workspaceIds);
    return;
  }
  if (!isObj(value)) return;
  addBusiness(businesses, value.business ?? value.slug ?? value.name);
  addWorkspaceId(workspaceIds, value.id ?? value.workspaceId ?? value.workspace_id);
  if (Array.isArray(value.workspaceIds)) {
    for (const id of value.workspaceIds) addWorkspaceId(workspaceIds, id);
  }
  if (Array.isArray(value.workspaces)) absorbBinding(value.workspaces, businesses, workspaceIds);
  if (value.workspace && value.workspace !== value) absorbBinding(value.workspace, businesses, workspaceIds);
}

/** Read the identity /api/v1/me already returns. Unknown shapes yield no grants. */
export function parseCallerIdentity(raw: unknown): CallerIdentity {
  const o = isObj(raw) ? raw : {};
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : [];
  const businesses = new Set<Business>();
  const workspaceIds = new Set<string>();
  if (typeof o.business === "string" && /^(both|ffl\+cranbrook)$/i.test(o.business.trim())) {
    businesses.add("ffl");
    businesses.add("cranbrook");
  } else {
    addBusiness(businesses, o.business);
  }
  if (Array.isArray(o.businesses)) {
    for (const b of o.businesses) addBusiness(businesses, b);
  }
  absorbBinding(o.workspaceIds, businesses, workspaceIds);
  absorbBinding(o.workspaces, businesses, workspaceIds);
  absorbBinding(o.workspace, businesses, workspaceIds);
  addWorkspaceId(workspaceIds, o.workspaceId ?? o.workspace_id);
  const name =
    (typeof o.agentName === "string" && o.agentName) ||
    (typeof o.name === "string" && o.name) ||
    undefined;
  return {
    apiKeyId: typeof o.apiKeyId === "string" ? o.apiKeyId : undefined,
    name,
    email: typeof o.email === "string" ? o.email : undefined,
    scopes,
    businesses: [...businesses],
    workspaceIds: [...workspaceIds],
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

function scopeSatisfies(effect: Effect, granted: readonly string[], required: string): boolean {
  if (required === "*") return true;
  if (granted.includes("*")) return true;
  if (!granted.includes(required)) return false;
  if (effect === "read") return true;
  // A read scope never authorizes a write, send, or payment, even if a tool
  // description used to claim that it did.
  return !required.endsWith(":read");
}

function businessAllowed(identity: CallerIdentity, business: Business | "any"): Decision | null {
  if (business === "any") return null;
  if (identity.businesses.length === 0) return null;
  if (identity.businesses.includes(business)) return null;
  return { ok: false, reason: "This agent's key is not authorized for that business." };
}

function decide(identity: CallerIdentity, tool: ToolRule, enableWrites: boolean): Decision {
  const business = businessAllowed(identity, tool.business);
  if (business) return business;
  if (tool.effect !== "read" && tool.writesFlag && !enableWrites) {
    return { ok: false, reason: "Writes are not enabled for this connection." };
  }
  if (!tool.scopes.some((required) => scopeSatisfies(tool.effect, identity.scopes, required))) {
    return { ok: false, reason: "This agent's key does not include the scope for that tool." };
  }
  return { ok: true };
}

/** Whether a synthetic tool may be listed or called. The URL `?tools=` filter is not an input. */
export function permitTool(
  identity: CallerIdentity,
  name: string,
  opts: { enableWrites: boolean },
): Decision {
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
  if (!scopeSatisfies(effect, identity.scopes, tool.scope)) {
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

interface SelectorHit {
  key: string;
  value: string;
}

function walkSelectors(node: unknown, hits: SelectorHit[], depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) walkSelectors(item, hits, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (SELECTOR_KEYS.has(key)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        hits.push({
          key,
          value: item === undefined || item === null ? "" : String(item).trim(),
        });
      }
    }
    if (isObj(value) || Array.isArray(value)) walkSelectors(value, hits, depth + 1);
  }
}

function stripWiden(node: unknown, depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) stripWiden(item, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  for (const key of Object.keys(node)) {
    if (SELECTOR_KEYS.has(key)) {
      const value = node[key];
      const text = value === undefined || value === null ? "" : String(value).trim().toLowerCase();
      if (WIDEN.has(text)) delete node[key];
    } else {
      stripWiden(node[key], depth + 1);
    }
  }
}

/**
 * Caller-supplied workspace and business ids do not expand the key.
 *
 * When the identity lists workspace ids, an id outside that list is denied
 * (including one buried in a pagination query). Omitting the id on a
 * single-workspace key pins the call to that workspace so "omit means all"
 * cannot page into another one.
 *
 * When the identity lists no workspace ids, opaque ids are left in place so
 * existing filters keep working. The CRM must reject an id that belongs to
 * the other business; this server cannot see that binding until /api/v1/me
 * returns workspaceIds. A business slug the key is not allowed to use, or a
 * slug that contradicts the tool's business, is denied either way.
 */
export function confineArguments(
  identity: CallerIdentity,
  args: Record<string, unknown>,
  where: ConfineWhere,
  toolBusiness: Business | "any" = "any",
): ConfineResult {
  const copy = JSON.parse(JSON.stringify(args ?? {})) as Record<string, unknown>;
  const hits: SelectorHit[] = [];
  walkSelectors(copy, hits, 0);

  for (const hit of hits) {
    const widened = WIDEN.has(hit.value.toLowerCase());
    if (widened && (identity.workspaceIds.length > 0 || identity.businesses.length > 0)) {
      return { ok: false, reason: "This agent's key cannot clear its workspace or business filter." };
    }
    const asBusiness = normalizeBusiness(hit.value);
    if (asBusiness) {
      if (toolBusiness !== "any" && asBusiness !== toolBusiness) {
        return { ok: false, reason: "This agent's key is not authorized for that business." };
      }
      if (identity.businesses.length > 0 && !identity.businesses.includes(asBusiness)) {
        return { ok: false, reason: "This agent's key is not authorized for that business." };
      }
      continue;
    }
    if (!WORKSPACE_KEYS.has(hit.key)) continue;
    if (identity.workspaceIds.length > 0 && hit.value !== "" && !identity.workspaceIds.includes(hit.value)) {
      return { ok: false, reason: "This agent's key is not authorized for that workspace." };
    }
  }

  // An unbound key may keep a real workspace filter. "all" / "*" is not a filter.
  if (identity.workspaceIds.length === 0 && identity.businesses.length === 0) stripWiden(copy, 0);

  const pinned = identity.workspaceIds.length === 1 ? identity.workspaceIds[0] : undefined;
  const suppliedWorkspace = hits.some(
    (h) => WORKSPACE_KEYS.has(h.key) && !WIDEN.has(h.value.toLowerCase()) && !normalizeBusiness(h.value),
  );
  if (where !== "none" && pinned && !suppliedWorkspace) {
    if (where === "query") {
      const query = isObj(copy.query) ? copy.query : {};
      query.workspaceId = pinned;
      copy.query = query;
    } else {
      copy.workspaceId = pinned;
    }
  }
  return { ok: true, args: copy };
}

/** Remove credential material from text that might be logged or returned. */
export function redactSecrets(text: string): string {
  return text
    .replace(/ffl_live_[A-Za-z0-9_-]+/g, "ffl_live_[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, "sk_[redacted]")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-[redacted]");
}

export interface AuditRecord {
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
    apiKeyId: input.identity.apiKeyId,
    agent: input.identity.name,
    tool: input.tool,
    decision: input.decision,
    reason: redactSecrets(input.reason ?? ""),
    businesses: input.identity.businesses,
  };
}
