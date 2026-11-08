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
/**
 * Event-type management tools.
 *
 * Published locally until the deployed CRM manifest (GET /api/v1/me →
 * capabilities[]) includes them natively (ffl-crm PR: /api/v1/event-types).
 * Entries mirror the CRM TOOL_MANIFEST shape exactly. If the CRM starts
 * publishing a tool with the same name, the server copy wins and the
 * local one is dropped — the CRM stays the source of truth.
 */
export declare const SUPPLEMENTAL_TOOLS: ManifestTool[];
export declare function loadManifest(client: ApiClient): Promise<MeResponse>;
export declare function extractPathParams(path: string): string[];
export declare function substitutePath(path: string, params: Record<string, string>): string;
//# sourceMappingURL=manifest.d.ts.map