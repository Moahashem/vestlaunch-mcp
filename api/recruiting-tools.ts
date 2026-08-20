/**
 * Recruiting sweep — smart tools (D13) for the cloud half of the recruiting
 * invite sweep (see Mo's Recruiting folder: RECRUITING-SOP.md and
 * HANDOFF-recruiting-cloud-agent.md, both 2026-08-17).
 *
 * WHY THIS EXISTS
 *  - Managed Agents has NO env-secret mechanism (D8): everything the cloud
 *    recruiting agent needs must arrive as a remote MCP tool. These are those
 *    tools; api/recruiting-mcp.ts is their transport.
 *  - THIN AGENT, SMART TOOLS (D13): all pagination, date math, parsing and
 *    filtering happen HERE, server-side. The VideoAsk answers endpoint IGNORES
 *    the `fields` param and ships ~5k tokens of transcript per record — that
 *    payload must die inside this Vercel function, never reach the agent.
 *
 * UPSTREAM TRANSPORTS (all secrets in Vercel env — Mo places them, never hard-coded)
 *  - Gmail (mo@flatfeelandlord.com): DIRECT Gmail API. Preferred auth = OAuth
 *    refresh token (GMAIL_OAUTH_CLIENT_ID/SECRET + GMAIL_REFRESH_TOKEN) — the
 *    HOUSE pattern, identical to ffl-crm lib/gmail.ts. The original
 *    service-account-key plan is blocked by the org policy
 *    iam.disableServiceAccountKeyCreation (hit live 2026-08-17); the SA-JWT
 *    path below is kept only for a future keyless/WIF migration.
 *      GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_REFRESH_TOKEN
 *      GOOGLE_SA_KEY_JSON   — fallback only (unusable under current org policy)
 *      GMAIL_IMPERSONATE    — expected mailbox (default mo@flatfeelandlord.com)
 *  - VideoAsk: via the DEDICATED recruiting Zapier MCP server (raw GET action,
 *    verified live 2026-08-18: server "ffl-recruiting", tool
 *    videoask_make_api_get_request, envelope {"results":[{status,headers,body}]}).
 *    VideoAsk's direct API is OAuth-only with 24h tokens; Zapier already holds
 *    and refreshes that OAuth.
 *      ZAPIER_RECRUITING_MCP_URL   — the dedicated server's MCP URL
 *      ZAPIER_RECRUITING_MCP_TOKEN — optional Bearer if the URL is not self-authing
 *      ZAPIER_VIDEOASK_GET_TOOL    — tool name (default videoask_make_api_get_request)
 *    ⚠️ This is NOT the shared agent Zapier server — Gmail stays OFF that one (D11).
 *  - State: ffl-crm AI Workforce Hub /api/v1/agent/state (the established
 *    pattern; retires the interim Google Drive RECRUITING-STATE.md).
 *      FFL_WORKFORCE_API_KEY — ffl_live_ key with agent:read + agent:write
 *
 * SAFETY MODEL of send_recruiting_invite (Mo chose server-enforced, 2026-08-17):
 *  - Role → VideoAsk link map is HARD-CODED here; the agent can never send an
 *    arbitrary link or an off-template body. Out-of-scope roles (Maintenance/
 *    VLS/EA/Turn Around) are refused outright before alias matching.
 *  - Dedup is ENFORCED in the tool: Gmail `in:sent to:<email>` AND the
 *    all-forms VideoAsk contact index searched by LAST NAME (Golden Rule 1 —
 *    name, not email; the Rocky Garza case). A match refuses the send and
 *    returns the evidence.
 *  - Denylist (Joel Sandoval), per-day send cap (RECRUITING_SEND_CAP, default
 *    15), and a per-day sent log in workforce state give idempotency across
 *    retries: the same address can never be emailed twice in a day.
 *  - The TestGorilla batch is a DIFFERENT task and is not reachable from here.
 */

import { createSign, createHash } from "node:crypto";

// ───────────────────────── config ─────────────────────────

const GMAIL_DEFAULT_IMPERSONATE = "mo@flatfeelandlord.com";
const VIDEOASK_API_BASE = "https://api.videoask.com";
const VIDEOASK_ORG_ID_DEFAULT = "94dc21de-9c4d-4abc-a933-d8324bd853e3";
/** "Virtual PM Flat Fee Landlord" form, Screening question 2 (verified 2026-08-17). */
const VIDEOASK_DEFAULT_QUESTION_ID = "0d0ab5f1-fa6c-46af-849f-2081f65d9af3";

const AGENT_STATE_KEY = "recruiting-sweep";
const DEFAULT_SEND_CAP = 15;
const WATCHDOG_CAP_PER_DAY = 3;
const MAX_VIDEOASK_PAGES = 20;
const MAX_GMAIL_MESSAGES_PER_CHANNEL = 40;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function crmBaseUrl(): string {
  return env("VESTLAUNCH_BASE_URL").replace(/\/+$/, "") || "https://crm.vestlaunch.com";
}

function workforceKey(): string {
  return env("FFL_WORKFORCE_API_KEY") || env("VESTLAUNCH_API_KEY");
}

function chicagoDateStamp(d: Date = new Date()): string {
  // YYYY-MM-DD in America/Chicago — used for per-day send caps/logs.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts; // en-CA gives YYYY-MM-DD
}

// ───────────────────────── role → link map (HARD-CODED, per SOP) ─────────────────────────

interface RoleDef {
  /** Canonical display name used in the email subject/body. */
  display: string;
  /** VideoAsk short link. */
  link: string;
}

const ROLE_LINKS: Record<string, RoleDef> = {
  regional_manager: { display: "Regional Manager", link: "https://www.videoask.com/fznbqb2mp" },
  community_manager: { display: "Community Manager", link: "https://www.videoask.com/fznbqb2mp" },
  assistant_community_manager: {
    display: "Assistant Community Manager",
    link: "https://www.videoask.com/fu546koux",
  },
  leasing_agent: { display: "Leasing Agent", link: "https://www.videoask.com/fc0yi5g9k" },
  bd_sales_manager: {
    display: "Sales Manager",
    link: "https://www.videoask.com/fhzg3ayze",
  },
  // ── Added 2026-08-18 — Mo's ruling: "I'd ideally want all roles invited."
  //    Supersedes the 2026-08-17 out-of-scope list. Links read live from the
  //    VideoAsk org (share dialogs, app.videoask.com) on 2026-08-18.
  executive_assistant: {
    display: "Executive Assistant",
    link: "https://www.videoask.com/fiq0psnh2", // "Flat Fee Landlord Executive Assistant"
  },
  virtual_sales: {
    display: "Virtual Sales Representative",
    link: "https://www.videoask.com/f4gfnq3ly", // "Sales Representative Virtual"
  },
  virtual_pm: {
    display: "Virtual Property Manager",
    link: "https://www.videoask.com/f4k09mehb", // "Virtual PM Flat Fee Landlord"
  },
  // No dedicated questionnaire exists for these two — Mo ruled (2026-08-18)
  // both get the Virtual PM questionnaire. The invite email still names the
  // role the candidate actually applied for; only the link is shared.
  virtual_leasing_specialist: {
    display: "Virtual Leasing Specialist",
    link: "https://www.videoask.com/f4k09mehb",
  },
  maintenance_coordinator: {
    display: "Maintenance Coordinator",
    link: "https://www.videoask.com/f4k09mehb",
  },
};

/** Loose aliases → canonical role key. */
function normalizeRole(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  // ── Mo's REMOTE rule (2026-08-18 PM, prepping for reposted jobs with new
  //    titles): any title containing remote/virtual/work-from-home maps to the
  //    Virtual PM questionnaire — UNLESS it is a sales role, which keeps the
  //    Virtual Sales Representative questionnaire (Mo's explicit exception).
  //    Maintenance/leasing keep their own keys (same link as virtual_pm, but
  //    the invite email then names the right role).
  const isRemote = /remote|work from home|(^|\s)wfh(\s|$)|virtual/.test(s);
  if (isRemote) {
    if (/sales|business development|(^|\s)bdm?(\s|$)|account executive/.test(s)) return "virtual_sales";
    if (/maintenance/.test(s)) return "maintenance_coordinator";
    if (/leasing/.test(s)) return "virtual_leasing_specialist";
    return "virtual_pm";
  }
  // ── 2026-08-18 roles FIRST — order is load-bearing. Each of these would
  //    otherwise mis-alias into an older pattern below: "virtual leasing" into
  //    leasing_agent, "virtual sales" into bd_sales_manager, and "virtual
  //    property manager" into community_manager via /property manager/.
  if (/maintenance/.test(s)) return "maintenance_coordinator";
  if (/executive assistant|(^|\s)ea(\s|$)/.test(s)) return "executive_assistant";
  if (/virtual leasing|(^|\s)vls(\s|$)/.test(s)) return "virtual_leasing_specialist";
  if (/virtual sales|sales representative|(^|\s)vse(\s|$)/.test(s)) return "virtual_sales";
  if (/virtual pm|virtual property|(^|\s)vpm(\s|$)/.test(s)) return "virtual_pm";
  if (/regional/.test(s)) return "regional_manager";
  if (/assistant.*(community|director|manager)|(^|\s)acm(\s|$)|(^|\s)acd(\s|$)/.test(s))
    return "assistant_community_manager";
  if (/community manager|apartment manager|property manager|(^|\s)cm(\s|$)/.test(s))
    return "community_manager";
  if (/leasing/.test(s)) return "leasing_agent";
  if (/sales|business development|(^|\s)bd(\s|$)|bdm/.test(s)) return "bd_sales_manager";
  return null;
}

