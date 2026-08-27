/**
 * Daily cron trigger for the FFL CF Leasing Daily Lead Counter agent (LeadSimple / Cranbrook).
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — this Vercel cron is
 * the external trigger. On each fire it (1) creates a Managed Agents session bound
 * to the CF Leads agent, environment, and credential vault, then (2) sends a
 * `user.message` event to start the daily task.
 *
 * AI OPERATING SYSTEM: after kickoff, posts a best-effort run-status report to ffl-crm
 * /api/v1/agent/run-status (agentKey 'cranbrook-cf-leads') so the dashboard + Ruckus can
 * see the morning pipeline fired. Best-effort: never breaks the run.
 *
 * PIPELINE ORDER (why 6:40 AM CT): the VPS LeadSimple fetcher runs ~5:15-8:15 AM CT and
 * pushes CF lead counts to ffl-crm; the Sales agent creates the day's tab at 6:00;
 * Agent #2 (6:10), ShowMojo (6:20) and CFA (6:30) fill their rows; THIS agent reads
 * get_cf_lead_numbers and fills the CFA Leasing -> Leads row B35:E35 at 6:40 (+ retries).
 * The agent's own stale-gate refuses to write if the fetcher data isn't from today.
 *
 * WRITER-ONLY: the agent never creates the tab; if missing it stops and reports.
 * Idempotent via status cell A58 — retry fires are harmless.
 *
 * Schedule: see vercel.json (11:40/12:00/12:20 UTC = 6:40/7:00/7:20 AM CT in CDT).
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` (Vercel includes it on cron
 * invocations when CRON_SECRET is set).
 *
 * Secrets (ALL placed in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY   — key with Managed Agents access (shared)
 *   FFL_CF_LEADS_AGENT_ID    — the FFL CF Leasing Daily Lead Counter agent id (placed in Vercel env)
 *   FFL_ENVIRONMENT_ID  — ffl-agents (shared)
 *   FFL_VAULT_ID        — ffl-mcp (shared)
 *   CRON_SECRET         — gates this endpoint (shared)
 *   FFL_CF_LEADS_PROMPT      — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY    — ffl-crm API key (ffl_live_...) with agent:write; reports run-status
 *   AGENT_OS_BASE_URL   — optional; ffl-crm base for the run-status report (default https://crm.vestlaunch.com)
 *
 * ⚠️ ROUTING RULE: this file does NOT auto-route. It is imported + routed in
 * server.ts AND listed in /health (done in the same PR that added this file).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun, shouldSkipRedundantKickoff } from "../workforce-hub";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "cranbrook-cf-leads";

const DEFAULT_PROMPT = [
  "Run your daily CF Leasing lead count for today (America/Chicago).",
  "Call your get_cf_lead_numbers tool ONCE (no arguments) — do NOT compute anything yourself.",
  "Confirm today's tab (M.D.2026) ALREADY EXISTS in the Company Numbers sheet; do NOT",
  "create it — if it is missing, STOP and report. Check your status cell A58 first and",
  "stop if today is already done. Apply the gate: if stale=true write NOTHING and",
  "alert in A59. Otherwise write ONLY these cells: this_week→B35, this_month→C35,",
  "last_month→D35, new_30d→E35 — never any other cell — then stamp status A58. Read",
  "back B35:E35 and report exactly what was written and skipped.",
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
  const agentId = process.env.FFL_CF_LEADS_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_CF_LEADS_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_CF_LEADS_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `cranbrook-cf-leads: missing env ${missing.join(", ")}`, needsHuman: true });
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
    const sessionBody: Record<string, unknown> = {
      agent: agentId,
      environment_id: environmentId,
      title: `FFL CF Leasing daily leads ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `cranbrook-cf-leads: create_session failed (HTTP ${createRes.status})`, needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "cranbrook-cf-leads: create_session returned no id", needsHuman: true });
      json(res, 502, { ok: false, stage: "create_session", error: "no session id", body: createText.slice(0, 1000) });
      return;
    }

    const eventRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      }),
    });
    const eventText = await eventRes.text();
    if (!eventRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `cranbrook-cf-leads: send_event failed (HTTP ${eventRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `cranbrook-cf-leads agent triggered for ${today} (session ${sessionId})` });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `cranbrook-cf-leads: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
