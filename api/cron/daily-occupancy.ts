/**
 * Daily cron trigger for the FFL Daily Occupancy Counter (Managed Agent #2).
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — recurring,
 * laptop-off runs need an EXTERNAL trigger. This Vercel cron is that trigger.
 *
 * On each fire it (1) creates a Managed Agents session bound to the occupancy
 * agent, environment, and credential vault, then (2) sends a `user.message`
 * event to start the daily task. The agent runs entirely on Anthropic's cloud
 * (no laptop) and writes FFL occupancy (B4/F4/G4) into the Company Numbers sheet.
 *
 * AI OPERATING SYSTEM: after kicking off, this cron posts a best-effort
 * run-status report to ffl-crm /api/v1/agent/run-status (agentKey 'occupancy') so the
 * Operating System dashboard + Ruckus can see the morning pipeline fired. The
 * heartbeat is best-effort: a failure to report NEVER affects the actual run.
 *
 * WRITER-ONLY / staggered (project: daily-tab ownership): this agent does NOT
 * create the day's tab. The Sales Daily Lead Counter is the interim "tab steward"
 * and creates it at 6:00 AM CT; this cron fires at 6:10 AM CT so the tab already
 * exists. If the tab is missing, the agent STOPs and reports (it never creates).
 *
 * The session is created WITHOUT pinning a version, so it always runs the agent's
 * current active version (v2 = writer-only, get_ffl_occupancy → B4/F4/G4).
 *
 * Schedule: see vercel.json (`10 11 * * *` UTC = 6:10 AM America/Chicago in CDT).
 * NOTE Vercel crons are UTC-only — in CST (Nov–Mar) this lands at 5:10 AM CT.
 *
 * Auth: when CRON_SECRET is set in Vercel env, Vercel includes
 * `Authorization: Bearer <CRON_SECRET>` on cron invocations; we require it.
 *
 * Secrets (ALL placed by Mo in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY        — key with Managed Agents access (shared)
 *   FFL_OCCUPANCY_AGENT_ID   — agent_015XERb8X96E2JiXpKrWrdEn (the occupancy agent)
 *   FFL_ENVIRONMENT_ID       — env_01JaER…hnr6GA  (ffl-agents, shared)
 *   FFL_VAULT_ID             — vlt_011CbdGFbUSSxVsDm7Mymq77  (ffl-mcp, shared)
 *   CRON_SECRET              — random string; gates this endpoint (shared)
 *   FFL_OCCUPANCY_PROMPT     — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY    — ffl-crm API key (ffl_live_...) with agent:write; reports run-status
 *   AGENT_OS_BASE_URL        — optional; ffl-crm base for the run-status report (default https://crm.vestlaunch.com)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun, shouldSkipRedundantKickoff } from "../workforce-hub";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "occupancy";

const DEFAULT_PROMPT = [
  "Run your full daily FFL update for today (America/Chicago) — ALL FIVE items",
  "still missing per your A50 status: occupancy (row 4), renewals (row 9 + H28/H29),",
  "delinquency (row 14), apps & leases (row 23), and the huddle notes (H40/H41).",
  "Confirm today's tab (M.D.2026) ALREADY EXISTS; do NOT create it — if missing,",
  "STOP and report. Follow your system prompt exactly: gates, clear-on-error,",
  "verbatim notes block, A50 flags. Read back what you wrote and report which items",
  "were filled, skipped (already done), or failed.",
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
  const agentId = process.env.FFL_OCCUPANCY_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_OCCUPANCY_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_OCCUPANCY_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `occupancy: missing env ${missing.join(", ")}`, needsHuman: true });
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
      title: `FFL daily occupancy ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `occupancy: create_session failed (HTTP ${createRes.status})`, needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "occupancy: create_session returned no id", needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `occupancy: send_event failed (HTTP ${eventRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `occupancy agent triggered for ${today} (session ${sessionId})` });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `occupancy: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