/** People we never contact (Mo's standing instruction). Matched on full name, case-insensitive. */
const DENYLIST_NAMES = ["joel sandoval"];

// ───────────────────────── Gmail (direct API) ─────────────────────────

interface GoogleSaKey {
  client_email: string;
  private_key: string;
}

/** Access tokens cached per mailbox (2026-08-18: hazelequity joined the cloud sweep). */
const cachedGoogleTokens = new Map<string, { token: string; expiresAt: number }>();

function loadSaKey(): GoogleSaKey {
  const raw = env("GOOGLE_SA_KEY_JSON");
  if (!raw) {
    throw new Error(
      "Gmail is not configured: set GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET + " +
        "GMAIL_REFRESH_TOKEN (house pattern, preferred) or GOOGLE_SA_KEY_JSON in the Vercel env.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SA_KEY_JSON is not valid JSON.");
  }
  const key = parsed as Partial<GoogleSaKey>;
  if (!key.client_email || !key.private_key) {
    throw new Error("GOOGLE_SA_KEY_JSON is missing client_email/private_key.");
  }
  return key as GoogleSaKey;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function gmailImpersonatedUser(): string {
  return env("GMAIL_IMPERSONATE") || GMAIL_DEFAULT_IMPERSONATE;
}

/** The hazelequity mailbox (channel 2). Sweepable from the cloud once Mo mints
 *  a refresh token for it (GMAIL_HAZEL_REFRESH_TOKEN, same OAuth client). */
export function hazelMailbox(): string {
  return (env("GMAIL_HAZEL_MAILBOX") || "mo@hazelequity.com").toLowerCase();
}

/**
 * OAuth refresh-token grant — the HOUSE Gmail pattern (ffl-crm lib/gmail.ts
 * does exactly this). Used because the flatfeelandlord.com org enforces
 * iam.disableServiceAccountKeyCreation (discovered live 2026-08-17), so a
 * downloadable service-account key cannot exist. The refresh token is minted
 * once by Mo consenting as mo@flatfeelandlord.com; internal-app refresh
 * tokens do not expire. gmailVerifiedMailbox() still guards that the token
 * really belongs to the expected mailbox.
 */
async function refreshGrantToken(clientId: string, clientSecret: string, refreshToken: string): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail OAuth refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Gmail OAuth refresh returned no access_token.");
  return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

async function googleAccessToken(mailbox?: string): Promise<string> {
  const box = (mailbox ?? gmailImpersonatedUser()).toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  const cached = cachedGoogleTokens.get(box);
  if (cached && cached.expiresAt - 60 > now) return cached.token;

  // Preferred path: OAuth refresh token (house pattern). One refresh token PER
  // MAILBOX, and each refresh token is bound to the OAuth CLIENT that minted it:
  //  - mo@flatfeelandlord.com → GMAIL_OAUTH_CLIENT_ID/SECRET (FFL org project)
  //  - mo@hazelequity.com     → GMAIL_HAZEL_CLIENT_ID/SECRET (hazel org project
  //    "hazel-recruiting-sweep" — the FFL consent app is Internal-audience, so
  //    the hazel account got its own client, 2026-08-18). Falls back to the FFL
  //    client vars only if the hazel-specific ones are unset.
  const isHazel = box === hazelMailbox();
  const clientId = isHazel
    ? env("GMAIL_HAZEL_CLIENT_ID") || env("GMAIL_OAUTH_CLIENT_ID")
    : env("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = isHazel
    ? env("GMAIL_HAZEL_CLIENT_SECRET") || env("GMAIL_OAUTH_CLIENT_SECRET")
    : env("GMAIL_OAUTH_CLIENT_SECRET");
  const refreshToken = isHazel ? env("GMAIL_HAZEL_REFRESH_TOKEN") : env("GMAIL_REFRESH_TOKEN");
  if (clientId && clientSecret && refreshToken) {
    const { token, expiresIn } = await refreshGrantToken(clientId, clientSecret, refreshToken);
    cachedGoogleTokens.set(box, { token, expiresAt: now + expiresIn });
    return token;
  }
  if (isHazel) {
    throw new Error(
      `Gmail for ${box} is not configured: set GMAIL_HAZEL_CLIENT_ID, GMAIL_HAZEL_CLIENT_SECRET ` +
        "and GMAIL_HAZEL_REFRESH_TOKEN (minted via OAuth Playground with the hazel-org client, " +
        "consenting as that account).",
    );
  }
  if (clientId || clientSecret || refreshToken) {
    throw new Error(
      "Gmail OAuth is partially configured — GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET " +
        "and GMAIL_REFRESH_TOKEN must all be set.",
    );
  }

  // Fallback: service-account JWT with domain-wide delegation (kept for a
  // future keyless/WIF migration; unusable today — org policy blocks SA keys).
  const key = loadSaKey();
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ].join(" ");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: gmailImpersonatedUser(), // domain-wide delegation: act as Mo's mailbox
      scope: scopes,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key).toString("base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Google token exchange returned no access_token.");
  cachedGoogleTokens.set(box, { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) });
  return body.access_token;
}

async function gmailFetch<T = unknown>(path: string, init?: RequestInit, mailbox?: string): Promise<T> {
  const token = await googleAccessToken(mailbox);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Verify WHICH mailbox we are actually reading before trusting any result.
 * SOP hard rule: "an empty result is never proof of 'nothing new' until you
 * have confirmed which inbox answered."
 */
export async function gmailVerifiedMailbox(expectedMailbox?: string): Promise<string> {
  const expected = (expectedMailbox ?? gmailImpersonatedUser()).toLowerCase();
  const profile = await gmailFetch<{ emailAddress?: string }>("/profile", undefined, expected);
  const addr = (profile.emailAddress ?? "").toLowerCase();
  if (addr !== expected) {
    throw new Error(`Gmail mailbox mismatch: expected ${expected}, API answered as "${addr}".`);
  }
  return addr;
}

interface GmailMessageMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string; // ISO
  snippet: string;
  bodyText: string;
}

function headerVal(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodePart(data?: string): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function extractBodyText(payload: Record<string, unknown> | undefined): string {
  if (!payload) return "";
  const mime = String(payload.mimeType ?? "");
  const body = payload.body as { data?: string } | undefined;
  if (mime.startsWith("text/plain") && body?.data) return decodePart(body.data);
  if (mime.startsWith("text/html") && body?.data) {
    return decodePart(body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  }
  const parts = (payload.parts as Array<Record<string, unknown>> | undefined) ?? [];
  // Prefer text/plain parts, fall back to html.
  for (const p of parts) {
    if (String(p.mimeType ?? "").startsWith("text/plain")) {
      const t = extractBodyText(p);
      if (t) return t;
    }
  }
  for (const p of parts) {
    const t = extractBodyText(p);
    if (t) return t;
  }
  return "";
}

async function gmailSearchMessages(
  q: string,
  cap = MAX_GMAIL_MESSAGES_PER_CHANNEL,
  mailbox?: string,
): Promise<GmailMessageMeta[]> {
  const list = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/messages?q=${encodeURIComponent(q)}&maxResults=${cap}`,
    undefined,
    mailbox,
  );
  const out: GmailMessageMeta[] = [];
  for (const m of (list.messages ?? []).slice(0, cap)) {
    const full = await gmailFetch<Record<string, unknown>>(`/messages/${m.id}?format=full`, undefined, mailbox);
    const payload = full.payload as Record<string, unknown> | undefined;
    const headers = (payload?.headers as Array<{ name?: string; value?: string }>) ?? [];
    const internalDate = Number(full.internalDate ?? 0);
    out.push({
      id: m.id,
      threadId: m.threadId,
      from: headerVal(headers, "From"),
      to: headerVal(headers, "To"),
      subject: headerVal(headers, "Subject"),
      receivedAt: internalDate ? new Date(internalDate).toISOString() : "",
      snippet: String(full.snippet ?? ""),
      bodyText: extractBodyText(payload).slice(0, 4000),
    });
  }
  return out;
}

/** RFC 2047-encode a header value when it contains non-ASCII (found live
 *  2026-08-18: the invite subject's en-dash rendered as "Ã¢Â€Â“" without this). */
function encodeHeaderWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

async function gmailSendMessage(to: string, subject: string, body: string): Promise<string> {
  const from = gmailImpersonatedUser();
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ].join("\r\n");
  const res = await gmailFetch<{ id?: string }>("/messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  if (!res.id) throw new Error("Gmail send returned no message id.");
  return res.id;
}

// ───────────────────────── VideoAsk (via dedicated Zapier MCP, raw GET) ─────────────────────────

/**
 * Minimal stateless MCP client for the dedicated recruiting Zapier server.
 * We deliberately do NOT use the shared agent Zapier server here (D11).
 */
async function zapierToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
  const url = env("ZAPIER_RECRUITING_MCP_URL");
  if (!url) {
    throw new Error(
      "VideoAsk is not configured: set ZAPIER_RECRUITING_MCP_URL (the dedicated recruiting " +
        "Zapier MCP server URL) in the Vercel env.",
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const bearer = env("ZAPIER_RECRUITING_MCP_TOKEN");
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zapier MCP HTTP ${res.status}: ${text.slice(0, 300)}`);

  // Response may be plain JSON or an SSE stream of `data:` lines.
  let payload = text.trim();
  if (payload.startsWith("event:") || payload.includes("\ndata:") || payload.startsWith("data:")) {
    const dataLines = payload
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    payload = dataLines[dataLines.length - 1] ?? "";
  }
  let rpc: Record<string, unknown>;
  try {
    rpc = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error(`Zapier MCP returned unparseable payload: ${payload.slice(0, 200)}`);
  }
  if (rpc.error) throw new Error(`Zapier MCP error: ${JSON.stringify(rpc.error).slice(0, 300)}`);
  const result = rpc.result as
    | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    | undefined;
  const textOut = result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (result?.isError) throw new Error(`Zapier tool ${toolName} errored: ${textOut.slice(0, 300)}`);
  return textOut;
}

/**
 * Peel Zapier's wrapping until we reach the raw VideoAsk JSON response.
 * VERIFIED envelope (live capture 2026-08-18):
 *   {"results":[{"status":200,"headers":{...},"body":{ <VideoAsk JSON> }}]}
 * and on failure: {"isError":true,"error":"... status code 404","billingTasksUsed":0}
 * The results[0] unwrap fires ONLY when the element looks like that HTTP
 * envelope (has status+body) — VideoAsk's own payload ALSO uses a `results`
 * key ({next, previous, results:[records]}), and a page with exactly one
 * record must never be mistaken for a wrapper.
 */
function unpeelZapierJson(text: string): unknown {
  let v: unknown = text;
  for (let i = 0; i < 5; i++) {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s.startsWith("{") && !s.startsWith("[")) return v;
      try {
        v = JSON.parse(s);
        continue;
      } catch {
        return v;
      }
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.results) && o.results.length >= 1) {
        const first = o.results[0] as Record<string, unknown> | undefined;
        if (first && typeof first === "object" && "status" in first && "body" in first) {
          v = first;
          continue;
        }
      }
      if (o.response !== undefined) {
        v = o.response;
        continue;
      }
      if (o.body !== undefined && o.contents === undefined && !Array.isArray(o.results)) {
        v = o.body;
        continue;
      }
    }
    return v;
  }
  return v;
}

