/**
 * Manifest loader.
 *
 * The CRM publishes a machine-readable tool manifest at /api/v1/me under
 * the `capabilities` key. We fetch it once at startup, validate the
 * shape, and hand it to the tool registrar.
 *
 * The CRM is the source of truth — new endpoints surface as new MCP
 * tools automatically without code changes here.
 */

import type { ApiClient } from "./api-client.js";
import type { HttpMethod } from "./api-client.js";

export interface ManifestTool {
  name: string;
  method: HttpMethod;
  path: string;
  scope: string;
  description: string;
  /**
   * Optional JSON Schema describing the tool's flat input arguments
   * (path params, query/body fields). Published by the CRM manifest so
   * the connector can register fully-typed tools instead of a generic
   * body/query blob. When absent, the connector falls back to the
   * generic path/query/body shape.
   */
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface AgentIdentity {
  apiKeyId: string;
  name: string;
  actorType: string;
  agentName?: string;
  scopes: string[];
  keyPrefix: string;
}

export interface MeResponse {
  identity: AgentIdentity;
  usage: {
    requestsToday: number;
    rateLimitPerMinute: number;
    lastUsedAt: string | null;
  };
  crm: {
    totalContacts: number;
    totalOpportunities: number;
    openTasks: number;
    activeWorkflows: number;
  };
  capabilities: ManifestTool[];
}

const VALID_METHODS: ReadonlyArray<HttpMethod> = [
  "GET",
  "POST",
  "PATCH",
  "DELETE",
  "PUT",
];

function isManifestTool(value: unknown): value is ManifestTool {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.method === "string" &&
    VALID_METHODS.includes(v.method as HttpMethod) &&
    typeof v.path === "string" &&
    typeof v.scope === "string" &&
    typeof v.description === "string"
  );
}

/**
 * Event-type management tools.
 *
 * Published locally until the deployed CRM manifest (GET /api/v1/me →
 * capabilities[]) includes them natively (ffl-crm PR: /api/v1/event-types).
 * Entries mirror the CRM TOOL_MANIFEST shape exactly. If the CRM starts
 * publishing a tool with the same name, the server copy wins and the
 * local one is dropped — the CRM stays the source of truth.
 */
