/**
 * Business-hours cron trigger for the AppFolio Entry Agent (owner-onboarding
 * Phase 3) — fires at :15 past each hour, 13:00–22:00 UTC, Mon–Fri (10×/weekday).
 *
 * Managed Agents is a runtime, not a scheduler — this Vercel cron is the
 * external trigger (same pattern as daily-cfa). But unlike the daily agents,
 * entry work is SPORADIC (~5 signups/month), so this cron is queue-aware:
 *
 *   1. INERT until configured: if APPFOLIO_AGENT_TOKEN is unset here, the
 *      cron no-ops silently (deploying this is safe before Phase 3 goes live).
 *   2. QUEUE PROBE: it claims the oldest PACKET_READY row via the #750 API
 *      (worker "cron-probe") and immediately RELEASEs it. Queue empty → no
 *      Managed Agent session is created (no spend). NOTE: when work EXISTS,
 *      the probe claim appends one history entry to that row (upstream logs
 *      claims); a stuck row accrues one entry per fire until processed —
 *      acceptable for v1, a read-only peek endpoint on ffl-crm would remove
 *      it (TODO, tracked in the plan doc). CRM 503 (its own token unset)
 *      while ours IS set → misconfig, flagged.
 *   3. Only when work exists does it create a session for the AppFolio Entry
 *      Agent and send the kickoff prompt. If the release failed the lease
 *      still self-expires in 30 min, and the kickoff proceeds (the agent may
 *      briefly see an empty queue — harmless, next fire retries).
 *
 * AI OPERATING SYSTEM: logs run-status to the workforce hub (agentKey
 * "appfolio-entry") on kickoff and on failures; silent when idle/unconfigured.
 *
 * ⚠️ KICKOFF RULE (fleet): update DEFAULT_PROMPT whenever the agent's scope
 * grows — success of an old prompt ≠ the new scope is covered.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (Vercel sends it on cron fires).
 *
 * Secrets (ALL in Vercel env — never hard-coded):
 *   APPFOLIO_AGENT_TOKEN     — the dedicated #750 agent bearer (same value as ffl-crm's)
 *   ANTHROPIC_API_KEY        — key with Managed Agents access (shared)
 *   FFL_APPFOLIO_AGENT_ID    — the "AppFolio Entry Agent" Console agent id (Mo creates at wrap)
 *   FFL_ENVIRONMENT_ID       — ffl-agents (shared)
 *   FFL_VAULT_ID             — ffl-mcp (shared)
 *   CRON_SECRET              — gates this endpoint (shared)
 *   FFL_APPFOLIO_PROMPT      — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY    — run-status reporting (shared, best-effort)
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

const AGENT_KEY = "appfolio-entry";
const PROBE_WORKER = "cron-probe";

/** Best-effort alert de-dupe across warm invocations: the same misconfig
 *  outcome alerts the hub at most once per 6h per warm instance (a cold start
 *  may re-alert — acceptable; silence would be worse than repetition). */
const lastAlertAt: Record<string, number> = {};
const ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000;
function shouldAlert(key: string): boolean {
  const now = Date.now();
  const prev = lastAlertAt[key] ?? 0;
  if (now - prev < ALERT_DEDUPE_MS) return false;
  lastAlertAt[key] = now;
  return true;
}

const DEFAULT_PROMPT = [
  "You have AppFolio entry work waiting. Work the queue until it is empty, one row at a time:",
  "(1) appfolio_entry_claim — if claimed is null you are done: report 'queue empty' and stop.",
  "(2) appfolio_entry_packet — read the NON-FINANCIAL packet. You must NEVER enter bank details,",
  "access codes, or credentials; manualEntryRemaining tells accounting what they enter by hand —",
  "mention it in your final note. If taxId.onFile is true, the EXECUTOR fetches and types the",
  "SSN/EIN itself at entry time (audited); the value is never available to you — never ask for it.",
  "In your reviewer note, state whether the executor reported the tax ID as entered (or that it",
  "did not — older executors skip it; accounting then enters it from the §5.5 packet as before).",
  "(3) Validate the packet (address present, owner name/email",
  "present); dispatch the field plan to your executor and review its step screenshots. If the",
  "executor is unreachable or anything mismatches, appfolio_entry_release the row, report exactly",
  "what happened, and stop. (4) When the executor finished and uploaded evidence, call",
  "appfolio_entry_mark_entered with a reviewer note (what was entered + what to double-check).",
  "A HUMAN still verifies every row (ENTERED → VERIFIED) — your job ends at ENTERED. Renew the",
  "lease (appfolio_entry_renew) if an entry runs past ~20 minutes. Then claim the next row.",
].join(" ");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function crmBaseUrl(): string {
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return vest || "https://crm.vestlaunch.com";
}

interface ProbeResult {
  outcome: "work" | "empty" | "crm-unconfigured" | "unauthorized" | "error";
  detail?: string;
  releaseOk?: boolean;
}