async function videoaskGet(pathAndQuery: string): Promise<Record<string, unknown>> {
  const toolName = env("ZAPIER_VIDEOASK_GET_TOOL") || "videoask_make_api_get_request";
  const url = pathAndQuery.startsWith("http") ? pathAndQuery : `${VIDEOASK_API_BASE}${pathAndQuery}`;
  const out = await zapierToolCall(toolName, { url });
  const parsed = unpeelZapierJson(out);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`VideoAsk GET ${pathAndQuery} returned non-object: ${String(out).slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  // An upstream error must THROW, never read as "no results" — a 404 that
  // looks like an empty list is the silent-failure mode this sweep exists to
  // kill (and callers like the send tool fail CLOSED on a throw).
  if (obj.isError === true || (typeof obj.error === "string" && obj.error)) {
    throw new Error(`VideoAsk GET ${pathAndQuery} failed upstream: ${String(obj.error).slice(0, 200)}`);
  }
  const status = typeof obj.status === "number" ? obj.status : undefined;
  if (status !== undefined && (status < 200 || status >= 300)) {
    throw new Error(`VideoAsk GET ${pathAndQuery} → HTTP ${status}`);
  }
  return obj;
}

export interface Completer {
  name: string;
  email: string;
  completed_at: string;
}

/**
 * get_videoask_completers — pages the answers endpoint newest-first and STRIPS
 * each ~5k-token record down to {name, email, completed_at} server-side.
 * (Payload key verified live 2026-08-18: {next, previous, results:[records]}.)
 */
export async function getVideoaskCompleters(
  questionId: string | undefined,
  sinceIso: string,
): Promise<{ completers: Completer[]; pages_fetched: number; truncated: boolean }> {
  const qid = (questionId ?? "").trim() || VIDEOASK_DEFAULT_QUESTION_ID;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) throw new Error(`since_iso is not a valid date: ${sinceIso}`);

  const completers: Completer[] = [];
  let offset = 0;
  let pages = 0;
  let truncated = false;

  while (pages < MAX_VIDEOASK_PAGES) {
    const page = await videoaskGet(`/questions/${qid}/answers?limit=25&offset=${offset}`);
    pages += 1;
    const contents = (page.results ?? page.contents ?? page.answers ?? []) as Array<
      Record<string, unknown>
    >;
    if (!Array.isArray(contents) || contents.length === 0) break;

    let reachedOlder = false;
    for (const rec of contents) {
      const createdAt = String(rec.created_at ?? rec.createdAt ?? "");
      const t = Date.parse(createdAt);
      if (!Number.isNaN(t) && t < since) {
        reachedOlder = true;
        break; // newest-first: everything after this is older
      }
      completers.push({
        name: String(rec.contact_name ?? rec.name ?? "").trim(),
        email: String(rec.contact_email ?? rec.email ?? "").trim().toLowerCase(),
        completed_at: createdAt,
      });
    }
    if (reachedOlder) break;

    const next = page.next;
    if (!next) break;
    offset += 25;
  }
  if (pages >= MAX_VIDEOASK_PAGES) truncated = true;
  return { completers, pages_fetched: pages, truncated };
}

export interface ContactHit {
  name: string;
  email: string;
  created_at: string;
  form?: string;
}

/**
 * VideoAsk contact index — the dedup source of truth.
 *
 * VERIFIED LIVE 2026-08-18: there is NO org-wide contacts-search endpoint in
 * the API (all candidate paths 404), and on /forms/{id}/contacts the `search`,
 * `q` and `name` params are silently IGNORED (same trap as `fields` on
 * answers). Only `?email=` filters server-side — and email-only dedup is
 * exactly what Golden Rule 1 forbids (the Rocky Garza case).
 *
 * So the tool builds its own index: page the contacts of EVERY form in the
 * org (14 forms — broader than the manual UI check or the old single-form CSV
 * export ever was), keep only {name, email, created_at, form}, and cache it in
 * Workforce state. Rebuilt automatically when older than 12h, so the morning
 * run always searches an index minutes old. The index key is HIDDEN from
 * get_recruiting_state (thousands of rows must never enter the agent's
 * context) and reserved against update_recruiting_state.
 */
const CONTACT_INDEX_KEY = "videoask_contact_index";
const CONTACT_INDEX_MAX_AGE_MS = 12 * 3600 * 1000;
const CONTACT_PAGE_LIMIT = 100;
const MAX_CONTACT_PAGES_PER_FORM = 40;

interface ContactIndex {
  updated_at: string;
  total: number;
  forms: number;
  contacts: Array<{ n: string; e: string; c: string; f: string }>;
}

async function listVideoaskForms(): Promise<Array<{ form_id: string; title: string }>> {
  const page = await videoaskGet(`/forms?limit=100`);
  const forms = (page.results ?? page.contents ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(forms) || forms.length === 0) {
    throw new Error("VideoAsk /forms returned no forms — refusing to build an empty dedup index.");
  }
  return forms.map((f) => ({
    form_id: String(f.form_id ?? f.id ?? ""),
    title: String(f.title ?? "").trim(),
  })).filter((f) => f.form_id);
}

async function fetchFormContacts(form: { form_id: string; title: string }): Promise<ContactIndex["contacts"]> {
  const out: ContactIndex["contacts"] = [];
  for (let pageNo = 0; pageNo < MAX_CONTACT_PAGES_PER_FORM; pageNo++) {
    const page = await videoaskGet(
      `/forms/${form.form_id}/contacts?limit=${CONTACT_PAGE_LIMIT}&offset=${pageNo * CONTACT_PAGE_LIMIT}`,
    );
    const recs = (page.results ?? page.contents ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(recs) || recs.length === 0) break;
    for (const r of recs) {
      out.push({
        n: String(r.name ?? r.contact_name ?? "").trim().toLowerCase(),
        e: String(r.email ?? r.contact_email ?? "").trim().toLowerCase(),
        c: String(r.created_at ?? ""),
        f: form.title,
      });
    }
    if (recs.length < CONTACT_PAGE_LIMIT || !page.next) break;
  }
  return out;
}

async function getContactIndex(): Promise<ContactIndex> {
  const cached = (await readStateKey(CONTACT_INDEX_KEY)) as ContactIndex | undefined;
  if (
    cached &&
    Array.isArray(cached.contacts) &&
    cached.contacts.length > 0 &&
    Date.now() - Date.parse(cached.updated_at ?? "") < CONTACT_INDEX_MAX_AGE_MS
  ) {
    return cached;
  }
  const forms = await listVideoaskForms();
  // Parallel across forms; pages within a form are sequential.
  const perForm = await Promise.all(forms.map((f) => fetchFormContacts(f)));
  const contacts = perForm.flat();
  if (contacts.length === 0) {
    throw new Error("VideoAsk contact-index rebuild returned 0 contacts — refusing to dedup against nothing.");
  }
  const index: ContactIndex = {
    updated_at: new Date().toISOString(),
    total: contacts.length,
    forms: forms.length,
    contacts,
  };
  await writeStateKey(CONTACT_INDEX_KEY, index);
  return index;
}

/**
 * search_videoask_contacts — name/email dedup against the all-forms contact
 * index (Golden Rule 1: dedup by NAME, not email — the Rocky Garza case).
 */
export async function searchVideoaskContacts(query: string): Promise<{
  hits: ContactHit[];
  index_updated_at: string;
  index_total: number;
  index_forms: number;
}> {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error("query is required (usually the candidate's last name).");
  const index = await getContactIndex();
  const hits = index.contacts
    .filter((c) => c.n.includes(q) || c.e.includes(q))
    .slice(0, 50)
    .map((c) => ({ name: c.n, email: c.e, created_at: c.c, form: c.f }));
  return {
    hits,
    index_updated_at: index.updated_at,
    index_total: index.total,
    index_forms: index.forms,
  };
}

// ───────────────────────── get_new_applicants ─────────────────────────

export interface Applicant {
  name: string;
  email: string;
  phone?: string;
  role: string;
  role_key: string | null;
  in_scope: boolean;
  source: string;
  received_at: string;
  message_id: string;
  note?: string;
}

export interface TrueAnalysisHit {
  from: string;
  subject: string;
  snippet: string;
  received_at: string;
  message_id: string;
}

function gmailAfterClause(sinceIso: string): string {
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) throw new Error(`since_iso is not a valid date: ${sinceIso}`);
  return `after:${Math.floor(t / 1000)}`;
}

function pickField(body: string, labels: string[]): string {
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n\\r]+)`, "i");
    const m = body.match(re);
    if (m?.[1]) return m[1].trim().replace(/\s{2,}.*$/, "").trim();
  }
  return "";
}

