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
export declare function loadManifest(client: ApiClient): Promise<MeResponse>;
export declare function extractPathParams(path: string): string[];
export declare function substitutePath(path: string, params: Record<string, string>): string;
//# sourceMappingURL=manifest.d.ts.map