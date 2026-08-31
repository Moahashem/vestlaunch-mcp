/**
 * AI Workforce Hub — run-status reporter (shared by the daily cron triggers).
 *
 * This is the approved health-reporting path for the AI Operating System. Each
 * daily cron, after it kicks off (or fails to kick off) its Managed Agent,
 * reports one run-status row into the ffl-crm hub:
 *
 *     POST <base>/api/v1/agent/run-status   (Bearer per-agent API key)
 *
 * It SUPERSEDES the older, off-pattern `/api/agent-os/heartbeat` call (which used
 * CRON_SECRET on a bespoke route the CRM middleware blocks). The hub route is the
 * single approved run-status home; Ruckus reads it to flag silent morning
 * failures, and the Mission Control page (Step 5) reads the same table.
 *
 * Best-effort by design: a reporting failure (or missing key) NEVER throws and
 * never affects the actual agent kickoff. If no API key is configured it is a
 * silent no-op — exactly like the old heartbeat skipped when CRON_SECRET was
 * unset — so deploying this is inert until Mo sets FFL_WORKFORCE_API_KEY.
 *
 * Env (set in Vercel — never hard-coded):
 *   FFL_WORKFORCE_API_KEY  — an ffl-crm API key (ffl_live_...) with the
 *                            agent:write scope. Preferred. Falls back to
 *                            VESTLAUNCH_API_KEY if that is the write-scoped key.
 *   VESTLAUNCH_BASE_URL    — ffl-crm base, no trailing slash
 *                            (default https://crm.vestlaunch.com). AGENT_OS_BASE_URL
 *                            is still honored as a fallback for continuity.
 */

/** The run-status values the hub accepts (see ffl-crm /api/v1/agent/run-status). */
export type WorkforceRunStatus = "ok" | "failed" | "partial";

export interface AgentRunReport {
  /** Stable agent identifier, e.g. "sales-lead-count", "occupancy". */
  agentKey: string;
  /** ok | failed | partial. */
  status: WorkforceRunStatus;
  /** One-line human summary for the morning brief / dashboard. */
  summary: string;
  /** True if a human needs to look (surfaces in Ruckus's brief). */
  needsHuman?: boolean;
  /** Autonomy tier hint; defaults to "green". */
  tier?: string;
  /** Optional kickoff duration in ms. */
  durationMs?: number;
  /** Optional machine error detail (kept out of `summary`). */
  errorMessage?: string;
}