function extractEmail(text: string): string {
  const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return (m?.[0] ?? "").toLowerCase();
}

// 2026-08-18: the blanket OUT_OF_SCOPE refusal (Maintenance/VLS/EA/Turn Around,
// Mo's 2026-08-17 list) is RETIRED — Mo ruled "I'd ideally want all roles
// invited." Every role that maps in ROLE_LINKS is now invitable; roles the
// server cannot map still fail CLOSED (role_key null → the send tool refuses
// and the agent reports them by name instead of guessing a link).
function classifyRole(rawRole: string): { role_key: string | null; in_scope: boolean } {
  const key = normalizeRole(rawRole);
  return { role_key: key, in_scope: key !== null };
}

export async function getNewApplicants(
  channel: string,
  sinceIso: string,
): Promise<Record<string, unknown>> {
  const ch = channel.trim().toLowerCase();

  if (ch === "hazelequity") {
    // 2026-08-18: sweepable from the cloud once GMAIL_HAZEL_REFRESH_TOKEN is
    // set (house OAuth pattern, second refresh token on the same client).
    // Until then it stays honestly UNSWEPT — never "zero applicants".
    if (!env("GMAIL_HAZEL_REFRESH_TOKEN")) {
      return {
        channel: ch,
        swept: false,
        reason:
          `${hazelMailbox()} is not yet reachable from the cloud half — GMAIL_HAZEL_REFRESH_TOKEN ` +
          "is not set. Report it as UNSWEPT, not as zero applicants.",
      };
    }
    const hazelBox = await gmailVerifiedMailbox(hazelMailbox());
    const hazelAfter = gmailAfterClause(sinceIso);
    // Broad catch-all like true_analysis — this inbox has no structured
    // applicant notifications, so return hits for the agent to judge.
    const q = `in:inbox ${hazelAfter} (subject:Fwd OR subject:FW OR resume OR applicant OR application OR applying OR candidate OR hiring OR career)`;
    const msgs = await gmailSearchMessages(q, 50, hazelBox);
    const hits: TrueAnalysisHit[] = msgs.map((m) => ({
      from: m.from,
      subject: m.subject,
      snippet: m.snippet.slice(0, 300),
      received_at: m.receivedAt,
      message_id: m.id,
    }));
    return {
      channel: ch,
      swept: true,
      mailbox_verified: hazelBox,
      hits,
      total: hits.length,
      note:
        "hazelequity catch-all sweep — judge every hit; this inbox has historically produced " +
        "zero applicants, so an empty list is plausible (and now trustworthy: mailbox verified).",
    };
  }

  const mailbox = await gmailVerifiedMailbox();
  const after = gmailAfterClause(sinceIso);

  if (ch === "website") {
    const msgs = await gmailSearchMessages(
      `from:noreply@flatfeelandlord.com subject:"Careers Application" ${after}`,
    );
    const applicants: Applicant[] = msgs.map((m) => {
      const body = m.bodyText || m.snippet;
      const roleRaw = pickField(body, ["Role", "Position", "Job"]) || m.subject.replace(/careers application[:\s-]*/i, "");
      const cls = classifyRole(roleRaw);
      return {
        name: pickField(body, ["Name", "Full Name"]),
        email: extractEmail(body),
        phone: pickField(body, ["Phone", "Phone Number"]),
        role: roleRaw.trim(),
        role_key: cls.role_key,
        in_scope: cls.in_scope,
        source: "website",
        received_at: m.receivedAt,
        message_id: m.id,
      };
    });
    return { channel: ch, swept: true, mailbox_verified: mailbox, applicants, total: applicants.length };
  }

  if (ch === "wix") {
    // Both subject variants seen in the SOP/logs.
    const q = `(subject:"Contact Form got a new submission" OR subject:"Contact got a new submission") ${after}`;
    const msgs = await gmailSearchMessages(q);
    const applicants: Applicant[] = msgs.map((m) => {
      const body = m.bodyText || m.snippet;
      const roleRaw = pickField(body, ["Role", "Position", "Subject", "Message"]);
      const cls = classifyRole(roleRaw);
      return {
        name: pickField(body, ["Name", "First name", "Full Name"]),
        email: extractEmail(body),
        phone: pickField(body, ["Phone"]),
        role: roleRaw.trim(),
        role_key: cls.role_key,
        in_scope: cls.in_scope,
        source: "wix_form",
        received_at: m.receivedAt,
        message_id: m.id,
        note:
          "Wix contact-form hits are often NOT applicants (e.g. property-owner sales leads). " +
          "Judge from the parsed fields before inviting.",
      };
    });
    return { channel: ch, swept: true, mailbox_verified: mailbox, applicants, total: applicants.length };
  }

  if (ch === "wizehire") {
    // HARD-MINIMUM 30-day window (a 3-4 day window missed David Swatts on
    // 2026-08-17) — we widen the caller's since if it is narrower.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
    const since = Math.min(Date.parse(sinceIso), thirtyDaysAgo);
    const msgs = await gmailSearchMessages(`from:team@wizehire.com after:${Math.floor(since / 1000)}`);
    const applicants: Applicant[] = [];
    const skipped: Array<Record<string, string>> = [];
    for (const m of msgs) {
      const body = m.bodyText || m.snippet;
      // "{Name} has started an application for {Role} in {Location}"
      const match = body.match(/(.+?)\s+has started an application for\s+(.+?)\s+in\s+/i);
      const name = match?.[1]?.trim() ?? "";
      const roleRaw = match?.[2]?.trim() ?? m.subject.replace(/\s*Completed\s*$/i, "").trim();
      // (2026-08-18: the Executive Assistant skip is gone — EA applicants are
      // now invited to the Flat Fee Landlord Executive Assistant questionnaire.)
      if (!name && !extractEmail(body)) {
        skipped.push({ subject: m.subject, reason: "not an applicant notification (marketing/other)" });
        continue;
      }
      // "Assistant Community Director" = our ACM role.
      const cls = classifyRole(roleRaw);
      applicants.push({
        name,
        email: extractEmail(body),
        phone: pickField(body, ["Phone"]),
        role: roleRaw,
        role_key: cls.role_key,
        in_scope: cls.in_scope,
        source: "wizehire",
        received_at: m.receivedAt,
        message_id: m.id,
        note:
          "Wizehire notifications carry no résumé; self-selection into the posting is the " +
          "relevance proxy (per SOP Step 5).",
      });
    }
    return {
      channel: ch,
      swept: true,
      mailbox_verified: mailbox,
      window_used: new Date(since).toISOString(),
      applicants,
      skipped,
      total: applicants.length,
    };
  }

  if (ch === "indeed") {
    // 2026-08-18 (Mo): Indeed moved to the cloud half. Individual application
    // notifications arrive from conversation-…@indeedemail.com carrying the
    // candidate's RELAY address (a valid invite target). We deliberately do NOT
    // parse the layout (Indeed changes it) — return the full body and let the
    // agent extract name / email / role.
    //
    // 2026-08-20 (Lando — verified live against the employer dashboard and 7
    // days of mail): Indeed does NOT send one email per application. Above a
    // low daily volume it BUNDLES a posting's applications into ONE grouped
    // email (from=grouped-application-email-bundled, "<Name> and N others
    // applied") that names only the first 3 applicants and carries NO candidate
    // email addresses. Measured: 5 individual notifications in 7 days against
    // ~150 real applications, spread across 4 different postings. The posting's
    // "Individual email each time someone applies" setting was already ON for
    // every posting checked, so flipping it changes nothing.
    //
    // The digest-vs-hits "UNCONFIGURED posting" inference that used to live here
    // has been REMOVED: it fired on every high-volume posting, always falsely,
    // and on 2026-08-20 it sent a human into Indeed to enable a setting that was
    // already enabled.
    //
    // Nobody is missed. Each posting carries its own Indeed "Message new
    // candidates" automation (verified On, correct per-role VideoAsk link) which
    // messages 100% of applicants natively, within hours of applying. This
    // channel is therefore a best-effort CRM feed, NOT the invite path for
    // Indeed.
    const q = `(from:indeedemail.com OR from:indeed.com) ${after} -subject:debrief`;
    const msgs = await gmailSearchMessages(q, 50);
    const junk = /debrief|digest|newsletter|billing|receipt|sponsor your job|performance report|invite candidates to apply/i;
    const hits = msgs
      .filter((m) => !junk.test(m.subject))
      .map((m) => ({
        from: m.from,
        subject: m.subject,
        body: (m.bodyText || m.snippet).slice(0, 4000),
        received_at: m.receivedAt,
        message_id: m.id,
      }));
    // Digests are still returned, but ONLY as volume context for the report —
    // never as a configuration signal. See the note below.
    const digestMsgs = await gmailSearchMessages(
      `from:no-reply@indeed.com subject:debrief ${after}`,
      10,
    );
    const digests = digestMsgs.map((m) => ({
      subject: m.subject,
      body: (m.bodyText || m.snippet).slice(0, 4000),
      received_at: m.receivedAt,
    }));
    return {
      channel: ch,
      swept: true,
      mailbox_verified: mailbox,
      hits,
      digests,
      total: hits.length,
      note:
        "hits = Indeed application notifications (full body). Extract candidate name, email (relay " +
        "…@indeedemail.com addresses are valid), and role, then send_recruiting_invite — ALL roles, " +
        "per Mo's 2026-08-18 ruling. A hit with no extractable candidate email = SKIP it quietly: " +
        "Indeed's bundled emails never carry candidate addresses, and those applicants have already " +
        "been invited natively by the posting's own Indeed 'Message new candidates' automation. " +
        "digests = daily debrief summaries, VOLUME CONTEXT ONLY. Do NOT compare digest job titles " +
        "against hit titles, and NEVER raise a Needs-you item about per-application email settings " +
        "or an 'unconfigured posting' — missing individual emails is Indeed's normal bundling " +
        "behaviour at volume (verified 2026-08-20), not a misconfiguration, and the setting is " +
        "already on for every posting. If Indeed is worth a line in the report at all, report the " +
        "honest shape: '<n> individual notifications visible; the rest of the day's applications " +
        "arrived bundled and were invited natively by Indeed.'",
    };
  }

  if (ch === "true_analysis") {
    const q = `in:inbox ${after} (subject:Fwd OR subject:FW OR resume OR applicant OR application OR applying OR candidate OR hiring)`;
    const msgs = await gmailSearchMessages(q, 50);
    const hits: TrueAnalysisHit[] = msgs.map((m) => ({
      from: m.from,
      subject: m.subject,
      snippet: m.snippet.slice(0, 300),
      received_at: m.receivedAt,
      message_id: m.id,
    }));
    return {
      channel: ch,
      swept: true,
      mailbox_verified: mailbox,
      hits,
      total: hits.length,
      note:
        "Catch-all sweep — expect heavy noise. Eyeball every hit for forwarded applicants and " +
        "uncovered channels (SOP true-analysis pass). Any LinkedIn 'new application' notification " +
        "for a job not in the SOP = an uncovered job; flag it for Mo.",
    };
  }

  throw new Error(
    `Unknown channel "${channel}". Valid: website, wix, wizehire, indeed, true_analysis, hazelequity.`,
  );
}