/** Claim-then-release probe against the #750 API. Only proves work EXISTS. */
async function probeQueue(token: string): Promise<ProbeResult> {
  const base = crmBaseUrl();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    const claimRes = await fetch(`${base}/api/intake/agent/appfolio/claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worker: PROBE_WORKER }),
      signal: AbortSignal.timeout(15_000),
    });
    if (claimRes.status === 503) return { outcome: "crm-unconfigured" };
    if (claimRes.status === 401) return { outcome: "unauthorized" };
    if (!claimRes.ok) return { outcome: "error", detail: `claim HTTP ${claimRes.status}` };
    const data = (await claimRes.json()) as {
      claimed: { reviewId: string; claimToken: string } | null;
    };
    if (!data.claimed) return { outcome: "empty" };

    // Work exists — hand the row straight back so the agent can claim it.
    let releaseOk = false;
    try {
      const relRes = await fetch(`${base}/api/intake/agent/appfolio/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          reviewId: data.claimed.reviewId,
          claimToken: data.claimed.claimToken,
          worker: PROBE_WORKER,
          action: "RELEASE",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      releaseOk = relRes.ok;
    } catch {
      // lease self-expires in 30 min — safe to proceed either way
    }
    return { outcome: "work", releaseOk };
  } catch (err) {
    return { outcome: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // FAIL CLOSED (adversarial-review fix): unlike the daily read-only crons,
  // this endpoint drives claim/release churn and creates paid agent sessions —
  // an unset CRON_SECRET must not leave it world-callable.
  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (!cronSecret) {
    json(res, 503, { ok: false, error: "CRON_SECRET not configured — endpoint disabled (fail closed)" });
    return;
  }
  if (req.headers["authorization"] !== `Bearer ${cronSecret}`) {
    json(res, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  // 1. Inert until the dedicated agent token is configured HERE.
  const agentToken = (process.env.APPFOLIO_AGENT_TOKEN ?? "").trim();
  if (agentToken.length < 32) {
    json(res, 200, { ok: true, skipped: "APPFOLIO_AGENT_TOKEN not configured — cron is inert" });
    return;
  }

  // 2. Queue-aware probe.
  const probe = await probeQueue(agentToken);
  if (probe.outcome === "empty") {
    json(res, 200, { ok: true, queue: "empty", kicked: false });
    return;
  }
  if (probe.outcome === "crm-unconfigured") {
    if (shouldAlert("crm-unconfigured")) await logAgentRun({
      agentKey: AGENT_KEY, status: "failed", needsHuman: true,
      summary: "appfolio-entry: vestlaunch-mcp has APPFOLIO_AGENT_TOKEN but ffl-crm returned 503 (its env unset) — fix the CRM env",
    });
    json(res, 200, { ok: false, queue: "unknown", error: "CRM agent API fail-closed (503)" });
    return;
  }
  if (probe.outcome === "unauthorized") {
    if (shouldAlert("unauthorized")) await logAgentRun({
      agentKey: AGENT_KEY, status: "failed", needsHuman: true,
      summary: "appfolio-entry: APPFOLIO_AGENT_TOKEN mismatch between vestlaunch-mcp and ffl-crm (401)",
    });
    json(res, 200, { ok: false, queue: "unknown", error: "agent token mismatch (401)" });
    return;
  }
  if (probe.outcome === "error") {
    await logAgentRun({
      agentKey: AGENT_KEY, status: "failed", needsHuman: false,
      summary: `appfolio-entry: queue probe failed (${probe.detail ?? "unknown"}) — will retry next fire`,
    });
    json(res, 200, { ok: false, queue: "unknown", error: probe.detail });
    return;
  }

  // 3. Work exists — kick off the Console agent.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentId = process.env.FFL_APPFOLIO_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_APPFOLIO_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_APPFOLIO_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({
      agentKey: AGENT_KEY, status: "failed", needsHuman: true,
      summary: `appfolio-entry: packets are WAITING but agent kickoff env is missing (${missing.join(", ")})`,
    });
    json(res, 500, { ok: false, queue: "has-work", error: `Missing env: ${missing.join(", ")}` });
    return;
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey as string,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": BETA_HEADER,
    "content-type": "application/json",
  };

  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date());

  try {
    const sessionBody: Record<string, unknown> = {
      agent: agentId,
      environment_id: environmentId,
      title: `AppFolio entry run ${today}`,
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
        agentKey: AGENT_KEY, status: "failed", needsHuman: true,
        summary: `appfolio-entry: create_session failed (HTTP ${createRes.status}) with packets waiting`,
      });
      json(res, 502, { ok: false, stage: "create_session", status: createRes.status, body: createText.slice(0, 1000) });
      return;
    }
    const session = JSON.parse(createText) as { id?: string };
    const sessionId = session.id;
    if (!sessionId) {
      await logAgentRun({
        agentKey: AGENT_KEY, status: "failed", needsHuman: true,
        summary: "appfolio-entry: create_session returned no id",
      });
      json(res, 502, { ok: false, stage: "create_session", error: "no session id", body: createText.slice(0, 1000) });
      return;
    }

    const eventRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions/${sessionId}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }] }),
    });
    const eventText = await eventRes.text();
    if (!eventRes.ok) {
      await logAgentRun({
        agentKey: AGENT_KEY, status: "failed", needsHuman: true,
        summary: `appfolio-entry: send_event failed (HTTP ${eventRes.status}) with packets waiting`,
      });
      json(res, 502, { ok: false, stage: "send_event", session_id: sessionId, status: eventRes.status, body: eventText.slice(0, 1000) });
      return;
    }

    await logAgentRun({
      agentKey: AGENT_KEY, status: "ok",
      summary: `appfolio-entry agent triggered — packets waiting (session ${sessionId}${probe.releaseOk === false ? "; probe lease self-expiring" : ""})`,
    });
    json(res, 200, { ok: true, kicked: true, session_id: sessionId, probe_release_ok: probe.releaseOk ?? null, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", needsHuman: true, summary: `appfolio-entry: ${msg}` });
    json(res, 500, { ok: false, error: msg });
  }
}
