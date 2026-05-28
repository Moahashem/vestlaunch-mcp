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
const VALID_METHODS = [
    "GET",
    "POST",
    "PATCH",
    "DELETE",
    "PUT",
];
function isManifestTool(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    return (typeof v.name === "string" &&
        typeof v.method === "string" &&
        VALID_METHODS.includes(v.method) &&
        typeof v.path === "string" &&
        typeof v.scope === "string" &&
        typeof v.description === "string");
}
export async function loadManifest(client) {
    const res = await client.request({ method: "GET", path: "/api/v1/me" });
    if (!res.success) {
        throw new Error(`[vestlaunch-mcp] Failed to load tool manifest from /api/v1/me ` +
            `(HTTP ${res.statusCode}): ${res.error}. ` +
            `Check VESTLAUNCH_BASE_URL and that VESTLAUNCH_API_KEY is valid + has at least one scope.`);
    }
    const data = res.data;
    if (!data || typeof data !== "object" || !Array.isArray(data.capabilities)) {
        throw new Error(`[vestlaunch-mcp] /api/v1/me returned an unexpected shape — capabilities[] missing.`);
    }
    const tools = data.capabilities.filter(isManifestTool);
    if (tools.length === 0) {
        throw new Error(`[vestlaunch-mcp] Manifest has 0 valid tools. Aborting — something is wrong server-side.`);
    }
    return { ...data, capabilities: tools };
}
/**
 * Path-template helpers — extract `:id` style placeholders so the MCP
 * tool can require them as inputs and we can substitute at call time.
 */
const PARAM_PATTERN = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
export function extractPathParams(path) {
    const params = [];
    for (const match of path.matchAll(PARAM_PATTERN)) {
        if (match[1])
            params.push(match[1]);
    }
    return params;
}
export function substitutePath(path, params) {
    return path.replace(PARAM_PATTERN, (_, key) => {
        const value = params[key];
        if (value === undefined || value === "") {
            throw new Error(`Missing required path parameter: ${key}`);
        }
        return encodeURIComponent(value);
    });
}
//# sourceMappingURL=manifest.js.map