// ───────────────────────── workforce state (ffl-crm) ─────────────────────────

async function crmStateRequest(
  method: "GET" | "POST" | "DELETE",
  query?: Record<string, string>,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const key = workforceKey();
  if (!key) {
    throw new Error("State is not configured: set FFL_WORKFORCE_API_KEY (agent:read + agent:write) in Vercel env.");
  }
  const url = new URL(`${crmBaseUrl()}/api/v1/agent/state`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `Workforce state ${method} → HTTP ${res.status}: ${String(json.error ?? text).slice(0, 300)}`,
    );
  }
  return json;
}

export async function getRecruitingState(): Promise<Record<string, unknown>> {
  const res = await crmStateRequest("GET", { agentKey: AGENT_STATE_KEY });
  const rows = (res.data ?? []) as Array<{ key?: string; value?: unknown; updatedAt?: string }>;
  const state: Record<string, unknown> = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!r?.key) continue;
      // The contact index is thousands of rows — summarize it, never inline it
      // into the agent's context.
      if (r.key === CONTACT_INDEX_KEY) {
        const idx = r.value as ContactIndex | undefined;
        state[r.key] = idx
          ? { updated_at: idx.updated_at, total: idx.total, forms: idx.forms, note: "dedup index (hidden; used internally by send/search tools)" }
          : undefined;
        continue;
      }
      state[r.key] = r.value;
    }
  }
  return { agentKey: AGENT_STATE_KEY, state };
}

export async function updateRecruitingState(key: string, value: unknown): Promise<Record<string, unknown>> {
  const k = key.trim();
  if (!k) throw new Error("key is required.");
  if (/^(sent_|watchdog_sent_|testgorilla_sent_|videoask_reminder_sent_|videoask_contact_index)/.test(k)) {
    throw new Error(`key "${k}" is reserved for the tools' internal logs/index.`);
  }
  await crmStateRequest("POST", undefined, { agentKey: AGENT_STATE_KEY, key: k, value });
  return { saved: true, agentKey: AGENT_STATE_KEY, key: k };
}

async function readStateKey(key: string): Promise<unknown> {
  const res = await crmStateRequest("GET", { agentKey: AGENT_STATE_KEY, key });
  const row = res.data as { value?: unknown } | null;
  return row?.value;
}

async function writeStateKey(key: string, value: unknown): Promise<void> {
  await crmStateRequest("POST", undefined, { agentKey: AGENT_STATE_KEY, key, value });
}

// ───────────────────────── send_recruiting_invite ─────────────────────────

const INVITE_TEMPLATE = (first: string, roleDisplay: string, link: string, personalNote?: string) =>
  [
    `Hi ${first},`,
    "",
    `Thanks so much for applying to the ${roleDisplay} position at Flat Fee Landlord.${
      personalNote ? ` Your ${personalNote} really stood out.` : ""
    }`,
    "",
    "We'd love to move you forward. The next step is a quick video questionnaire — just a few questions, about 5 minutes:",
    "",
    link,
    "",
    "Completing it moves you to the front of our list. If you've already filled it out, please feel free to disregard this email.",
    "",
    "Looking forward to hearing from you!",
    "",
    "Best,",
    "The team at Flat Fee Landlord",
  ].join("\n");

export interface SendResult {
  sent: boolean;
  reason?: string;
  evidence?: unknown;
  to?: string;
  role?: string;
  link?: string;
  gmail_message_id?: string;
  sends_today?: number;
  /**
   * How the candidate actually receives this. Everything this server sends goes
   * out over Gmail, but an Indeed RELAY address delivers into the candidate's
   * Indeed message thread rather than their own inbox — from their side it is an
   * Indeed message, and Lando asked to see that split in the daily report.
   * Classified here, not guessed by the agent.
   */
  channel?: SendChannel;
}

export type SendChannel = "email" | "indeed_message";

/** Indeed relay addresses look like conversation-<name>-<id>@indeedemail.com. */
function sendChannelFor(email: string): SendChannel {
  return /@indeedemail\.com$/i.test(email.trim()) ? "indeed_message" : "email";
}

