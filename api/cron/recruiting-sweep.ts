/**
 * Daily cron trigger for the FFL Recruiting Sweep — CLOUD half (Managed Agent).
 *
 * Managed Agents is a runtime, not a scheduler (D12) — this Vercel cron is the
 * external trigger, modeled 1:1 on daily-lead-count.ts. On each fire it
 * (1) creates a Managed Agents session bound to the recruiting agent, env and
 * vault, then (2) sends the kickoff `user.message`. The agent then runs
 * laptop-off on Anthropic's cloud and does the email half of the recruiting
 * invite sweep via the tools on /api/recruiting-mcp.
 *
 * The BROWSER half (LinkedIn + Indeed) stays on Mo's Mac — no usable API
 * there. The two halves coordinate through the Workforce Hub state
 * (agentKey "recruiting-sweep"), and this cloud half WATCHDOGS the browser
 * half: >3 days without a browser run → the agent emails Mo. That watchdog is
 * the entire reason the sweep was split (the 11-day silent gap of 2026-08).
 *
 * The kickoff prompt itself lives in ./_recruiting-sweep-prompt (split out
 * 2026-09-09 so its stage list can be unit-tested). Stages: sweep → invite →
 * watchdog → state → TestGorilla → NUDGE PASS → report.
 *
 * Schedule: 11:50 UTC = 6:50 AM CT (CDT), after the 6:00–6:40 fleet, with a
 * 12:10 UTC retry (idempotent — the send tool's per-day log makes duplicate
 * emails impossible across retries).
 *
 * Auth: CRON_SECRET Bearer, same as every other cron here.
 *
 * Secrets (ALL placed by Mo in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY        — key with Managed Agents access (already set)
 *   RECRUITING_AGENT_ID      — the recruiting Managed Agent's agent_… id
 *   FFL_ENVIRONMENT_ID       — env ffl-agents (already set)
 *   FFL_VAULT_ID             — vault ffl-mcp (already set)
 *   CRON_SECRET              — gates this endpoint (already set)
 *   RECRUITING_DAILY_PROMPT  — optional kickoff-prompt override
 *   FFL_WORKFORCE_API_KEY    — run-status reporting (already set)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun, shouldSkipRedundantKickoff } from "../workforce-hub";
import { postToRuckusChannel } from "../recruiting-report";
import { DEFAULT_PROMPT } from "./_recruiting-sweep-prompt";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "recruiting-sweep";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Failure heartbeat to Mo's RingCentral channel (Mo 2026-08-18): if the run
 * never STARTS, the agent can't post its own report — so this cron says so.
 * The success-side report comes from the agent via report_recruiting_run.
 * Best-effort: postToRuckusChannel never throws.
 */
async function notifyStartFailure(reason: string): Promise<void> {
  await postToRuckusChannel(
    `❌ Recruiting sweep (cloud) did NOT start — ${reason}\n` +
      "- No channels were swept and no invites were sent this fire.\n" +
      "- The 12:10 UTC retry may still succeed; if no ✅/⚠️ report follows, the day was missed.",
  );
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

  // SPEND GUARD: the extra schedule slots for this cron are RETRIES. Two ok
  // kickoffs today (the real run + one verification wake) mean this slot is
  // redundant -- skip it instead of waking (and paying for) another full agent
  // session. Fail-open: any doubt and we run exactly as before. See
  // workforce-hub.ts for semantics.
  if (await shouldSkipRedundantKickoff(AGENT_KEY)) {
    json(res, 200, { ok: true, skipped: "spend guard: already ran ok twice today" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentId = process.env.RECRUITING_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.RECRUITING_DAILY_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["RECRUITING_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "failed",
      summary: `recruiting sweep: missing env ${missing.join(", ")}`,
      needsHuman: true,
    });
    await notifyStartFailure(`missing env ${missing.join(", ")}`);
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
      title: `FFL recruiting sweep (cloud half) ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({
        agentKey: AGENT_KEY,
        status: "failed",
        summary: `recruiting sweep: create_session failed (HTTP ${createRes.status})`,
        needsHuman: true,
      });
      await notifyStartFailure(`could not create the agent session (HTTP ${createRes.status}).`);
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
      await logAgentRun({
        agentKey: AGENT_KEY,
        status: "failed",
        summary: "recruiting sweep: create_session returned no id",
        needsHuman: true,
      });
      await notifyStartFailure("session was created but no session id came back.");
      json(res, 502, {
        ok: false,
        stage: "create_session",
        error: "no session id",
        body: createText.slice(0, 1000),
      });
      return;
    }

    // --- 2. Send the kickoff user.message ---
    const eventRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      }),
    });
    const eventText = await eventRes.text();
    if (!eventRes.ok) {
      await logAgentRun({
        agentKey: AGENT_KEY,
        status: "failed",
        summary: `recruiting sweep: send_event failed (HTTP ${eventRes.status})`,
        needsHuman: true,
      });
      await notifyStartFailure(`session created but the kickoff message failed (HTTP ${eventRes.status}).`);
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "ok",
      summary: `recruiting sweep (cloud half) triggered for ${today} (session ${sessionId})`,
    });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({
      agentKey: AGENT_KEY,
      status: "failed",
      summary: `recruiting sweep: ${msg}`,
      needsHuman: true,
    });
    await notifyStartFailure(msg.slice(0, 300));
    json(res, 500, { ok: false, error: msg });
  }
}
