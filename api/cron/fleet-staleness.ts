/**
 * Fleet staleness guard — the daily "did the morning fleet actually finish?"
 * backstop (open issue #10 in the morning-numbers architecture doc; built
 * 2026-08-31 after the 8/30–8/31 silent Renewals/Delinquency blanks).
 *
 * Fires ONCE per day at 13:10 UTC — ten minutes after the last retry slot of
 * the morning ladder (13:00 UTC), year-round, because the whole ladder is
 * UTC-fixed. For each daily sheet agent it reads today's run-status rows from
 * the workforce hub and decides:
 *
 *   1. NEVER KICKED OFF — zero ok kickoff rows today. Catches a cron that
 *      silently stopped firing (bad vercel.json/server.ts registration, env
 *      missing, Anthropic API failures on every slot). Works from day one.
 *   2. FAILED ROWS — any failed run-status row today and no completion.
 *      Works from day one.
 *   3. NO COMPLETION — the agent is "completion-enabled" (it has written at
 *      least one WORK COMPLETE row in the last 7 days) but has none today.
 *      Self-calibrating: silent for an agent until its prompt starts calling
 *      report_run_complete, then guards it forever after. This is the check
 *      that would have caught 8/30 and 8/31 the same morning.
 *
 * Alert path: one message into Ruckus's RingCentral channel via ffl-crm
 * POST /api/ringcentral/ruckus-send (Bearer RUCKUS_SEND_TOKEN — same token
 * ruckus-mcp documents). Best-effort; whatever happens, a run-status row is
 * logged (agentKey 'fleet-staleness', needsHuman when alerts exist) so the
 * Mission Control page and the next Ruckus brief see it even if RingCentral
 * delivery failed.
 *
 * This endpoint only READS the hub and posts a chat message — it never touches
 * the sheet and never starts agent sessions.
 *
 * Env (Vercel):
 *   CRON_SECRET            — gates this endpoint (same as the other crons)
 *   FFL_WORKFORCE_API_KEY  — hub read/write (agent:read + agent:write)
 *   RUCKUS_SEND_TOKEN      — optional; enables the RingCentral message
 *   VESTLAUNCH_BASE_URL    — ffl-crm base (default https://crm.vestlaunch.com)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun, WORK_COMPLETE_PREFIX } from "../workforce-hub";

export const config = { maxDuration: 60 };

const AGENT_KEY = "fleet-staleness";

/** The six daily Company Numbers agents this guard watches. */
export const WATCHED_AGENT_KEYS = [
  "sales-lead-count",
  "occupancy",
  "showmojo",
  "cranbrook-cfa",
  "cranbrook-cf-leads",
  "onboarding",
] as const;

/**
 * Agents that ALWAYS report WORK COMPLETE (all six call report_run_complete
 * since Sep 2026). For these the guard no longer self-calibrates from the last
 * 7 days: before 2026-10-26 a week-long outage would have silenced the guard on
 * day 8, because "completion-enabled" was inferred from a completion row inside
 * the 7-day window. (Found after the 10/24–10/26 Cranbrook 403 outage.)
 */
export const COMPLETION_REQUIRED: ReadonlySet<string> = new Set(WATCHED_AGENT_KEYS);

/** Plain-words name of each agent's part of the Company Numbers sheet (Mo reads these). */
export const AGENT_LABELS: Record<string, string> = {
  "sales-lead-count": "FFL sales numbers (rows 26–29)",
  occupancy: "FFL AppFolio numbers (occupancy, renewals, delinquency)",
  showmojo: "FFL ShowMojo listings (row 20, A40–A44)",
  "cranbrook-cfa": "Cranbrook ResMan numbers (rows 5, 10, 15, 16, 37, 38)",
  "cranbrook-cf-leads": "Cranbrook leads (row 35)",
  onboarding: "owner onboarding roster (rows 49–79)",
};

interface HubRun {
  status?: unknown;
  summary?: unknown;
  ranAt?: unknown;
}

export interface AgentVerdict {
  agentKey: string;
  kickoffsToday: number;
  failedToday: number;
  completeToday: boolean;
  completionEnabled: boolean;
  /** Consecutive days BEFORE today with no WORK COMPLETE (0 = yesterday was fine). Capped at 6. */
  missedDaysBefore: number;
  alert: string | null;
}