function sendCap(): number {
  const n = Number.parseInt(env("RECRUITING_SEND_CAP"), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SEND_CAP;
}

export async function sendRecruitingInvite(args: {
  email: string;
  first_name: string;
  last_name: string;
  role: string;
  personal_note?: string;
}): Promise<SendResult> {
  const email = args.email.trim().toLowerCase();
  const first = args.first_name.trim();
  const last = args.last_name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${args.email}" is not a valid email.`);
  if (!first || !last) throw new Error("first_name and last_name are both required (last name drives dedup).");

  // 1. Role must map to a known link — the agent can never send an arbitrary
  //    link. (2026-08-18: the out-of-scope refusal list is retired — all roles
  //    in ROLE_LINKS are invitable, per Mo. Unmappable roles still refuse.)
  const roleKey = normalizeRole(args.role);
  if (!roleKey) {
    return {
      sent: false,
      reason:
        `Role "${args.role}" does not map to any configured invite role. No email sent. ` +
        "Report the applicant by name so Mo can decide.",
    };
  }
  const roleDef = ROLE_LINKS[roleKey];
  if (!roleDef) return { sent: false, reason: `No link configured for role key ${roleKey}.` };

  // 2. Denylist.
  const fullName = `${first} ${last}`.toLowerCase();
  if (DENYLIST_NAMES.some((n) => fullName.includes(n))) {
    return { sent: false, reason: `"${first} ${last}" is on Mo's do-not-contact list. No email sent.` };
  }

  // 3. Per-day sent log: cap + same-day idempotency (safe across cron retries).
  const day = chicagoDateStamp();
  const logKey = `sent_${day}`;
  const existingLog = ((await readStateKey(logKey)) ?? []) as Array<{ email?: string }>;
  const log = Array.isArray(existingLog) ? existingLog : [];
  if (log.some((e) => (e.email ?? "").toLowerCase() === email)) {
    return {
      sent: false,
      reason: `Already sent to ${email} earlier today (idempotency log). No duplicate sent.`,
      sends_today: log.length,
    };
  }
  if (log.length >= sendCap()) {
    return {
      sent: false,
      reason: `Daily send cap reached (${sendCap()}). Carry this candidate forward and tell Mo.`,
      sends_today: log.length,
    };
  }

  // 4. Dedup — Gmail: have we EVER emailed this address? (in:sent)
  const sentMatches = await gmailSearchMessages(`in:sent to:${email}`, 5);
  if (sentMatches.length > 0) {
    return {
      sent: false,
      reason: `Dedup: ${email} already has ${sentMatches.length} message(s) in Sent. No email sent.`,
      evidence: sentMatches.map((m) => ({ subject: m.subject, at: m.receivedAt })),
    };
  }

  // 5. Dedup — VideoAsk contact index by LAST NAME (Golden Rule 1; email-only
  //    checks re-invite people like Rocky Garza who completed under a
  //    different email).
  let contactHits: ContactHit[] = [];
  try {
    const res = await searchVideoaskContacts(last);
    contactHits = res.hits;
  } catch (err) {
    // Fail CLOSED on dedup: if the contacts check is down we refuse to send
    // rather than risk a duplicate (the exact Trevon Oliver failure mode).
    return {
      sent: false,
      reason:
        `VideoAsk contacts dedup check failed (${err instanceof Error ? err.message : String(err)}). ` +
        "Refusing to send without it — retry later or ask Mo.",
    };
  }
  const nameMatch = contactHits.filter((c) => {
    const cn = c.name.toLowerCase();
    return (
      c.email === email ||
      (cn.includes(last.toLowerCase()) && cn.includes(first.toLowerCase()))
    );
  });
  if (nameMatch.length > 0) {
    return {
      sent: false,
      reason:
        `Dedup: VideoAsk contacts already include "${first} ${last}" (matched by name/email). ` +
        "They have interacted with a questionnaire before. No email sent.",
      evidence: nameMatch,
    };
  }

  // 6. Send (template + link are fixed server-side).
  const subject = `Next step for the ${roleDef.display} role – Flat Fee Landlord`;
  const body = INVITE_TEMPLATE(first, roleDef.display, roleDef.link, args.personal_note?.trim() || undefined);
  const messageId = await gmailSendMessage(email, subject, body);

  // 7. Append to today's log BEFORE returning (idempotency across retries).
  log.push({ email });
  await writeStateKey(logKey, [
    ...log.slice(0, -1),
    { email, name: `${first} ${last}`, role: roleKey, at: new Date().toISOString(), gmail_message_id: messageId },
  ]);

  return {
    sent: true,
    to: email,
    role: roleDef.display,
    link: roleDef.link,
    gmail_message_id: messageId,
    sends_today: log.length,
    channel: sendChannelFor(email),
  };
}

// ───────────────────────── send_testgorilla_invite ─────────────────────────
//
// Mo's ask (2026-08-18 PM): everyone who FULLY COMPLETES the "Virtual PM Flat
// Fee Landlord" VideoAsk (= answered Screening question 2, the same question
// get_videoask_completers reads) automatically gets the TestGorilla skills-
// assessment email. Previously a manual batch (~290 sent through 2026-07-20).
// The agent drives it: get_videoask_completers(since = testgorilla_boundary)
// → send_testgorilla_invite per completer → advance testgorilla_boundary.
// Template/subject are the EXACT proven July batch wording.

const TESTGORILLA_SUBJECT = "Your Flat Fee Landlord application - next step: skills assessment";
const TESTGORILLA_DEFAULT_LINK = "https://app.testgorilla.com/s/74janjj0";
const TESTGORILLA_DEFAULT_CAP = 25;

function testgorillaLink(): string {
  return env("TESTGORILLA_LINK") || TESTGORILLA_DEFAULT_LINK;
}

function testgorillaCap(): number {
  const n = Number.parseInt(env("TESTGORILLA_DAILY_CAP"), 10);
  return Number.isFinite(n) && n > 0 ? n : TESTGORILLA_DEFAULT_CAP;
}

const TESTGORILLA_TEMPLATE = (first: string, roleDisplay?: string) =>
  [
    `Hi ${first},`,
    "",
    // Mo (2026-08-18 PM): name the role they ACTUALLY applied for — the form
    // is shared by Virtual PM / VLS / Maintenance since 8/18. When the role
    // can't be determined, stay neutral rather than guess wrong.
    `Thanks for taking the time to record your video interview ${
      roleDisplay ? `for the ${roleDisplay} role at Flat Fee Landlord` : "with Flat Fee Landlord"
    }. We'd like to move you to the next stage of our hiring process: a short skills assessment.`,
    "",
    `Please complete it here: ${testgorillaLink()}`,
    "",
    "Once you've finished, we'll review your results and follow up on next steps. We're excited to learn more about you!",
    "",
    "Mo",
    "Flat Fee Landlord",
  ].join("\n");

/**
 * Resolve the role the candidate actually applied for (Mo's 2026-08-18 PM
 * rule: the assessment email names their real role). Priority:
 *  1. caller-provided role (agent context) → mapped display name;
 *  2. our own sent VideoAsk invite ("Next step for the <Role> role – …");
 *  3. undefined → the template falls back to neutral wording.
 */
async function resolveTestgorillaRole(email: string, roleArg?: string): Promise<string | undefined> {
  if (roleArg?.trim()) {
    const key = normalizeRole(roleArg);
    if (key && ROLE_LINKS[key]) return ROLE_LINKS[key].display;
    return roleArg.trim(); // unmapped but explicit — trust the agent's wording
  }
  try {
    const sent = await gmailSearchMessages(`in:sent to:${email} subject:"Next step for the"`, 3);
    for (const m of sent) {
      const match = /next step for the (.+?) role/i.exec(m.subject ?? "");
      if (match?.[1]) return match[1].trim();
    }
  } catch {
    // Role lookup is best-effort — never block the send on it.
  }
  return undefined;
}

export async function sendTestgorillaInvite(args: {
  email: string;
  name: string;
  role?: string;
  completed_at?: string;
}): Promise<SendResult> {
  const email = args.email.trim().toLowerCase();
  const name = args.name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${args.email}" is not a valid email.`);
  if (!name) throw new Error("name is required.");
  const first = name.split(/\s+/)[0];

  // 1. Denylist.
  if (DENYLIST_NAMES.some((n) => name.toLowerCase().includes(n))) {
    return { sent: false, reason: `"${name}" is on Mo's do-not-contact list. No email sent.` };
  }

  // 2. Per-day log: cap + same-day idempotency (safe across cron retries).
  const day = chicagoDateStamp();
  const logKey = `testgorilla_sent_${day}`;
  const existing = ((await readStateKey(logKey)) ?? []) as Array<{ email?: string }>;
  const log = Array.isArray(existing) ? existing : [];
  if (log.some((e) => (e.email ?? "").toLowerCase() === email)) {
    return {
      sent: false,
      reason: `Already sent TestGorilla to ${email} earlier today (idempotency log).`,
      sends_today: log.length,
    };
  }
  if (log.length >= testgorillaCap()) {
    return {
      sent: false,
      reason:
        `Daily TestGorilla cap reached (${testgorillaCap()}). Do NOT advance testgorilla_boundary ` +
        "past this completer — the backlog continues tomorrow. Mention the remaining count in the report.",
      sends_today: log.length,
    };
  }

  // 3. Dedup: have we EVER sent this address the skills assessment? Scoped by
  //    subject — candidates legitimately have OTHER mail from us (the VideoAsk
  //    invite), so a bare in:sent check would block everyone. This also covers
  //    all ~290 historical manual-batch sends (same subject, same mailbox).
  const sentMatches = await gmailSearchMessages(
    `in:sent to:${email} subject:"skills assessment"`,
    3,
  );
  if (sentMatches.length > 0) {
    return {
      sent: false,
      reason: `Dedup: ${email} already received the skills-assessment email. No duplicate sent.`,
      evidence: sentMatches.map((m) => ({ subject: m.subject, at: m.receivedAt })),
    };
  }

  // 4. Resolve the role they applied for, then send (template + link fixed
  //    server-side; wording names their actual role or stays neutral).
  const roleDisplay = await resolveTestgorillaRole(email, args.role);
  const messageId = await gmailSendMessage(
    email,
    TESTGORILLA_SUBJECT,
    TESTGORILLA_TEMPLATE(first, roleDisplay),
  );

  // 5. Log BEFORE returning (idempotency across retries).
  log.push({ email });
  await writeStateKey(logKey, [
    ...log.slice(0, -1),
    { email, name, role: roleDisplay, completed_at: args.completed_at, at: new Date().toISOString(), gmail_message_id: messageId },
  ]);

  return {
    sent: true,
    to: email,
    role: roleDisplay,
    gmail_message_id: messageId,
    sends_today: log.length,
    channel: sendChannelFor(email),
  };
}

// ───────────────────────── VideoAsk reminder pass ─────────────────────────
//
// Lando's ask (2026-08-20): every applicant who received the VideoAsk invite
// but has NOT completed the questionnaire gets ONE follow-up nudge, for every
// applicant we hold a usable address for.
//
// Shape mirrors send_testgorilla_invite: fixed server-side template, per-day
// cap, same-day idempotency, subject-scoped ever-sent dedup (so nobody is
// nudged twice, ever), the do-not-contact list, and a fail-CLOSED completion
// check against the all-forms VideoAsk contact index.
//
// Reach, stated honestly rather than implied:
//   * covered — anyone we invited ourselves (our own sent invite IS the
//     roster), including Indeed candidates whose relay address we hold;
//   * NOT covered — Indeed applicants who only ever appeared inside a bundled
//     grouped email. Those carry no address anywhere in mail. They were invited
//     natively by Indeed's own automation and can only be nudged through
//     Indeed's messaging UI, which is the browser half's job.
// get_videoask_pending reports that gap in `coverage` instead of hiding it.

const REMINDER_SUBJECT = "Quick nudge - your Flat Fee Landlord video questionnaire";
const INVITE_SUBJECT_MARKER = "Next step for the";
const REMINDER_DEFAULT_CAP = 25;
const REMINDER_DEFAULT_DELAY_DAYS = 3;
const REMINDER_LOOKBACK_DAYS_DEFAULT = 21;
// Reminder-window ceiling. 21 days, not 60: a nudge about a questionnaire from eight weeks
// ago reads worse than no nudge at all, and the first run would otherwise start with the
// stalest candidates in the backlog. Override with VIDEOASK_REMINDER_WINDOW_DAYS.
function reminderWindowDays(): number {
  const n = Number.parseInt(env("VIDEOASK_REMINDER_WINDOW_DAYS"), 10);
  return Number.isFinite(n) && n > 0 ? n : REMINDER_LOOKBACK_DAYS_DEFAULT;
}
const REMINDER_SCAN_CAP = 60;

function reminderCap(): number {
  const n = Number.parseInt(env("VIDEOASK_REMINDER_DAILY_CAP"), 10);
  return Number.isFinite(n) && n > 0 ? n : REMINDER_DEFAULT_CAP;
}

function reminderDelayDays(): number {
  const n = Number.parseInt(env("VIDEOASK_REMINDER_DELAY_DAYS"), 10);
  return Number.isFinite(n) && n > 0 ? n : REMINDER_DEFAULT_DELAY_DAYS;
}

const REMINDER_TEMPLATE = (first: string, roleDisplay: string, link: string) =>
  [
    `Hi ${first},`,
    "",
    `A few days ago we sent you a short video questionnaire for the ${roleDisplay} role at Flat Fee Landlord, and it looks like it is still open.`,
    "",
    "It takes about 5 minutes, and it is the step that moves your application forward:",
    "",
    link,
    "",
    "If you have already completed it, thank you - please ignore this. And if you are no longer interested, no problem at all; you can ignore this too and we will close out your application.",
    "",
    "Best,",
    "The team at Flat Fee Landlord",
  ].join("\n");

/** Pull the bare address out of a To/From header ("Name <a@b.c>" → "a@b.c"). */
function headerEmail(raw: string): string {
  const m = /<([^>]+)>/.exec(raw ?? "");
  return (m?.[1] ?? raw ?? "").trim().toLowerCase();
}

/**
 * Recover the candidate's real name from the invite WE sent. Never guess it from
 * the email address: `cblake822@gmail.com` yields "C", and the first live run
 * (2026-08-20) duly greeted three people as "Hi C,", "Hi R," and "Hi B,". Worse
 * than cosmetic — the guessed LAST name drives the fail-closed VideoAsk dedup, so
 * a wrong guess checks the wrong person.
 *
 * Two sources, both authoritative because they came from us:
 *   1. the To header's display name — "Chelsie Blake <cblake822@gmail.com>";
 *   2. the invite body's greeting — INVITE_TEMPLATE always opens "Hi <first>,".
 * No source means no name, and no name means the agent must skip and report,
 * never invent one.
 */
function nameFromToHeader(raw: string): string | undefined {
  const m = /^\s*"?([^"<]*[A-Za-z][^"<]*?)"?\s*</.exec(raw ?? "");
  const n = m?.[1]?.trim();
  if (!n || n.includes("@")) return undefined;
  return n;
}

function firstNameFromInviteBody(body: string): string | undefined {
  const m = /(?:^|\n)\s*Hi\s+([^,\n]{2,40}),/.exec(body ?? "");
  const n = m?.[1]?.trim();
  return n && /^[A-Za-z]/.test(n) ? n : undefined;
}

/** Recover the role from our own invite subject: "Next step for the <Role> role – …". */
function roleFromInviteSubject(subject: string): string | undefined {
  const m = /next step for the (.+?) role/i.exec(subject ?? "");
  return m?.[1]?.trim();
}

export interface PendingCandidate {
  email: string;
  name?: string;
  /** Where `name` came from — never the email address. */
  name_source?: "to_header" | "invite_greeting";
  role?: string;
  invited_at: string;
  days_waiting: number;
}

/**
 * get_videoask_pending — everyone we invited at least `days` ago who is not in
 * the VideoAsk contact index and has not already been nudged.
 *
 * Roster source is our OWN sent invite (subject marker "Next step for the"),
 * which is the only place an applicant's address and role are reliably paired.
 * Exclusion is by EMAIL only here — deliberately loose, because a last-name
 * match would suppress every candidate who shares a surname with a completer.
 * The strict fail-closed name check runs in send_videoask_reminder, so a
 * candidate can still be refused at send time; that refusal is the safe
 * direction and gets reported.
 */
export async function getVideoaskPending(
  daysSinceInvite?: number,
  limit?: number,
): Promise<{
  pending: PendingCandidate[];
  scanned_invites: number;
  already_reminded: number;
  completed: number;
  truncated: boolean;
  days_since_invite: number;
  window_days: number;
  coverage: string;
}> {
  const days =
    Number.isFinite(daysSinceInvite as number) && (daysSinceInvite as number) > 0
      ? Math.floor(daysSinceInvite as number)
      : reminderDelayDays();
  const cap = Number.isFinite(limit as number) && (limit as number) > 0 ? Math.floor(limit as number) : 25;

  const invites = await gmailSearchMessages(
    `in:sent subject:"${INVITE_SUBJECT_MARKER}" older_than:${days}d newer_than:${reminderWindowDays()}d`,
    REMINDER_SCAN_CAP,
  );
  const reminders = await gmailSearchMessages(
    `in:sent subject:"${REMINDER_SUBJECT}" newer_than:365d`,
    REMINDER_SCAN_CAP,
  );
  const remindedTo = new Set(reminders.map((m) => headerEmail(m.to)).filter(Boolean));

  // Completion / engagement check, in bulk: the all-forms contact index.
  const index = await getContactIndex();
  const completedEmails = new Set(index.contacts.map((c) => (c.e ?? "").toLowerCase()).filter(Boolean));

  const seen = new Set<string>();
  const pending: PendingCandidate[] = [];
  let alreadyReminded = 0;
  let completed = 0;

  // NEWEST invite first. The instinct is oldest-first (longest wait = most owed a nudge), but
  // with a standing backlog that spends the daily cap on the coldest names in the window
  // while someone who applied on Tuesday waits behind them. Recent applicants convert; a
  // three-week-old silence usually stays silent.
  const ordered = [...invites].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  for (const m of ordered) {
    const email = headerEmail(m.to);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (remindedTo.has(email)) {
      alreadyReminded += 1;
      continue;
    }
    if (completedEmails.has(email)) {
      completed += 1;
      continue;
    }
    const sentAt = Date.parse(m.receivedAt);
    const headerName = nameFromToHeader(m.to);
    const greetingName = headerName ? undefined : firstNameFromInviteBody(m.bodyText);
    pending.push({
      email,
      name: headerName ?? greetingName,
      name_source: headerName ? "to_header" : greetingName ? "invite_greeting" : undefined,
      role: roleFromInviteSubject(m.subject),
      invited_at: m.receivedAt,
      days_waiting: Number.isNaN(sentAt) ? 0 : Math.floor((Date.now() - sentAt) / 86400000),
    });
  }

  return {
    pending: pending.slice(0, cap),
    scanned_invites: invites.length,
    already_reminded: alreadyReminded,
    completed,
    truncated: pending.length > cap || invites.length >= REMINDER_SCAN_CAP,
    days_since_invite: days,
    window_days: reminderWindowDays(),
    coverage:
      "Roster = invites WE sent. Indeed applicants who only appeared inside a bundled grouped " +
      "email have no address in mail and are NOT in this list — they were invited natively by " +
      "Indeed's own automation and can only be nudged through Indeed's messaging UI (browser " +
      "half). Say so plainly in the report rather than implying full coverage.",
  };
}

/**
 * send_videoask_reminder — ONE follow-up nudge to a candidate who was invited
 * and has not completed the questionnaire. Every guard that protects
 * send_recruiting_invite applies, plus two more: we refuse to nudge anyone we
 * cannot prove we invited, and we refuse to nudge twice.
 */
export async function sendVideoaskReminder(args: {
  email: string;
  first_name: string;
  last_name: string;
  role?: string;
}): Promise<SendResult> {
  const email = args.email.trim().toLowerCase();
  const first = args.first_name.trim();
  const last = args.last_name.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`"${args.email}" is not a valid email.`);
  if (!first || !last) throw new Error("first_name and last_name are both required (last name drives dedup).");

  // 0. Never greet an initial. On the first live run (2026-08-20) three people were
  //    emailed "Hi C,", "Hi R," and "Hi B," because get_videoask_pending returned no
  //    name and the agent derived one from the email address. That also means the
  //    LAST name was invented — and the invented last name is what the fail-closed
  //    VideoAsk dedup below checks, so a wrong guess checks the wrong person. Refuse
  //    instead: use the `name` get_videoask_pending now returns, or skip and report.
  if (first.length < 2 || !/^[A-Za-z]/.test(first)) {
    return {
      sent: false,
      reason:
        `first_name "${first}" looks derived from the email address, not from a real name. Refusing — ` +
        "a one-letter greeting reads as broken, and the guessed last name would be checked against the " +
        "wrong person in the dedup. Use the name from get_videoask_pending, or report this candidate " +
        "by email and move on.",
    };
  }
  if (last.length < 2 || !/^[A-Za-z]/.test(last)) {
    return {
      sent: false,
      reason:
        `last_name "${last}" is not a usable surname, and dedup runs on it. Refusing — use the name ` +
        "from get_videoask_pending or report this candidate by email.",
    };
  }

  // 1. Denylist.
  const fullName = `${first} ${last}`.toLowerCase();
  if (DENYLIST_NAMES.some((n) => fullName.includes(n))) {
    return { sent: false, reason: `"${first} ${last}" is on Mo's do-not-contact list. No email sent.` };
  }

  // 2. Per-day log: cap + same-day idempotency (safe across cron retries).
  const day = chicagoDateStamp();
  const logKey = `videoask_reminder_sent_${day}`;
  const existing = ((await readStateKey(logKey)) ?? []) as Array<{ email?: string }>;
  const log = Array.isArray(existing) ? existing : [];
  if (log.some((e) => (e.email ?? "").toLowerCase() === email)) {
    return {
      sent: false,
      reason: `Already nudged ${email} earlier today (idempotency log).`,
      sends_today: log.length,
    };
  }
  if (log.length >= reminderCap()) {
    return {
      sent: false,
      reason:
        `Daily reminder cap reached (${reminderCap()}). Carry the rest forward — the backlog ` +
        "continues tomorrow — and put the remaining count in the report.",
      sends_today: log.length,
    };
  }

  // 3. We must be able to PROVE we invited them, and recover their role from
  //    that invite. Never nudge someone about a questionnaire we never sent.
  const inviteMatches = await gmailSearchMessages(
    `in:sent to:${email} subject:"${INVITE_SUBJECT_MARKER}"`,
    3,
  );
  if (inviteMatches.length === 0) {
    return {
      sent: false,
      reason:
        `No VideoAsk invite to ${email} found in Sent — refusing to nudge someone we cannot prove ` +
        "we invited. If they applied through Indeed they were invited by Indeed's own automation; " +
        "that nudge has to go through Indeed messaging (browser half), not email.",
    };
  }

  // 4. One nudge per person, ever (subject-scoped).
  const reminderMatches = await gmailSearchMessages(
    `in:sent to:${email} subject:"${REMINDER_SUBJECT}"`,
    3,
  );
  if (reminderMatches.length > 0) {
    return {
      sent: false,
      reason: `Dedup: ${email} already received the follow-up nudge. One per candidate, ever.`,
      evidence: reminderMatches.map((m) => ({ subject: m.subject, at: m.receivedAt })),
    };
  }

  // 5. Have they already engaged? Fail CLOSED, exactly like the invite path:
  //    if the contact index is unreachable we refuse rather than risk nudging
  //    someone who already recorded their video.
  try {
    const res = await searchVideoaskContacts(last);
    const hit = res.hits.find(
      (h) =>
        (h.email ?? "").toLowerCase() === email ||
        (h.name ?? "").toLowerCase().includes(fullName) ||
        (h.name ?? "").toLowerCase().includes(`${last.toLowerCase()}, ${first.toLowerCase()}`),
    );
    if (hit) {
      return {
        sent: false,
        reason:
          `VideoAsk contacts already include "${hit.name}" (${hit.email || "no email"}) — they have ` +
          "engaged with a questionnaire. No nudge sent.",
        evidence: [{ name: hit.name, email: hit.email, form: hit.form, created_at: hit.created_at }],
      };
    }
  } catch (err) {
    return {
      sent: false,
      reason:
        `VideoAsk contacts check failed (${err instanceof Error ? err.message : String(err)}). ` +
        "Refusing to nudge blind — retry next run.",
    };
  }

  // 6. Resolve the role → the questionnaire link. Caller's role wins; otherwise
  //    recover it from our own invite subject. An unmappable role is refused —
  //    the agent can never cause an arbitrary link to be sent.
  const roleRaw =
    args.role?.trim() || roleFromInviteSubject(inviteMatches[0]?.subject ?? "") || "";
  const roleKey = normalizeRole(roleRaw);
  const roleDef = roleKey ? ROLE_LINKS[roleKey] : undefined;
  if (!roleDef) {
    return {
      sent: false,
      reason:
        `Could not map a role for ${email} (looked at "${roleRaw || "nothing"}"). No nudge sent — ` +
        "report them by name so Mo can decide.",
    };
  }

  // 7. Send, then log BEFORE returning (idempotency across cron retries).
  const messageId = await gmailSendMessage(
    email,
    REMINDER_SUBJECT,
    REMINDER_TEMPLATE(first, roleDef.display, roleDef.link),
  );
  log.push({ email });
  await writeStateKey(logKey, [
    ...log.slice(0, -1),
    {
      email,
      name: `${first} ${last}`,
      role: roleDef.display,
      invited_at: inviteMatches[0]?.receivedAt,
      at: new Date().toISOString(),
      gmail_message_id: messageId,
    },
  ]);

  return {
    sent: true,
    to: email,
    role: roleDef.display,
    link: roleDef.link,
    gmail_message_id: messageId,
    sends_today: log.length,
    channel: sendChannelFor(email),
  };
}

