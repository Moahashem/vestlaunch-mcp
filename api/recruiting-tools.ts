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
 *  - VideoAsk: via the DEDICATED recruiting Zapier MCP server (raw GET action).
 *    VideoAsk's direct API is OAuth-only with 24h tokens; Zapier already holds
 *    and refreshes that OAuth (connection verified 2026-08-17).
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
 *  - Dedup is ENFORCED in the tool: Gmail `in:sent to:<email>` AND VideoAsk
 *    Contacts search by LAST NAME (Golden Rule 1 — name, not email; the Rocky
 *    Garza case). A match refuses the send and returns the evidence.
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
};

/** Loose aliases → canonical role key. */
function normalizeRole(raw: string): string | null {
  const s = raw.toLowerCase().replace(/[^a-z]+/g, " ").trim();
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

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

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

async function googleAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.expiresAt - 60 > now) return cachedGoogleToken.token;

  // Preferred path: OAuth refresh token (house pattern).
  const clientId = env("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = env("GMAIL_OAUTH_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");
  if (clientId && clientSecret && refreshToken) {
    const { token, expiresIn } = await refreshGrantToken(clientId, clientSecret, refreshToken);
    cachedGoogleToken = { token, expiresAt: now + expiresIn };
    return token;
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
  cachedGoogleToken = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

async function gmailFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = await googleAccessToken();
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
export async function gmailVerifiedMailbox(): Promise<string> {
  const profile = await gmailFetch<{ emailAddress?: string }>("/profile");
  const addr = (profile.emailAddress ?? "").toLowerCase();
  const expected = gmailImpersonatedUser().toLowerCase();
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

async function gmailSearchMessages(q: string, cap = MAX_GMAIL_MESSAGES_PER_CHANNEL): Promise<GmailMessageMeta[]> {
  const list = await gmailFetch<{ messages?: Array<{ id: string; threadId: string }> }>(
    `/messages?q=${encodeURIComponent(q)}&maxResults=${cap}`,
  );
  const out: GmailMessageMeta[] = [];
  for (const m of (list.messages ?? []).slice(0, cap)) {
    const full = await gmailFetch<Record<string, unknown>>(`/messages/${m.id}?format=full`);
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

async function gmailSendMessage(to: string, subject: string, body: string): Promise<string> {
  const from = gmailImpersonatedUser();
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
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

/** Peel Zapier's wrapping until we reach the raw VideoAsk JSON response. */
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
      if (o.results !== undefined && Array.isArray(o.results) && o.results.length === 1) {
        v = o.results[0];
        continue;
      }
      if (o.response !== undefined) {
        v = o.response;
        continue;
      }
      if (o.body !== undefined && o.contents === undefined && o.results === undefined) {
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
  return parsed as Record<string, unknown>;
}

export interface Completer {
  name: string;
  email: string;
  completed_at: string;
}

/**
 * get_videoask_completers — pages the answers endpoint newest-first and STRIPS
 * each ~5k-token record down to {name, email, completed_at} server-side.
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
    const contents = (page.contents ?? page.answers ?? page.results ?? []) as Array<
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
}

/**
 * search_videoask_contacts — the live Contacts-by-surname dedup check
 * (Golden Rule 1: dedup by NAME, not email — the Rocky Garza case).
 */
export async function searchVideoaskContacts(query: string): Promise<ContactHit[]> {
  const q = query.trim();
  if (!q) throw new Error("query is required (usually the candidate's last name).");
  const orgId = env("VIDEOASK_ORG_ID") || VIDEOASK_ORG_ID_DEFAULT;
  const template =
    env("VIDEOASK_CONTACTS_PATH") || `/organizations/{org_id}/contacts?search={query}&limit=25`;
  const path = template.replace("{org_id}", orgId).replace("{query}", encodeURIComponent(q));
  const page = await videoaskGet(path);
  const contents = (page.contents ?? page.contacts ??
    page.results ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(contents)) return [];
  return contents.map((c) => ({
    name: String(c.name ?? c.contact_name ?? "").trim(),
    email: String(c.email ?? c.contact_email ?? "").trim().toLowerCase(),
    created_at: String(c.created_at ?? ""),
  }));
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

const OUT_OF_SCOPE_ROLES =
  /(maintenance|virtual\s+leasing|vls|executive\s+assistant|(^|\s)ea(\s|$)|turn\s*around)/i;

function classifyRole(rawRole: string): { role_key: string | null; in_scope: boolean } {
  if (OUT_OF_SCOPE_ROLES.test(rawRole)) return { role_key: null, in_scope: false };
  const key = normalizeRole(rawRole);
  // 4 apartment roles + BD/Sales Manager (Mo's 2026-08-17 ruling: website
  // BD/Sales leads DO get invited with fhzg3ayze).
  return { role_key: key, in_scope: key !== null };
}

export async function getNewApplicants(
  channel: string,
  sinceIso: string,
): Promise<Record<string, unknown>> {
  const ch = channel.trim().toLowerCase();

  if (ch === "hazelequity") {
    // Deliberately unswept in the cloud half: the connector/service account is
    // flatfeelandlord-only. NEVER report this as "zero applicants". (Checked
    // BEFORE the mailbox verification — this channel needs no Gmail at all.)
    return {
      channel: ch,
      swept: false,
      reason:
        "mo@hazelequity.com is not reachable from the cloud half (no Gmail credential for that " +
        "account). Report it as UNSWEPT, not as zero applicants. It is read in Chrome Gmail u/1 " +
        "by the browser half / Mo.",
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
      if (/executive assistant/i.test(roleRaw) || /executive assistant/i.test(m.subject)) {
        skipped.push({ subject: m.subject, reason: "Executive Assistant — not one of our roles" });
        continue;
      }
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
    `Unknown channel "${channel}". Valid: website, wix, wizehire, true_analysis, hazelequity.`,
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
    for (const r of rows) if (r?.key) state[r.key] = r.value;
  }
  return { agentKey: AGENT_STATE_KEY, state };
}

export async function updateRecruitingState(key: string, value: unknown): Promise<Record<string, unknown>> {
  const k = key.trim();
  if (!k) throw new Error("key is required.");
  if (/^(sent_|watchdog_sent_)/.test(k)) {
    throw new Error(`key "${k}" is reserved for the send tool's internal logs.`);
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

  // 1. Role must map to a known link — the agent can never send an arbitrary link.
  //    Out-of-scope roles are refused OUTRIGHT before alias matching, so e.g.
  //    "Virtual Leasing Agent (Remote)" can never alias into Leasing Agent.
  if (OUT_OF_SCOPE_ROLES.test(args.role)) {
    return {
      sent: false,
      reason:
        `Role "${args.role}" is OUT OF SCOPE for invites (Maintenance/VLS/EA/Turn Around are ` +
        "never invited by this sweep). No email sent.",
    };
  }
  const roleKey = normalizeRole(args.role);
  if (!roleKey) {
    return {
      sent: false,
      reason: `Role "${args.role}" does not map to any of the 5 invite roles. No email sent.`,
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

  // 5. Dedup — VideoAsk Contacts by LAST NAME (Golden Rule 1; email-only checks
  //    re-invite people like Rocky Garza who completed under a different email).
  let contactHits: ContactHit[] = [];
  try {
    contactHits = await searchVideoaskContacts(last);
  } catch (err) {
    // Fail CLOSED on dedup: if the contacts check is down we refuse to send
    // rather than risk a duplicate (the exact Trevon Oliver failure mode).
    return {
      sent: false,
      reason:
        `VideoAsk Contacts dedup check failed (${err instanceof Error ? err.message : String(err)}). ` +
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
        `Dedup: VideoAsk Contacts already has "${first} ${last}" (matched by name/email). ` +
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
