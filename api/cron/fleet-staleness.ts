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
  alert: string | null;
}

/**
 * Pure decision logic (unit-tested): classify one agent's day from its hub
 * rows. `todayRows` = all rows since local midnight; `weekRows` = ok rows for
 * the last 7 days (used only to detect completion-enabled agents).
 */
export function judgeAgent(
  agentKey: string,
  todayRows: HubRun[],
  weekRows: HubRun[],
): AgentVerdict {
  const isComplete = (r: HubRun) =>
    typeof r.summary === "string" && r.summary.startsWith(WORK_COMPLETE_PREFIX);
  const okToday = todayRows.filter((r) => r.status === "ok");
  const failedToday = todayRows.filter((r) => r.status === "failed").length;
  const completeToday = todayRows.some(isComplete);
  const completionEnabled = weekRows.some(isComplete);

  let alert: string | null = null;
  if (okToday.length === 0) {
    alert = `${agentKey}: NEVER KICKED OFF today (no ok run-status rows) — check the Vercel cron`;
  } else if (!completeToday && failedToday > 0) {
    alert = `${agentKey}: ${failedToday} failed run(s) today and no ${WORK_COMPLETE_PREFIX} — check the sheet rows`;
  } else if (!completeToday && completionEnabled) {
    alert = `${agentKey}: no ${WORK_COMPLETE_PREFIX} today (retry window closed) — its sheet rows are probably blank`;
  }

  return {
    agentKey,
    kickoffsToday: okToday.length,
    failedToday,
    completeToday,
    completionEnabled,
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
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    return res.ok ? { sent: true } : { sent: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
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
    const msg = [
      "⚠️ FLEET STALENESS GUARD — the morning retry window has closed with problems:",
      ...problems.map((p) => `• ${p}`),
      "Check the Company Numbers sheet status ledger (A100–A122) and /agent-os/daily.",
    ].join("\n");
    rc = await sendRingCentral(msg);
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "failed",
      summary: `fleet-staleness: ${problems.length} problem(s): ${problems.join(" | ").slice(0, 600)}`,
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