// ───────────────────────── watchdog alert ─────────────────────────

export async function sendWatchdogAlert(reason: string, detail?: string): Promise<Record<string, unknown>> {
  const day = chicagoDateStamp();
  const logKey = `watchdog_sent_${day}`;
  const existing = ((await readStateKey(logKey)) ?? []) as unknown[];
  const log = Array.isArray(existing) ? existing : [];
  if (log.length >= WATCHDOG_CAP_PER_DAY) {
    return { sent: false, reason: `Watchdog alert cap (${WATCHDOG_CAP_PER_DAY}/day) reached.` };
  }
  const to = gmailImpersonatedUser();
  const subject = `⚠️ Recruiting sweep watchdog: ${reason.slice(0, 120)}`;
  const body = [
    "This is the recruiting cloud agent's watchdog.",
    "",
    reason,
    ...(detail ? ["", detail] : []),
    "",
    "— recruiting-sweep (Managed Agent, cloud half)",
  ].join("\n");
  const messageId = await gmailSendMessage(to, subject, body);
  log.push({ reason, at: new Date().toISOString() });
  await writeStateKey(logKey, log);
  return { sent: true, to, gmail_message_id: messageId };
}

// ───────────────────────── run-status report ─────────────────────────

export async function reportRecruitingRun(args: {
  status: string;
  summary: string;
  needsHuman?: boolean;
}): Promise<Record<string, unknown>> {
  const key = workforceKey();
  if (!key) return { reported: false, reason: "FFL_WORKFORCE_API_KEY not set." };
  const status = ["ok", "failed", "partial"].includes(args.status) ? args.status : "ok";
  const res = await fetch(`${crmBaseUrl()}/api/v1/agent/run-status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      agentKey: AGENT_STATE_KEY,
      status,
      summary: args.summary.slice(0, 1000),
      needsHuman: args.needsHuman ?? false,
      tier: "yellow",
    }),
  });
  return { reported: res.ok, http_status: res.status };
}

// ───────────────────────── auth helper for the transport ─────────────────────────

export function recruitingMcpTokenOk(presented: string): boolean {
  const expected = env("RECRUITING_MCP_TOKEN");
  if (expected.length < 32) return false; // fail closed until configured
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return a.equals(b);
}