export const SUPPLEMENTAL_TOOLS: ManifestTool[] = [
  { name: "list_event_types", method: "GET", path: "/api/v1/event-types", scope: "event_types:read", description: "List org-level scheduling event types (the /book/event/[slug] pages) with active members, workspace, and question/member/booking counts. Query: ?workspaceId=&includeInactive=true.", inputSchema: { type: "object", properties: { workspaceId: { type: "string", description: "Filter to one workspace. Omit for all." }, includeInactive: { type: "boolean", description: "Default false — only active event types." }, limit: { type: "integer", minimum: 1, maximum: 200, description: "Max results to return." }, offset: { type: "integer", minimum: 0, description: "Pagination offset." } }, additionalProperties: false } },
  { name: "create_event_type", method: "POST", path: "/api/v1/event-types", scope: "event_types:write", description: "Create a scheduling event type. Required: name, slug (URL-safe, unique). Defaults: duration 30, locationType IN_PERSON, routingStrategy ROUND_ROBIN, minNoticeMins 60, maxAdvanceDays 30, timezone America/Chicago, requiresConfirmation false. Add hosts via add_event_type_member afterwards — bookings need at least one member.", inputSchema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string", description: "URL-safe slug for /book/event/<slug>. Lowercase letters, numbers, hyphens." }, headline: { type: "string", description: "Override headline on the public booking page." }, description: { type: "string" }, category: { type: "string", description: "discovery, tour, follow_up, custom, ..." }, duration: { type: "integer", minimum: 5, maximum: 480, description: "Meeting length in minutes. Default 30." }, locationType: { type: "string", enum: ["PHONE", "VIDEO", "IN_PERSON", "CUSTOM"] }, locationDetails: { type: "string", description: "Address, Zoom link, etc." }, routingStrategy: { type: "string", enum: ["ROUND_ROBIN", "LEAST_BUSY", "FIRST_AVAILABLE"] }, minNoticeMins: { type: "integer", minimum: 0, description: "Minimum booking notice in minutes. Default 60." }, maxAdvanceDays: { type: "integer", minimum: 1, description: "How far out bookings are allowed. Default 30." }, timezone: { type: "string", description: "IANA timezone for slot display. Default America/Chicago." }, requiresConfirmation: { type: "boolean", description: "If true, host must accept before the booking confirms." }, workspaceId: { type: "string", description: "Scope to a workspace. Omit for org-wide." }, color: { type: "string" }, slotInterval: { type: "integer", minimum: 5 }, bufferBefore: { type: "integer", minimum: 0 }, bufferAfter: { type: "integer", minimum: 0 }, maxPerDay: { type: "integer", minimum: 1 }, emailReminderMinutes: { type: ["integer", "null"], description: "Minutes before start for the email reminder. Null disables. Default 60." }, smsReminderMinutes: { type: "integer" } }, required: ["name", "slug"], additionalProperties: false } },
  { name: "get_event_type", method: "GET", path: "/api/v1/event-types/:id", scope: "event_types:read", description: "Get one event type with active members (hosts), booking-form questions, and workspace.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Record ID (cuid)." } }, required: ["id"], additionalProperties: false } },
  { name: "update_event_type", method: "PATCH", path: "/api/v1/event-types/:id", scope: "event_types:write", description: "Update an event type. Same fields as create_event_type plus isActive (false = soft-delete). Slug changes are uniqueness-checked.", inputSchema: { type: "object", properties: { id: { type: "string", description: "Record ID (cuid)." }, name: { type: "string" }, slug: { type: "string" }, headline: { type: "string" }, description: { type: "string" }, category: { type: "string" }, duration: { type: "integer", minimum: 5, maximum: 480 }, locationType: { type: "string", enum: ["PHONE", "VIDEO", "IN_PERSON", "CUSTOM"] }, locationDetails: { type: "string" }, routingStrategy: { type: "string", enum: ["ROUND_ROBIN", "LEAST_BUSY", "FIRST_AVAILABLE"] }, minNoticeMins: { type: "integer", minimum: 0 }, maxAdvanceDays: { type: "integer", minimum: 1 }, timezone: { type: "string" }, requiresConfirmation: { type: "boolean" }, workspaceId: { type: ["string", "null"], description: "Null clears back to org-wide." }, color: { type: "string" }, slotInterval: { type: "integer", minimum: 5 }, bufferBefore: { type: "integer", minimum: 0 }, bufferAfter: { type: "integer", minimum: 0 }, maxPerDay: { type: ["integer", "null"] }, emailReminderMinutes: { type: ["integer", "null"] }, smsReminderMinutes: { type: ["integer", "null"] }, isActive: { type: "boolean", description: "false soft-deletes (keeps booking history)." } }, required: ["id"], additionalProperties: false } },
  { name: "add_event_type_question", method: "POST", path: "/api/v1/event-types/:id/questions", scope: "event_types:write", description: "Add a booking-form question to an event type. crmField auto-populates that Contact field with the guest's answer at booking time. sortOrder auto-appends when omitted.", inputSchema: { type: "object", properties: { id: { type: "string", description: "EventType ID (cuid)." }, label: { type: "string", description: "Question text shown to the guest." }, fieldType: { type: "string", enum: ["text", "textarea", "select", "radio", "phone", "email"], description: "Default text." }, placeholder: { type: "string" }, required: { type: "boolean", description: "Default false." }, options: { type: "array", items: { type: "string" }, description: "Choices for select/radio." }, crmField: { type: "string", description: "Contact field to auto-populate with the answer (e.g. phone, market)." }, sortOrder: { type: "integer", minimum: 0 } }, required: ["id", "label"], additionalProperties: false } },
  { name: "add_event_type_member", method: "POST", path: "/api/v1/event-types/:id/members", scope: "event_types:write", description: "Add a host (UserProfile) to an event type's routing pool. Re-activates a previously removed member instead of duplicating. sortOrder = round-robin priority (lower = earlier); auto-appends when omitted.", inputSchema: { type: "object", properties: { id: { type: "string", description: "EventType ID (cuid)." }, userId: { type: "string", description: "UserProfile.id of the host to add." }, sortOrder: { type: "integer", minimum: 0 } }, required: ["id", "userId"], additionalProperties: false } },
];

export async function loadManifest(client: ApiClient): Promise<MeResponse> {
  const res = await client.request<MeResponse>({ method: "GET", path: "/api/v1/me" });
  if (!res.success) {
    throw new Error(
      `[vestlaunch-mcp] Failed to load tool manifest from /api/v1/me ` +
        `(HTTP ${res.statusCode}): ${res.error}. ` +
        `Check VESTLAUNCH_BASE_URL and that VESTLAUNCH_API_KEY is valid + has at least one scope.`,
    );
  }
  const data = res.data;
  if (!data || typeof data !== "object" || !Array.isArray((data as MeResponse).capabilities)) {
    throw new Error(
      `[vestlaunch-mcp] /api/v1/me returned an unexpected shape — capabilities[] missing.`,
    );
  }
  const tools = (data as MeResponse).capabilities.filter(isManifestTool);
  if (tools.length === 0) {
    throw new Error(
      `[vestlaunch-mcp] Manifest has 0 valid tools. Aborting — something is wrong server-side.`,
    );
  }
  // Merge in locally-published tools the CRM manifest doesn't know yet.
  // Server entries always win on name collision.
  const known = new Set(tools.map((t) => t.name));
  const supplements = SUPPLEMENTAL_TOOLS.filter((t) => !known.has(t.name));
  return { ...(data as MeResponse), capabilities: [...tools, ...supplements] };
}

/**
 * Path-template helpers — extract `:id` style placeholders so the MCP
 * tool can require them as inputs and we can substitute at call time.
 */
const PARAM_PATTERN = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function extractPathParams(path: string): string[] {
  const params: string[] = [];
  for (const match of path.matchAll(PARAM_PATTERN)) {
    if (match[1]) params.push(match[1]);
  }
  return params;
}

export function substitutePath(path: string, params: Record<string, string>): string {
  return path.replace(PARAM_PATTERN, (_, key: string) => {
    const value = params[key];
    if (value === undefined || value === "") {
      throw new Error(`Missing required path parameter: ${key}`);
    }
    return encodeURIComponent(value);
  });
}
