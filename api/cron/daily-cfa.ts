/**
 * Daily cron trigger for the FFL CFA Daily Numbers agent (ResMan / Cranbrook Forest).
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — this Vercel cron is
 * the external trigger. On each fire it (1) creates a Managed Agents session bound
 * to the CFA agent, environment, and credential vault, then (2) sends a
 * `user.message` event to start the daily task.
 *
 * PIPELINE ORDER (why 6:30 AM CT): the VPS ResMan fetcher runs 5:15/5:50 AM CT and
 * pushes Cranbrook data to ffl-crm; the Sales agent creates the day's tab at 6:00;
 * Agent #2 (6:10) and ShowMojo (6:20) fill the FFL rows; THIS agent reads
 * get_cfa_numbers and fills CFA rows 5/10/15 at 6:30 (+ retries). The agent's own
 * stale-gate refuses to write if the fetcher data isn't from today.
 *
 * WRITER-ONLY: the agent never creates the tab; if missing it stops and reports.
 * Idempotent via status cell A55 — retry fires are harmless.
 *
 * Schedule: see vercel.json (11:30/11:50/12:10 UTC = 6:30/6:50/7:10 AM CT in CDT).
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` (Vercel includes it on cron
 * invocations when CRON_SECRET is set).
 *
 * Secrets (ALL placed in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY   — key with Managed Agents access (shared)
 *   FFL_CFA_AGENT_ID    — agent_019VLn9nhFmWrDNsasKfChMq (FFL CFA Daily Numbers)
 *   FFL_ENVIRONMENT_ID  — ffl-agents (shared)
 *   FFL_VAULT_ID        — ffl-mcp (shared)
 *   CRON_SECRET         — gates this endpoint (shared)
 *   FFL_CFA_PROMPT      — optional; overrides the default kickoff message
 *
 * ⚠️ ROUTING RULE: this file does NOT auto-route. It is imported + routed in
 * server.ts AND listed in /health (done in the same PR that added this file).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_PROMPT = [
  "Run your daily CFA update for today (America/Chicago).",
  "Call your get_cfa_numbers tool ONCE (no arguments) — do NOT compute anything yourself.",
  "Confirm today's tab (M.D.2026) ALREADY EXISTS in the Company Numbers sheet; do NOT",
  "create it — if it is missing, STOP and report. Check your status cell A55 first and",
  "stop if today is already done. Apply every gate: if stale=true write NOTHING and",
  "alert; skip null cells. Then write your cells per your write recipe (B5/F5/G5/H5,",
  "B10:F10, B15 and D15 — never C15/E15/F15) plus status A55. Read back everything you",
  "wrote and report exactly what was written and skipped.",
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentId = process.env.FFL_CFA_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_CFA_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_CFA_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
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
      title: `FFL CFA daily numbers ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
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
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, 500, { ok: false, error: msg });
  }
}