/** YYYY-MM-DD of an instant in America/Chicago. */
export function chicagoDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Consecutive Chicago days immediately before `now`'s day with no WORK
 * COMPLETE row in `weekRows`. Days are walked back one at a time (noon-anchored
 * so a DST change can't skip or repeat a day), up to 6.
 */
export function countMissedDaysBefore(weekRows: HubRun[], now: Date = new Date()): number {
  const completeDays = new Set<string>();
  for (const r of weekRows) {
    if (typeof r.summary !== "string" || !r.summary.startsWith(WORK_COMPLETE_PREFIX)) continue;
    const t = typeof r.ranAt === "string" || r.ranAt instanceof Date ? new Date(r.ranAt as string) : null;
    if (t && !Number.isNaN(t.getTime())) completeDays.add(chicagoDay(t));
  }
  const today = chicagoDay(now);
  // Noon on today's Chicago date, expressed in UTC (Chicago is UTC-5/-6, so 17:00Z is always that day's daytime).
  const anchor = new Date(`${today}T17:00:00Z`);
  let missed = 0;
  for (let i = 1; i <= 6; i++) {
    const day = chicagoDay(new Date(anchor.getTime() - i * 24 * 3600 * 1000));
    if (completeDays.has(day)) break;
    missed++;
  }
  return missed;
}

/**
 * Pure decision logic (unit-tested): classify one agent's day from its hub
 * rows. `todayRows` = all rows since local midnight; `weekRows` = rows for the
 * last 7 days (completion detection for non-required agents + the missed-day streak).
 */
export function judgeAgent(
  agentKey: string,
  todayRows: HubRun[],
  weekRows: HubRun[],
  now: Date = new Date(),
): AgentVerdict {
  const isComplete = (r: HubRun) =>
    typeof r.summary === "string" && r.summary.startsWith(WORK_COMPLETE_PREFIX);
  const okToday = todayRows.filter((r) => r.status === "ok");
  const failedToday = todayRows.filter((r) => r.status === "failed").length;
  const completeToday = todayRows.some(isComplete);
  const completionEnabled = COMPLETION_REQUIRED.has(agentKey) || weekRows.some(isComplete);
  const missedDaysBefore = countMissedDaysBefore(weekRows, now);

  const label = AGENT_LABELS[agentKey] ? `${AGENT_LABELS[agentKey]} [${agentKey}]` : agentKey;
  const streak = missedDaysBefore > 0
    ? ` — ${missedDaysBefore + 1} days in a row${missedDaysBefore >= 6 ? " or more" : ""}`
    : "";

  let alert: string | null = null;
  if (okToday.length === 0) {
    alert = `${label}: NEVER KICKED OFF today (no ok run-status rows) — check the Vercel cron${completeToday ? "" : streak}`;
  } else if (!completeToday && failedToday > 0) {
    alert = `${label}: ${failedToday} failed run(s) today and no ${WORK_COMPLETE_PREFIX} — check the sheet rows${streak}`;
  } else if (!completeToday && completionEnabled) {
    alert = `${label}: no ${WORK_COMPLETE_PREFIX} today (retry window closed) — its sheet rows are probably blank${streak}`;
  }

  return {
    agentKey,
    kickoffsToday: okToday.length,
    failedToday,
    completeToday,
    completionEnabled,
    missedDaysBefore,
    alert,
  };
}

function hubBaseUrl(): string {
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  const legacy = (process.env.AGENT_OS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (legacy) return legacy;
  return "https://crm.vestlaunch.com";
}

function hubApiKey(): string {
  const primary = (process.env.FFL_WORKFORCE_API_KEY ?? "").trim();
  if (primary) return primary;
  return (process.env.VESTLAUNCH_API_KEY ?? "").trim();
}

/** ISO timestamp for midnight America/Chicago, minus `daysBack` days. */
function chicagoMidnightISO(daysBack = 0): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) =>
    Number.parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  const secondsSinceMidnight = (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");
  return new Date(
    now.getTime() - secondsSinceMidnight * 1000 - daysBack * 24 * 3600 * 1000,
  ).toISOString();
}

async function fetchRuns(agentKey: string, sinceISO: string): Promise<HubRun[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url =
      `${hubBaseUrl()}/api/v1/agent/run-status?agentKey=${encodeURIComponent(agentKey)}` +
      `&since=${encodeURIComponent(sinceISO)}&limit=50`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${hubApiKey()}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`hub run-status HTTP ${res.status}`);
    const body = (await res.json()) as { data?: HubRun[] };
    return Array.isArray(body?.data) ? body.data : [];
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort RingCentral message via ffl-crm ruckus-send. Never throws. */
async function sendRingCentral(text: string): Promise<{ sent: boolean; detail?: string }> {
  const token = (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!token) return { sent: false, detail: "RUCKUS_SEND_TOKEN not set" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${hubBaseUrl()}/api/ringcentral/ruckus-send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Main channel (Mo + Yuliana) hears both businesses; say so explicitly so the
      // chat policy never holds a Cranbrook line.
      body: JSON.stringify({ text, chat: "main", business: ["ffl", "cranbrook"] }),
      signal: controller.signal,
    });
    let body: { ok?: unknown; held?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON reply — judge by status alone */
    }
    if (body.held === true) {
      return { sent: false, detail: `held by chat policy: ${String(body.error ?? "")}`.slice(0, 200) };
    }
    if (!res.ok || body.ok === false) {
      return { sent: false, detail: `HTTP ${res.status}${body.error ? ` ${String(body.error)}` : ""}`.slice(0, 200) };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** The RingCentral text (pure; unit-tested). Plain words first, the technical detail after. */
export function composeAlert(problems: string[]): string {
  return [
    `🔴 Morning numbers: ${problems.length === 1 ? "one part" : `${problems.length} parts`} of today's Company Numbers sheet did not fill in.`,
    ...problems.map((p) => `• ${p}`),
    "The sheet's alert cells (A100–A122) say why. Mission Control: https://crm.vestlaunch.com/agent-os/daily",
  ].join("\n");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  if (!hubApiKey()) {
    json(res, 500, { ok: false, error: "FFL_WORKFORCE_API_KEY not set — guard cannot read the hub" });
    return;
  }

  const today = chicagoMidnightISO(0);
  const weekAgo = chicagoMidnightISO(7);
  const verdicts: AgentVerdict[] = [];
  const readErrors: string[] = [];

  for (const key of WATCHED_AGENT_KEYS) {
    try {
      const [todayRows, weekRows] = await Promise.all([
        fetchRuns(key, today),
        fetchRuns(key, weekAgo),
      ]);
      verdicts.push(judgeAgent(key, todayRows, weekRows));
    } catch (err) {
      // A hub read failure is itself a finding — surface it, don't guess.
      readErrors.push(`${key}: hub read failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const alerts = verdicts.map((v) => v.alert).filter((a): a is string => a !== null);
  const problems = [...alerts, ...readErrors];

  let rc: { sent: boolean; detail?: string } = { sent: false, detail: "no alerts" };
  if (problems.length > 0) {
    rc = await sendRingCentral(composeAlert(problems));
    const delivery = rc.sent ? "RingCentral: posted to main chat" : `RingCentral: NOT delivered (${rc.detail ?? "unknown"})`;
    console.log(`[fleet-staleness] ${problems.length} problem(s); ${delivery}`);
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "failed",
      // Red, not the default green: a blank section of the morning sheet is a
      // human-needed failure (the 10/24–10/26 alerts were logged green and sat unseen).
      tier: "red",
      summary: `fleet-staleness: ${problems.length} problem(s): ${problems.join(" | ").slice(0, 560)} · ${delivery}`.slice(0, 700),
      errorMessage: rc.sent ? undefined : delivery,
      needsHuman: true,
    });
  } else {
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "ok",
      summary: `fleet-staleness: all ${verdicts.length} agents healthy (${verdicts.filter((v) => v.completeToday).length} confirmed complete)`,
    });
  }

  json(res, 200, {
    ok: problems.length === 0,
    verdicts,
    readErrors,
    ringcentral: rc,
    checked_at: new Date().toISOString(),
  });
}
