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
            // ENCODING CONTRACT (fixed 2026-07-31, s31 — this is why every
            // vestlaunch_update_* call returned 400 "Invalid JSON"):
            //
            // We used to send `Content-Type: application/json` on EVERY request
            // while sending `body: undefined` whenever the caller had no body. A
            // CRM write route does `await req.json()`, and parsing an empty payload
            // that claims to be JSON throws — so the route answered "Invalid JSON"
            // before it ever looked at the request. The header promised a document
            // that was not there.
            //
            // Now the two travel together: a write always carries a JSON body (`{}`
            // at worst, which earns a real field-level validation error instead of a
            // parse error), and the header is only set when a body is actually
            // written. A GET stays bodiless and unheadered.
            const sendsBody = opts.method !== "GET" || opts.body !== undefined;
            const payload = sendsBody ? JSON.stringify(opts.body ?? {}) : undefined;
            const res = await fetch(url, {
                method: opts.method,
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
                    "User-Agent": "vestlaunch-mcp/0.1.0",
                },
                body: payload,
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