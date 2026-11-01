/** Read-only VideoAsk transport. No email, CRM writes, or webhook registration. */
const API = "https://api.videoask.com";
const ORG = "94dc21de-9c4d-4abc-a933-d8324bd853e3";
const QUESTION = "0d0ab5f1-fa6c-46af-849f-2081f65d9af3";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

export function videoaskReadUrl(path: string): URL {
  const url = new URL(path, API);
  if (url.origin !== API || url.username || url.password || url.hash ||
      !(url.pathname === "/forms" ||
        new RegExp(`^/forms/${UUID}/contacts$`).test(url.pathname) ||
        url.pathname === `/questions/${QUESTION}/answers`)) {
    throw new Error("VideoAsk endpoint is outside the recruiting read allowlist");
  }
  for (const [key, value] of url.searchParams) {
    if (!["limit", "offset"].includes(key) || !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("Invalid VideoAsk pagination parameters");
    }
    if (key === "limit" && (Number(value) < 1 || Number(value) > 100)) {
      throw new Error("Invalid VideoAsk page size");
    }
  }
  return url;
}

export interface VideoaskCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** One refresh per instance, shared by concurrent readers. Never logs upstream bodies. */
export function createVideoaskReader(credentials: () => VideoaskCredentials, fetcher: typeof fetch = fetch) {
  let cached: { value: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  async function token(): Promise<string> {
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      const c = credentials();
      if (!c.clientId || !c.clientSecret || !c.refreshToken) throw new Error("Direct VideoAsk OAuth is not configured");
      const response = await fetcher("https://auth.videoask.com/oauth/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId,
          client_secret: c.clientSecret, refresh_token: c.refreshToken,
          scope: "openid profile email offline_access" }),
      });
      if (!response.ok) throw new Error(`VideoAsk OAuth HTTP ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      // Environment-backed credentials cannot safely persist rotated refresh tokens.
      // Block activation if this provider/app requires rotation; never silently lose one.
      if (body.refresh_token && body.refresh_token !== c.refreshToken) {
        throw new Error("VideoAsk refresh-token rotation requires durable credential storage before activation");
      }
      if (typeof body.access_token !== "string" || !body.access_token ||
          typeof body.expires_in !== "number" || body.expires_in <= 60 ||
          !Number.isFinite(body.expires_in)) throw new Error("Invalid VideoAsk OAuth response");
      cached = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
      return cached.value;
    })();
    try { return await pending; } finally { pending = undefined; }
  }
  return async function read(path: string): Promise<Record<string, unknown>> {
    const url = videoaskReadUrl(path); // Validate before obtaining credentials.
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await token();
      const response = await fetcher(url, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(25_000),
        headers: { authorization: `Bearer ${access}`, "organization-id": ORG, accept: "application/json" },
      });
      if (response.status === 401 && attempt === 0) {
        if (cached?.value === access) cached = undefined;
        continue;
      }
      // No automatic 429 retries or fallback: preserve fail-closed caller behavior.
      if (!response.ok) throw new Error(`VideoAsk GET ${url.pathname} HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid VideoAsk response");
      const page = body as Record<string, unknown>;
      if (page.error || page.isError || !Array.isArray(page.results ?? page.contents)) {
        throw new Error("VideoAsk response is not a successful collection page");
      }
      return page;
    }
    throw new Error("VideoAsk authentication failed");
  };
}

export const directVideoaskGet = createVideoaskReader(() => ({
  clientId: process.env.VIDEOASK_CLIENT_ID?.trim() ?? "",
  clientSecret: process.env.VIDEOASK_CLIENT_SECRET?.trim() ?? "",
  refreshToken: process.env.VIDEOASK_REFRESH_TOKEN?.trim() ?? "",
}));
