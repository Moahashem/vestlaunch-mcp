/**
 * Daily cron trigger for the FFL Owner Onboarding Tracker.
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — recurring,
 * laptop-off runs need an EXTERNAL trigger. This Vercel cron is that trigger.
 *
 * Fills the Owner Onboarding block of the Company Numbers sheet: one row per
 * owner-property, from the day the agreement is signed until the property is
 * RENTED (removed the day after). Phase 5 of the White Glove Onboarding
 * blueprint — "no single status view of where each new client is in onboarding"
 * was gap #10 in that doc and went unbuilt for a year.
 *
 * WRITER-ONLY / staggered: this agent does NOT create the day's tab. The Sales
 * Daily Lead Counter is the tab steward and creates it at 6:00 AM CT. This cron
 * fires LAST in the morning chain (6:50 AM CT + retries to 7:50) so the tab and
 * every other block already exist. If the tab is missing the agent STOPs and
 * reports. Idempotent via its own status cell A93, so retries only re-attempt
 * work that actually failed.
 *
 * BLOCK PLACEMENT: rows 61-91 plus A93/A94/A95, deliberately BELOW the existing
 * status ledger at rows 47-59. The onboarding block was specced for row 49 with
 * the ledger relocated to 82+, but that migration means editing five live agent
 * prompts in one window; parking the block in empty space below ships the same
 * information with zero risk to the existing morning run. Moving it up is a
 * cosmetic follow-up, not a functional one.
 *
 * AI OPERATING SYSTEM: after kickoff, posts a best-effort run-status report to
 * ffl-crm /api/v1/agent/run-status (agentKey 'onboarding'). Best-effort: never
 * breaks the run.
 *
 * Schedule: see vercel.json (`50 11 * * *` UTC = 6:50 AM America/Chicago in CDT,
 * with retries at 7:20 and 7:50). NOTE Vercel crons are UTC-only — in CST
 * (Nov–Mar) these land an hour earlier in local time.
 *
 * Secrets / config (Vercel env):
 *   ANTHROPIC_API_KEY          — key with Managed Agents access (shared)
 *   FFL_ENVIRONMENT_ID         — env_01JaER…hnr6GA  (ffl-agents, shared)
 *   FFL_VAULT_ID               — vlt_011CbdGFbUSSxVsDm7Mymq77  (ffl-mcp, shared)
 *   CRON_SECRET                — random string; gates this endpoint (shared)
 *   FFL_ONBOARDING_AGENT_ID    — OPTIONAL. Defaults to the agent created
 *                                2026-08-04 (see DEFAULT_AGENT_ID). An agent id
 *                                is an identifier, not a secret, so defaulting it
 *                                means this cron works the morning it ships
 *                                without waiting on a Vercel env edit. Set the
 *                                env var to point at a different agent.
 *   FFL_ONBOARDING_PROMPT      — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY      — ffl-crm API key with agent:write; reports run-status
 *   AGENT_OS_BASE_URL          — optional; ffl-crm base (default https://crm.vestlaunch.com)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun } from "../workforce-hub";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "onboarding";

/** FFL Owner Onboarding Tracker, created 2026-08-04. Override with FFL_ONBOARDING_AGENT_ID. */
const DEFAULT_AGENT_ID = "agent_01RzwVEvhrWQ7grSGtpwvRy8";

const DEFAULT_PROMPT = [
  "Run your daily Owner Onboarding block update for today (America/Chicago).",
  "Call your get_ffl_onboarding tool ONCE (no arguments) — do NOT compute or",
  "re-sort anything yourself; the roster arrives finished and pre-sorted worst-first.",
  "Confirm today's tab (M.D.2026, no zero padding) ALREADY EXISTS in the Company",
  "Numbers sheet; do NOT create it — if it is missing, STOP and report. Read your",
  "status cell A93 FIRST: if it already shows roster=done for today, stop (nothing",
  "to do). Otherwise write A61 (the title line with in_flight and stalled_count),",
  "the row 62 headers, one row per roster entry across A63:K90 in the order given,",
  "and A91 (the overflow line, or blank when 28 rows or fewer). BLANK any unused",
  "rows through row 90 — today's tab is a copy of yesterday's, so stale owners",
  "would otherwise linger. HONOR THE SOURCE GATES: if sources.showmojo_ok is false",
  "leave column H alone entirely, and if sources.rent_roll_ok is false leave column",
  "J alone — a blank there would read as 'nothing is listed / nothing is rented',",
  "which is worse than no answer. Then set A93 to roster=done, read the block back,",
  "and report what you wrote. If the tool fails, write nothing, leave A93 not-done",
  "for the next retry, and report the failure clearly.",
].join(" ");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // --- Gate the endpoint (Vercel cron sends Bearer <CRON_SECRET>) ---
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentId = process.env.FFL_ONBOARDING_AGENT_ID?.trim() || DEFAULT_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_ONBOARDING_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `onboarding: missing env ${missing.join(", ")}`, needsHuman: true });
    json(res, 500, { ok: false, error: `Missing env: ${missing.join(", ")}` });
    return;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey as string,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date());

  try {
    // --- 1. Create the session ---
    const sessionBody: Record<string, unknown> = {
      agent: agentId,
      environment_id: environmentId,
      title: `FFL owner onboarding ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `onboarding: create_session failed (HTTP ${createRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "create_session",
        status: createRes.status,
        body: createText.slice(0, 1000),
      });
      return;
    }
    const session = JSON.parse(createText) as { id?: string };
    const sessionId = session.id;
    if (!sessionId) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "onboarding: create_session returned no id", needsHuman: true });
      json(res, 502, { ok: false, stage: "create_session", error: "no session id", body: createText.slice(0, 1000) });
      return;
    }

    // --- 2. Send the kickoff user.message to start the work ---
    const eventRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      }),
    });
    const eventText = await eventRes.text();
    if (!eventRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `onboarding: send_event failed (HTTP ${eventRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `onboarding agent triggered for ${today} (session ${sessionId})` });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `onboarding: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
