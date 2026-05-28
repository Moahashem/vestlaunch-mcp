/**
 * Typed REST client for the FFL CRM /api/v1/* surface.
 *
 * One client instance per process. Auth via Bearer token. The CRM logs
 * every request to its ApiLog table keyed by the API key id, so the
 * agent identity flows back automatically.
 */
import { log } from "./log.js";
export class ApiClient {
    config;
    constructor(config) {
        this.config = config;
    }
    async request(opts) {
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
            const json = text.length > 0 ? this.safeJson(text) : null;
            if (!res.ok) {
                return {
                    success: false,
                    error: this.extractError(json) ?? `HTTP ${res.status} ${res.statusText}`,
                    details: this.extractDetails(json),
                    statusCode: res.status,
                };
            }
            // CRM response shape: { data: T, meta?: { total, limit, offset, ... } }
            // We flatten meta into our success envelope for caller convenience.
            const body = (json ?? {});
            const meta = (body.meta && typeof body.meta === "object" ? body.meta : {});
            return {
                success: true,
                data: (body.data === undefined ? null : body.data),
                ...meta,
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`request failed: ${msg}`, { path: opts.path });
            return {
                success: false,
                error: msg,
                statusCode: 0,
            };
        }
        finally {
            clearTimeout(timer);
        }
    }
    buildUrl(path, query) {
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
    safeJson(text) {
        try {
            return JSON.parse(text);
        }
        catch {
            return { error: text };
        }
    }
    extractError(json) {
        if (json && typeof json === "object" && "error" in json) {
            const e = json.error;
            return typeof e === "string" ? e : undefined;
        }
        return undefined;
    }
    extractDetails(json) {
        if (json && typeof json === "object" && "details" in json) {
            const d = json.details;
            return typeof d === "object" && d !== null ? d : undefined;
        }
        return undefined;
    }
}
//# sourceMappingURL=api-client.js.map