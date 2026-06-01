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
  return { ...(data as MeResponse), capabilities: tools };
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
