/**
 * Daily cron: the FFL Delinquency Agent's morning brief (Phase 1, read-only).
 *
 * company-hq: projects/tech/ffl-2026-delinquency-agent. Reads the smart tool
 * (ffl-crm GET /api/v1/analytics/ffl-delinquency-worklist), formats a brief from
 * the numbers (api/delinquency-brief.ts — pure, unit-tested) and posts it to
 * Ruckus's RingCentral channel. No model in the loop in Phase 1: a summary is
 * arithmetic, and a boring post that lands every morning beats a clever one that
 * stalls (_framework/19). Nothing is sent to any tenant.
 *
 * Schedule: vercel.json `0 12 * * *` UTC = 7:00 AM America/Chicago in CDT (6:00 AM
 * in CST, Nov–Mar), after the Company Numbers chain, with one retry at 12:30 UTC
 * that the spend guard skips when the first run posted.
 *
 * Env (Vercel):
 *   CRON_SECRET             — gates this endpoint (shared)
 *   VESTLAUNCH_BASE_URL     — ffl-crm base (default https://crm.vestlaunch.com)
 *   FFL_WORKFORCE_API_KEY   — ffl-crm key; needs properties:read (falls back to VESTLAUNCH_API_KEY)
 *   RUCKUS_SEND_TOKEN       — bearer for ffl-crm /api/ringcentral/ruckus-send (shared)
 *   DELINQUENCY_BRIEF_DRY_RUN — "1" = compute + return the brief, do not post (for checks)
 *
 * Manual: GET /api/cron/daily-delinquency?date=YYYY-MM-DD&dry=1 (Bearer CRON_SECRET).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchWorklist, formatBrief, formatFailure } from "../delinquency-brief";
import { postToRuckusChannel } from "../recruiting-report";
import { logAgentRun, shouldSkipRedundantKickoff } from "../workforce-hub";

export const config = { maxDuration: 60 };

const AGENT_KEY = "delinquency";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function chicagoToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  const cronSecret = env("CRON_SECRET");
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const dateParam = url.searchParams.get("date") ?? undefined;
  const dry = url.searchParams.get("dry") === "1" || env("DELINQUENCY_BRIEF_DRY_RUN") === "1";
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    json(res, 400, { ok: false, error: "date must be YYYY-MM-DD" });
    return;
  }
  const date = dateParam ?? chicagoToday();

  // Retry slot already covered by a successful post today → stand down.
  // One successful post is the whole job → any later slot today stands down.
  const alreadyPosted = (row: { summary?: string }) => typeof row.summary === "string" && row.summary.includes("posted to Ruckus");
  if (!dateParam && !dry && (await shouldSkipRedundantKickoff(AGENT_KEY, { completionPredicate: alreadyPosted }))) {
    json(res, 200, { ok: true, skipped: "spend guard: already posted today" });
    return;
  }

  const base = env("VESTLAUNCH_BASE_URL") || "https://crm.vestlaunch.com";
  const apiKey = env("FFL_WORKFORCE_API_KEY") || env("VESTLAUNCH_API_KEY");
  if (!apiKey) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "delinquency brief: no API key (FFL_WORKFORCE_API_KEY / VESTLAUNCH_API_KEY)", needsHuman: true });
    json(res, 500, { ok: false, error: "no API key" });
    return;
  }

  let brief: string;
  let late = 0;
  try {
    const payload = await fetchWorklist(base, apiKey, dateParam);
    brief = formatBrief(payload);
    late = payload.rows.filter((r) => !["grace", "resolved"].includes(r.stage)).length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failText = formatFailure(date, msg.slice(0, 160));
    const posted = dry ? { posted: false, error: "dry run" } : await postToRuckusChannel(failText);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `delinquency brief ${date}: ${msg.slice(0, 200)}`, needsHuman: true, durationMs: Date.now() - started, errorMessage: msg });
    json(res, 502, { ok: false, date, error: msg, failure_posted: posted.posted, post_error: posted.error });
    return;
  }

  if (dry) {
    json(res, 200, { ok: true, dry_run: true, date, brief });
    return;
  }

  const posted = await postToRuckusChannel(brief);
  if (!posted.posted) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `delinquency brief ${date}: computed but RingCentral post failed (${posted.error})`, needsHuman: true, durationMs: Date.now() - started });
    json(res, 502, { ok: false, date, error: `post failed: ${posted.error}`, brief });
    return;
  }
  await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `delinquency brief ${date} posted to Ruckus (${late} past grace)`, durationMs: Date.now() - started });
  json(res, 200, { ok: true, date, posted: true, past_grace: late, brief });
}
