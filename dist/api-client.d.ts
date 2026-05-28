/**
 * Typed REST client for the FFL CRM /api/v1/* surface.
 *
 * One client instance per process. Auth via Bearer token. The CRM logs
 * every request to its ApiLog table keyed by the API key id, so the
 * agent identity flows back automatically.
 */
import type { Config } from "./config.js";
export interface ApiSuccess<T = unknown> {
    success: true;
    data: T;
    total?: number;
    limit?: number;
    offset?: number;
    [key: string]: unknown;
}
export interface ApiFailure {
    success: false;
    error: string;
    details?: Record<string, unknown>;
    statusCode: number;
}
export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
export interface RequestOptions {
    method: HttpMethod;
    path: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    body?: unknown;
}
export declare class ApiClient {
    private readonly config;
    constructor(config: Config);
    request<T = unknown>(opts: RequestOptions): Promise<ApiResponse<T>>;
    private buildUrl;
    private safeJson;
    private extractError;
    private extractDetails;
}
//# sourceMappingURL=api-client.d.ts.map