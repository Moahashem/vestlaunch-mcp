/**
 * property_inbox — resumes emailed straight to the property, then forwarded on.
 *
 * WHY THIS EXISTS (2026-09-09): candidates email Cranbrook directly. The on-site
 * manager forwards those to Mo, sometimes by way of Yuliana, so a single resume
 * can arrive wrapped in two forwards. Five landed in one afternoon; some had
 * been sitting since 8/29. The daily cloud sweep saw every one of them in the
 * `true_analysis` catch-all and could invite nobody, because that channel
 * returns only a 300-character snippet — and these bodies open with the
 * property's own signature block, so the candidate's address never fits inside
 * the window. This module reads the real body instead.
 *
 * DELIBERATE DUPLICATION: the Gmail token/search/body helpers below mirror the
 * private ones in recruiting-tools.ts. They are copied rather than imported
 * because those are not exported, and the tooling available to the agent that
 * wrote this could not push a change to that 93 KB file in one piece. Folding
 * these back into recruiting-tools.ts (export the four helpers, delete this
 * block) is a clean follow-up for anyone with a normal `git push`.
 */

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) return cachedToken.token;

  const clientId = env("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = env("GMAIL_OAUTH_CLIENT_SECRET");
  const refreshToken = env("GMAIL_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Gmail OAuth is partially configured — GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET " +
        "and GMAIL_REFRESH_TOKEN must all be set.",
    );
  }

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
  if (!res.ok) throw new Error(`Gmail OAuth refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("Gmail OAuth refresh returned no access_token.");
  cachedToken = { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
  return body.access_token;
}

async function gmailGet<T>(path: string): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail API ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Which mailbox actually answered. SOP hard rule: an empty result is never
 * proof of "nothing new" until the inbox has identified itself.
 */
async function verifiedMailbox(): Promise<string> {
  const p = await gmailGet<{ emailAddress?: string }>("/profile");
  const box = (p.emailAddress ?? "").toLowerCase();
  if (!box) throw new Error("Gmail /profile returned no emailAddress — refusing to trust the result.");
  return box;
}

function decodePart(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
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

function header(headers: Array<{ name?: string; value?: string }>, want: string): string {
  return headers.find((h) => (h.name ?? "").toLowerCase() === want.toLowerCase())?.value ?? "";
}

/* ------------------------------------------------------------------ */
/* Pure parsing — the part worth testing                               */
/* ------------------------------------------------------------------ */

/** Addresses that belong to US. The candidate is never one of these. */
const INTERNAL_EMAIL_DOMAINS = ["flatfeelandlord.com", "hazelmanagement.com", "hazelequity.com"];

function isInternalAddress(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return INTERNAL_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** A display name is useless if it is an address, too short, or carries emoji. */
function usableDisplayName(raw: string): string {
  const n = raw.replace(/^["'\s]+|["'\s]+$/g, "").trim();
  if (!n || n.includes("@")) return "";
  if (/[^\p{L}\s.'\-]/u.test(n)) return "";
  if (n.replace(/[^\p{L}]/gu, "").length < 3) return "";
  return n.replace(/\s{2,}/g, " ").trim();
}

/**
 * Recover a name from the subject when the display name is junk ("kimm <3.").
 * Handles "Selica Gutierrez Resume", "Resume - Kimberly Coutino Asst Manager",
 * "Monica résumé". \b is unreliable next to accented letters, so the keyword
 * strip anchors on whitespace and separators instead.
 */
export function nameFromResumeSubject(subject: string): string {
  let t = (subject || "").replace(/^\s*(fwd|fw|re)\s*:\s*/gi, "").trim();
  t = t.replace(/(^|[\s\-–—_|])(r[eé]sum[eé]*|cv|application)(?=[\s\-–—_|]|$)/gi, "$1 ");
  t = t.replace(/\b(asst|assistant|community|property|leasing|manager|mgr)\b/gi, " ");
  t = t.replace(/[-–—_|]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return usableDisplayName(t);
}

export interface ForwardedApplicant {
  name: string;
  email: string;
}

/**
 * Pull the original sender out of a forwarded body by taking the DEEPEST
 * non-internal `From:` line, so a double forward (manager → Yuliana → Mo)
 * resolves to the candidate rather than to us.
 */
export function parseForwardedApplicant(body: string, subject = ""): ForwardedApplicant | null {
  const re = /^\s*From:\s*(.*?)\s*<\s*([^>\s]+@[^>\s]+)\s*>/gim;
  const found: Array<{ name: string; email: string }> = [];
  for (const m of body.matchAll(re)) {
    const email = m[2].trim().toLowerCase();
    if (!isInternalAddress(email)) found.push({ name: m[1] ?? "", email });
  }
  if (found.length === 0) return null;
  const last = found[found.length - 1];
  return { name: usableDisplayName(last.name) || nameFromResumeSubject(subject), email: last.email };
}

/* ------------------------------------------------------------------ */

export interface ForwardedResumeApplicant {
  name: string;
  email: string;
  role: string;
  role_key: string;
  in_scope: boolean;
  source: string;
  received_at: string;
  message_id: string;
  subject: string;
  note?: string;
}

const PROPERTY_SENDERS = [
  "cranbrookmgr@hazelmanagement.com",
  "cranbrook@hazelmanagement.com",
  "yuli@flatfeelandlord.com",
  "yuliana@hazelmanagement.com",
];

/** Cranbrook's open seat. Used when the subject names no role at all ("Resume"). */
const DEFAULT_ROLE_KEY = "assistant_community_manager";
const DEFAULT_ROLE_DISPLAY = "Assistant Community Manager";

export async function getForwardedResumes(sinceIso: string): Promise<Record<string, unknown>> {
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) throw new Error(`since_iso is not a valid date: ${sinceIso}`);
  const after = `after:${Math.floor(t / 1000)}`;
  const mailbox = await verifiedMailbox();

  const from = PROPERTY_SENDERS.map((s) => `from:${s}`).join(" OR ");
  const q = `(${from}) (subject:resum OR subject:cv OR subject:Fwd OR subject:FW OR resume) ${after}`;

  const list = await gmailGet<{ messages?: Array<{ id: string }> }>(
    `/messages?maxResults=50&q=${encodeURIComponent(q)}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);

  const applicants: ForwardedResumeApplicant[] = [];
  const unparsed: Array<{ subject: string; received_at: string; message_id: string }> = [];

  for (const id of ids) {
    const msg = await gmailGet<{
      id: string;
      internalDate?: string;
      payload?: { headers?: Array<{ name?: string; value?: string }> } & Record<string, unknown>;
    }>(`/messages/${id}?format=full`);
    const headers = msg.payload?.headers ?? [];
    const subject = header(headers, "Subject");
    const receivedAt = new Date(Number(msg.internalDate ?? Date.now())).toISOString();
    const body = extractBodyText(msg.payload);

    const parsed = parseForwardedApplicant(body, subject);
    if (!parsed?.email) {
      unparsed.push({ subject, received_at: receivedAt, message_id: id });
      continue;
    }
    applicants.push({
      name: parsed.name,
      email: parsed.email,
      role: DEFAULT_ROLE_DISPLAY,
      role_key: DEFAULT_ROLE_KEY,
      in_scope: true,
      source: "property_inbox",
      received_at: receivedAt,
      message_id: id,
      subject,
      note:
        "Role is not stated in these emails, so it defaults to Assistant Community Manager — " +
        "the open Cranbrook seat. Change it if the subject or resume says otherwise.",
    });
  }

  return {
    channel: "property_inbox",
    swept: true,
    mailbox_verified: mailbox,
    applicants,
    total: applicants.length,
    unparsed,
    note:
      "Resumes emailed to the property and forwarded on. The candidate is the deepest " +
      "non-internal From: line, so double forwards resolve to the candidate, not to us. " +
      "Anything under `unparsed` had no readable sender — surface those to Mo by subject.",
  };
}
