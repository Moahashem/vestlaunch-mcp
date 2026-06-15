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
