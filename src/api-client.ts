/**
 * Typed REST client for the FFL CRM /api/v1/* surface.
 *
 * One client instance per process. Auth via Bearer token. The CRM logs
 * every request to its ApiLog table keyed by the API key id, so the
 * agent identity flows back automatically.
 */

import type { Config } from "./config.js";
import { log } from "./log.js";

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

export class ApiClient {
  constructor(private readonly config: Config) {}

  async request<T = unknown>(opts: RequestOptions): Promise<ApiResponse<T>> {
    const url = this.buildUrl(opts.path, opts.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      log.debug(`${opts.method} ${opts.path}`, { query: opts.query });
      const res = await fetch(url, {
        method: opts.method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "vestlaunch-mcp/0.1.0",
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      const json: unknown = text.length > 0 ? this.safeJson(text) : null;
      if (!res.ok) {
        return {
          success: false,
          error: this.extractError(json) ?? `HTTP ${res.status} ${res.statusText}`,
          details: this.extractDetails(json),
          statusCode: res.status,
        };
      }
      return (json ?? { success: true, data: null }) as ApiResponse<T>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`request failed: ${msg}`, { path: opts.path });
      return {
        success: false,
        error: msg,
        statusCode: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const trimmed = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.baseUrl}${trimmed}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private safeJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  }

  private extractError(json: unknown): string | undefined {
    if (json && typeof json === "object" && "error" in json) {
      const e = (json as Record<string, unknown>).error;
      return typeof e === "string" ? e : undefined;
    }
    return undefined;
  }

  private extractDetails(json: unknown): Record<string, unknown> | undefined {
    if (json && typeof json === "object" && "details" in json) {
      const d = (json as Record<string, unknown>).details;
      return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : undefined;
    }
    return undefined;
  }
}