/** Resolve the ffl-crm base URL (no trailing slash). */
function hubBaseUrl(): string {
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  const legacy = (process.env.AGENT_OS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (legacy) return legacy;
  return "https://crm.vestlaunch.com";
}

/** Resolve the per-agent API key (Bearer) used to write to the hub. */
function hubApiKey(): string {
  const primary = (process.env.FFL_WORKFORCE_API_KEY ?? "").trim();
  if (primary) return primary;
  return (process.env.VESTLAUNCH_API_KEY ?? "").trim();
}

/**
 * Report one run-status row to the AI Workforce hub. Best-effort: never throws.
 * No-op (returns silently) when no API key is configured.
 */
export async function logAgentRun(report: AgentRunReport): Promise<void> {
  const apiKey = hubApiKey();
  if (!apiKey) return; // inert until a key is set — never breaks the run

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(`${hubBaseUrl()}/api/v1/agent/run-status`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentKey: report.agentKey,
        status: report.status,
        summary: report.summary,
        needsHuman: report.needsHuman ?? false,
        tier: report.tier ?? "green",
        durationMs: report.durationMs,
        errorMessage: report.errorMessage,
      }),
      signal: controller.signal,
    });
  } catch {
    // swallow — run-status reporting is best-effort
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Spend guard — skip redundant retry kickoffs (v2: completion-aware)
// ---------------------------------------------------------------------------
//
// Most daily crons have several schedule slots (see vercel.json): the first is
// the real run, the rest are RETRY slots. Every slot used to wake a full
// Managed Agent session even when the day's work was already done — the agent
// woke, read the sheet, said "already done", and billed us anyway.
//
// v1 of this guard (PR #78) counted successful KICKOFFS and skipped after two.
// That conflated "the session started" with "the work got done": on 8/30 and
// 8/31/2026 both morning occupancy sessions ended with renewals/delinquency
// still at "-", and the guard then suppressed all five retry slots — including
// the late slots that write the alert cells. The sheet stayed silently blank
// (see project doc appfolio-agent-row-skips-2026-08-31).
//
// v2 semantics — the completion marker is the ONLY thing that fully stands
// down the retry ladder:
//   1. If a "WORK COMPLETE" run-status row exists for this agentKey today
//      (America/Chicago), every remaining slot skips. Agents write that row
//      via the report_run_complete MCP tool as their LAST daily action.
//   2. With NO completion marker, slots inside the HEAL WINDOW (the final
//      schedule slots, compared in UTC because vercel.json crons are UTC)
//      ALWAYS run — they are the retry + alert pass that catches a morning
//      session that died or gave up on a row.
//   3. Before the heal window, the old rule stands: skip after 2 successful
//      kickoffs (the real run + one verification wake).
//
// Fail-open by design: if the hub can't be read (missing key, missing
// agent:read scope, network), we return false and the kickoff proceeds exactly
// as before this guard existed. A guard must never be the reason a worker
// didn't run.

/** Summary prefix that marks an agent's daily scope as fully done. */
export const WORK_COMPLETE_PREFIX = "WORK COMPLETE";

/** Today's date in America/Chicago as YYYY-MM-DD. */
function chicagoDateString(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Write the completion marker for an agent's daily scope. Called by the
 * report_run_complete MCP tool once EVERY item in the agent's scope is done
 * for today (filled now, or verified already done). Best-effort like all hub
 * reporting — never throws.
 */
export async function reportWorkComplete(agentKey: string, detail?: string): Promise<void> {
  const trimmed = (detail ?? "").trim().slice(0, 300);
  await logAgentRun({
    agentKey,
    status: "ok",
    summary: `${WORK_COMPLETE_PREFIX} ${chicagoDateString()}${trimmed ? `: ${trimmed}` : ""}`,
  });
}

/** ISO timestamp for the most recent midnight in America/Chicago. */
function startOfTodayChicagoISO(): string {
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
  return new Date(now.getTime() - secondsSinceMidnight * 1000).toISOString();
}

export interface SpendGuardOptions {
  /**
   * Start of this cron's heal window as minutes-since-midnight UTC (UTC because
   * the vercel.json schedules are UTC-fixed). Slots firing at/after this time
   * NEVER skip unless the day's work is confirmed complete. Set it just before
   * the cron's final schedule slot(s). Default 12*60+45 (12:45 UTC) protects the
   * 12:50/13:00 slots of the occupancy/showmojo ladders.
   */
  healWindowStartUtcMinutes?: number;
}

/**
 * True when this slot's kickoff is redundant:
 *   - the agent already reported WORK COMPLETE today, or
 *   - we are before the heal window and 2+ kickoffs already succeeded today.
 * False (fail-open) on any read problem.
 */
export async function shouldSkipRedundantKickoff(
  agentKey: string,
  opts?: SpendGuardOptions,
): Promise<boolean> {
  const apiKey = hubApiKey();
  if (!apiKey) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url =
      `${hubBaseUrl()}/api/v1/agent/run-status?agentKey=${encodeURIComponent(agentKey)}` +
      `&status=ok&since=${encodeURIComponent(startOfTodayChicagoISO())}&limit=20`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return false; // 403 (no agent:read) or anything else → fail open
    const body = (await res.json()) as { data?: Array<{ summary?: unknown }> };
    const rows = Array.isArray(body?.data) ? body.data : [];

    // 1. Confirmed complete → every remaining slot is redundant.
    const workComplete = rows.some(
      (r) => typeof r?.summary === "string" && r.summary.startsWith(WORK_COMPLETE_PREFIX),
    );
    if (workComplete) return true;

    // 2. Not confirmed complete: the heal window (final slots) always runs —
    //    it is the retry + alert pass for a morning session that died mid-run.
    const now = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const healStart = opts?.healWindowStartUtcMinutes ?? 12 * 60 + 45;
    if (utcMinutes >= healStart) return false;

    // 3. Early slots: real run + one verification wake, then skip.
    return rows.length >= 2;
  } catch {
    return false; // fail open — never block a run because the guard errored
  } finally {
    clearTimeout(timer);
  }
}
