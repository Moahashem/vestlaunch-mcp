/**
 * Daily cron — FFL screening applications from BoomScreen (Boom Partner API).
 *
 * Pulls the TRUE monthly screening flow straight from Boom (the source of record)
 * and writes it to the AI Workforce hub as `ffl.applications`, replacing the
 * AppFolio-derived count. Counting from Boom by SUBMITTED date means the monthly
 * total stays correct even after an application is approved/declined and leaves the
 * screening stage — the LeadSimple stage is a transient snapshot; Boom keeps the
 * full history.
 *
 * Deterministic (no LLM): authenticate → page through /applications → bucket by
 * Central-Time submitted month → upsert one snapshot. Best-effort run-status.
 *
 * Auth is robust to BOTH Boom key formats (it tries each on /applications and
 * uses whichever Boom accepts):
 *   (a) access key + secret key → POST /partner/v1/authenticate → bearer token
 *   (b) the "JWT secret" used directly as the bearer token
 *
 * Secrets (ALL placed by Mo in Vercel env — never hard-coded):
 *   BOOM_ACCESS_KEY   — Boom Partner API access key (the "VestLaunch Company Numbers" key)
 *   BOOM_SECRET_KEY   — its secret (the "JWT secret")
 *   BOOM_API_BASE     — optional; default https://api.sandbox.boompay.app
 *                       (this is Boom's documented API host; the KEY decides live vs sandbox mode)
 *   FFL_WORKFORCE_API_KEY / VESTLAUNCH_API_KEY — ffl-crm key (agent:write) to write the snapshot
 *   VESTLAUNCH_BASE_URL — ffl-crm base, no trailing slash (default https://crm.vestlaunch.com)
 *   CRON_SECRET        — random string; gates this endpoint (shared)
 *
 * Schedule: see vercel.json. Runs after the occupancy cron so Boom is the
 * authoritative writer of ffl.applications.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun } from "../workforce-hub";

export const config = { maxDuration: 60 };

const AGENT_KEY = "boom-screenings";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function boomBase(): string {
  return (process.env.BOOM_API_BASE ?? "https://api.sandbox.boompay.app").trim().replace(/\/+$/, "");
}
function hubBase(): string {
  return (
    process.env.VESTLAUNCH_BASE_URL ??
    process.env.AGENT_OS_BASE_URL ??
    "https://crm.vestlaunch.com"
  )
    .trim()
    .replace(/\/+$/, "");
}
function hubKey(): string {
  return (process.env.FFL_WORKFORCE_API_KEY ?? process.env.VESTLAUNCH_API_KEY ?? "").trim();
}

// Central-Time year-month "YYYY-MM" for a given date.
function ctYearMonth(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
  }).format(d);
}
// The calendar month before a "YYYY-MM" string.
function prevYearMonth(ym: string): string {
  const [y, m] = ym.split("-").map((n) => parseInt(n, 10));
  const d = new Date(Date.UTC(y, m - 2, 1)); // m is 1-based; go back one month
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Defensive: pull a submitted timestamp from an application object regardless of
// the exact field name Boom uses.
function submittedDate(app: Record<string, unknown>): Date | null {
  const cand =
    app.submitted_at ??
    app.submittedAt ??
    app.submitted_date ??
    app.submittedDate ??
    app.submitted ??
    null;
  if (typeof cand === "string" && cand.length > 0) {
    const d = new Date(cand);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
function statusOf(app: Record<string, unknown>): string {
  const s = app.status ?? app.state ?? app.decision ?? "";
  return typeof s === "string" ? s.toLowerCase() : "";
}

// Extract an array of application objects from various response shapes.
function extractList(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of ["data", "applications", "results", "items", "records"]) {
      const v = o[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === "object") {
        for (const k2 of ["applications", "results", "items", "records", "data"]) {
          const v2 = (v as Record<string, unknown>)[k2];
          if (Array.isArray(v2)) return v2 as Record<string, unknown>[];
        }
      }
    }
  }
  return [];
}

interface AuthResp {
  token?: string;
  api_token?: string;
  access_token?: string;
  data?: { token?: string; api_token?: string; access_token?: string };
}

interface TokenCandidate {
  mode: string;
  token: string;
}

// Build the list of bearer tokens to try, in order: the exchanged token from
// /authenticate (if any), then the raw secret used directly as a JWT bearer.
// Also returns a short diag string describing the authenticate attempt.
async function buildCandidates(
  base: string,
  accessKey: string,
  secretKey: string,
): Promise<{ candidates: TokenCandidate[]; authDiag: string }> {
  const candidates: TokenCandidate[] = [];
  let authDiag = "authenticate not-attempted";
  if (accessKey) {
    try {
      const r = await fetch(`${base}/partner/v1/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ access_key: accessKey, secret_key: secretKey }),
      });
      authDiag = `authenticate HTTP ${r.status}`;
      if (r.ok) {
        const txt = await r.text();
        try {
          const j = JSON.parse(txt) as AuthResp;
          const t =
            j.token ?? j.api_token ?? j.access_token ?? j.data?.token ?? j.data?.api_token ?? j.data?.access_token;
          if (t) {
            candidates.push({ mode: "exchanged", token: t });
            authDiag += " token-ok";
          } else {
            authDiag += " no-token-field";
          }
        } catch {
          authDiag += " unparseable";
        }
      }
    } catch {
      authDiag = "authenticate net-error";
    }
  }
  if (secretKey) candidates.push({ mode: "direct-secret", token: secretKey });
  return { candidates, authDiag };
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // --- Gate (Vercel cron sends Bearer <CRON_SECRET>) ---
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const accessKey = (process.env.BOOM_ACCESS_KEY ?? "").trim();
  const secretKey = (process.env.BOOM_SECRET_KEY ?? "").trim();
  if (!secretKey) {
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "failed",
      summary: "boom-screenings: missing env BOOM_SECRET_KEY",
      needsHuman: true,
    });
    json(res, 500, { ok: false, error: "Missing env: BOOM_SECRET_KEY" });
    return;
  }

  const base = boomBase();
  const listUrl = (page: number) =>
    `${base}/partner/v1/applications?page=${page}&per_page=100`;

  try {
    // --- 1. Resolve a working bearer token by trying each candidate on page 1 ---
    const { candidates, authDiag } = await buildCandidates(base, accessKey, secretKey);
    let workingToken: string | null = null;
    let workingMode = "";
    let firstPageText = "";
    const tried: string[] = [];
    for (const c of candidates) {
      const r = await fetch(listUrl(1), {
        headers: { Authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      });
      tried.push(`${c.mode}:${r.status}`);
      if (r.ok) {
        workingToken = c.token;
        workingMode = c.mode;
        firstPageText = await r.text();
        break;
      }
    }
    if (!workingToken) {
      const summary = `boom-screenings: applications auth rejected — ${authDiag}; list tried [${tried.join(", ")}]`;
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary, needsHuman: true });
      json(res, 502, { ok: false, stage: "auth", authDiag, tried });
      return;
    }

    // --- 2. Page through applications (page 1 already fetched) ---
    const apps: Record<string, unknown>[] = [];
    const perPage = 100;
    {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(firstPageText);
      } catch {
        /* */
      }
      const batch = extractList(parsed);
      apps.push(...batch);
      let page = 2;
      const MAX_PAGES = 50;
      let lastLen = batch.length;
      while (lastLen >= perPage && page <= MAX_PAGES) {
        const r = await fetch(listUrl(page), {
          headers: { Authorization: `Bearer ${workingToken}`, "content-type": "application/json" },
        });
        if (!r.ok) break;
        const t = await r.text();
        let p: unknown = null;
        try {
          p = JSON.parse(t);
        } catch {
          /* */
        }
        const b = extractList(p);
        apps.push(...b);
        lastLen = b.length;
        page++;
      }
    }

    // --- 3. Bucket by Central-Time submitted month ---
    const thisYM = ctYearMonth(new Date());
    const lastYM = prevYearMonth(thisYM);
    let submittedThis = 0;
    let submittedLast = 0;
    let approvedThis = 0;
    let declinedThis = 0;
    let pendingThis = 0;
    for (const app of apps) {
      const sd = submittedDate(app);
      if (!sd) continue;
      const ym = ctYearMonth(sd);
      if (ym === thisYM) {
        submittedThis++;
        const st = statusOf(app);
        if (st.includes("approv")) approvedThis++;
        else if (st.includes("declin") || st.includes("reject") || st.includes("denied")) declinedThis++;
        else pendingThis++;
      } else if (ym === lastYM) {
        submittedLast++;
      }
    }

    // --- 4. Upsert the hub snapshot (ffl.applications) ---
    const apiKey = hubKey();
    let snapshotOk = false;
    if (apiKey) {
      const snapRes = await fetch(`${hubBase()}/api/v1/agent/snapshots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          metricKey: "ffl.applications",
          value: submittedThis,
          unit: "count",
          source: "Boom",
          payload: {
            apps_this_month: submittedThis,
            apps_last_month: submittedLast,
            submitted_this_month: submittedThis,
            submitted_last_month: submittedLast,
            approved_this_month: approvedThis,
            declined_this_month: declinedThis,
            pending_this_month: pendingThis,
          },
        }),
      });
      snapshotOk = snapRes.ok;
    }

    const summary =
      `boom-screenings: ${submittedThis} submitted this month ` +
      `(${approvedThis} appr / ${declinedThis} decl / ${pendingThis} pending), ` +
      `${submittedLast} last month — from ${apps.length} apps [auth ${workingMode}]`;
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: snapshotOk ? "ok" : "partial",
      summary,
      needsHuman: !snapshotOk,
    });
    json(res, 200, {
      ok: true,
      auth_mode: workingMode,
      counts: { submittedThis, submittedLast, approvedThis, declinedThis, pendingThis },
      total_apps: apps.length,
      snapshot_written: snapshotOk,
      sample_keys: apps[0] ? Object.keys(apps[0]) : [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `boom-screenings: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
