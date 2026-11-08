/**
 * Strict onboarding surface. The CRM sets identity.mcpProfile = "onboarding"
 * when it creates a key for a new bot. Existing keys omit the field and keep
 * today's /api/mcp behavior. A caller cannot choose this profile.
 *
 * No data route is cleared. connection_status reports the claims only.
 */

export const ONBOARDING_PROFILE = "onboarding";

export const CONNECTION_STATUS_TOOL = {
  name: "connection_status",
  method: "GET",
  path: "mcp://connection-status",
} as const;

export const ONBOARDING_ALLOWLIST: readonly { name: string; method: string; path: string }[] = [
  CONNECTION_STATUS_TOOL,
];

const BUSINESS = new Set(["ffl", "cranbrook", "both"]);

export type ProfileRead = "absent" | "onboarding" | "malformed";

function plainIdentity(identity: unknown): identity is Record<string, unknown> {
  return identity !== null && typeof identity === "object" && !Array.isArray(identity);
}

export function readMcpProfile(identity: unknown): ProfileRead {
  // A missing or non-object identity is not a successful legacy identity.
  // Only a JSON object that omits mcpProfile stays on the existing surface.
  if (!plainIdentity(identity)) return "malformed";
  if (!Object.prototype.hasOwnProperty.call(identity, "mcpProfile")) return "absent";
  const value = identity.mcpProfile;
  if (value === ONBOARDING_PROFILE) return "onboarding";
  return "malformed";
}

/** /api/mcp keeps serving only when the key is not marked onboarding. */
export function legacySurfaceDecision(identity: unknown): { ok: true } | { ok: false; reason: string } {
  const profile = readMcpProfile(identity);
  if (profile === "absent") return { ok: true };
  if (profile === "onboarding") {
    return {
      ok: false,
      reason: "This key is limited to the onboarding MCP and cannot use /api/mcp.",
    };
  }
  if (profile === "malformed") return { ok: false, reason: "CRM identity is malformed." };
  return { ok: false, reason: "mcpProfile is not a recognized server-issued value." };
}

export interface OnboardingClaims {
  businesses: Array<"ffl" | "cranbrook">;
  workspaceIds: string[];
  scopes: string[];
}

export function readOnboardingClaims(
  identity: unknown,
): { ok: true; claims: OnboardingClaims } | { ok: false; reason: string } {
  if (readMcpProfile(identity) === "malformed") {
    return { ok: false, reason: "CRM identity is malformed." };
  }
  if (readMcpProfile(identity) !== "onboarding") {
    return { ok: false, reason: "This key is not marked mcpProfile=onboarding." };
  }
  if (!identity || typeof identity !== "object") {
    return { ok: false, reason: "CRM identity is missing." };
  }
  const raw = identity as Record<string, unknown>;
  if (!Array.isArray(raw.scopes) || raw.scopes.length !== 1 || raw.scopes[0] !== "mcp:onboarding") {
    return { ok: false, reason: "onboarding keys must carry only the mcp:onboarding scope." };
  }
  const business = raw.business;
  if (business !== "ffl" && business !== "cranbrook" && business !== "both") {
    return { ok: false, reason: "business must be ffl, cranbrook, or both." };
  }
  if (raw.businesses !== undefined) {
    if (!Array.isArray(raw.businesses)) return { ok: false, reason: "businesses is malformed." };
    const listed = raw.businesses;
    const expect = business === "both" ? ["ffl", "cranbrook"] : [business];
    const same = listed.length === expect.length && expect.every((b) => listed.includes(b));
    if (!same || listed.some((b) => b !== "ffl" && b !== "cranbrook")) {
      return { ok: false, reason: "business claims conflict." };
    }
  }
  if (!Array.isArray(raw.workspaceIds) || raw.workspaceIds.length === 0) {
    return { ok: false, reason: "workspaceIds are missing." };
  }
  const workspaceIds: string[] = [];
  for (const id of raw.workspaceIds) {
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim() || BUSINESS.has(id)) {
      return { ok: false, reason: "workspaceIds must be workspace ids, not business names." };
    }
    if (!workspaceIds.includes(id)) workspaceIds.push(id);
  }
  const businesses: Array<"ffl" | "cranbrook"> = business === "both" ? ["ffl", "cranbrook"] : [business];
  return {
    ok: true,
    claims: { businesses, workspaceIds, scopes: raw.scopes as string[] },
  };
}

const SELECTOR_KEYS = new Set([
  "workspaceid",
  "business",
  "businessid",
  "tenant",
  "tenantid",
  "workspaceids",
  "workspaces",
  "businessids",
  "businesses",
  "tenantids",
  "tenants",
]);

const SELECTOR_DEPTH_BUDGET = 6;

function selectorKey(key: string): boolean {
  return SELECTOR_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

/**
 * The onboarding tool takes no selector. Any selector key is rejected whatever
 * its value type is, and a payload deeper than the budget is rejected whole.
 */
export function argumentsStayInsideOnboarding(value: unknown, depth = 0): boolean {
  if (depth > SELECTOR_DEPTH_BUDGET) return false;
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every((item) => argumentsStayInsideOnboarding(item, depth + 1));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (selectorKey(key)) return false;
    if (!argumentsStayInsideOnboarding(child, depth + 1)) return false;
  }
  return true;
}

export function onboardingAllows(name: string): boolean {
  return ONBOARDING_ALLOWLIST.some((entry) => entry.name === name);
}

export function connectionStatusPayload(claims: OnboardingClaims): Record<string, unknown> {
  return {
    profile: ONBOARDING_PROFILE,
    businesses: claims.businesses,
    workspaceIds: claims.workspaceIds,
    scopes: claims.scopes,
    allowlist: ONBOARDING_ALLOWLIST.map((entry) => ({ ...entry, clearsData: false })),
    dataRoutesCleared: [],
  };
}
