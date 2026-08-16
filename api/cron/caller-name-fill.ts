/**
 * Cron trigger for the FFL Caller Name Fill agent (AppFolio guest cards / LeadSimple → lead names).
 *
 * REPLACES the "Caller name fill" Claude desktop scheduled task (created ~Aug 15,
 * 2026), which ran in the cloud where the desktop bridge — its only path to the
 * AppFolio and LeadSimple MCP tools — is never connected. Every run failed before
 * reading a single guest card and emailed Mo a failure report (3× on Aug 15).
 * This cron moves the job into the AI Workforce fleet: Managed Agents is a
 * runtime, not a scheduler (project D12) — this Vercel cron is the external
 * trigger, and the ffl-agents environment + ffl-mcp vault carry the AppFolio /
 * LeadSimple / CRM access the desktop task never had in the cloud.
 *
 * WHAT THE AGENT DOES (see DEFAULT_PROMPT; overridable via env without a deploy):
 *   1. Find recent phone-only leads — CRM contacts from inbound-call intake whose
 *      name is missing or a placeholder ("Unknown Caller") but that have a phone.
 *   2. Match each phone (digit-normalized) against AppFolio guest cards and
 *      LeadSimple contacts.
 *   3. On a confident match, fill firstName/lastName and add a note naming the
 *      source. NEVER overwrite an existing real name; NEVER touch other fields.
 *   4. Report checked/filled/unmatched counts to run-status.
 *
 * FAIL-CLOSED: if the session lacks AppFolio or LeadSimple access, the agent is
 * instructed to STOP without touching any lead and log a failed run — failures
 * land in the workforce hub (needsHuman) instead of Mo's inbox.
 *
 * AI OPERATING SYSTEM: logs run-status to ffl-crm /api/v1/agent/run-status
 * (agentKey "caller-name-fill") on kickoff and on failures. Best-effort: never
 * breaks the run.
 *
 * Schedule: see vercel.json — 13:18 / 17:18 / 21:18 UTC daily
 * (8:18 AM / 12:18 PM / 4:18 PM CT in CDT), echoing the original task's :18 cadence.
 * Idempotent by construction: an already-named lead is never re-touched, so
 * retry fires are harmless.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` (Vercel includes it on
 * cron invocations when CRON_SECRET is set).
 *
 * Secrets (ALL placed in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY              — key with Managed Agents access (shared)
 *   FFL_CALLER_NAME_FILL_AGENT_ID  — the "FFL Caller Name Fill" Console agent id (Mo creates)
 *   FFL_ENVIRONMENT_ID             — ffl-agents (shared)
 *   FFL_VAULT_ID                   — ffl-mcp (shared)
 *   CRON_SECRET                    — gates this endpoint (shared)
 *   FFL_CALLER_NAME_FILL_PROMPT    — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY          — ffl-crm API key (ffl_live_...) with agent:write; reports run-status
 *   AGENT_OS_BASE_URL              — optional; ffl-crm base for the run-status report (default https://crm.vestlaunch.com)
 *
 * INERT UNTIL CONFIGURED: if FFL_CALLER_NAME_FILL_AGENT_ID is unset, the cron
 * no-ops silently (safe to deploy before the Console agent exists) — same
 * pattern as appfolio-entry's token gate.
 *
 * ⚠️ ROUTING RULE: this file does NOT auto-route. It is imported + routed in
 * server.ts AND listed in /health (done in the same PR that added this file).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun } from "../workforce-hub";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "caller-name-fill";

const DEFAULT_PROMPT = [
  "Run the caller-name fill for today (America/Chicago).",
  "GATE FIRST: confirm you can reach BOTH AppFolio (guest cards) and LeadSimple in this",
  "session. If either is unavailable, STOP immediately — read nothing, change nothing —",
  "and end with a one-line failure report naming the missing tool.",
  "STEP 1 — worklist: in the CRM, find contacts created or last active in the past 14 days",
  "that came from an inbound call (phone-call intake / CallRail / voice) and have a phone",
  "number but a missing or placeholder name (empty firstName/lastName, or 'Unknown',",
  "'Unknown Caller', or a bare phone number stored as the name).",
  "STEP 2 — lookup: for each, match the phone number (compare digits only, ignore",
  "formatting and +1) against AppFolio guest cards first, then LeadSimple contacts.",
  "STEP 3 — fill: only on an exact single-phone match with a real human name, update the",
  "CRM contact's firstName/lastName and add a note: 'Name filled from <AppFolio guest",
  "card|LeadSimple> match on <phone> (caller-name-fill agent)'. NEVER overwrite an",
  "existing real name, NEVER merge contacts, NEVER change any other field, NEVER guess",
  "on ambiguous or multiple matches — skip and count those as unmatched.",
  "STEP 4 — report: end with exact counts — leads checked, names filled, unmatched,",
  "skipped-ambiguous — and list each filled contact as 'phone → name (source)'.",
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
  const agentId = process.env.FFL_CALLER_NAME_FILL_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_CALLER_NAME_FILL_PROMPT?.trim() || DEFAULT_PROMPT;

  // INERT until configured: deploying before the Console agent exists is safe.
  if (!agentId) {
    json(res, 200, { ok: true, skipped: true, reason: "FFL_CALLER_NAME_FILL_AGENT_ID unset — cron inert" });
    return;
  }

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `caller-name-fill: missing env ${missing.join(", ")}`, needsHuman: true });
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
      title: `FFL caller name fill ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `caller-name-fill: create_session failed (HTTP ${createRes.status})`, needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "caller-name-fill: create_session returned no id", needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `caller-name-fill: send_event failed (HTTP ${eventRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `caller-name-fill agent triggered for ${today} (session ${sessionId})` });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `caller-name-fill: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
