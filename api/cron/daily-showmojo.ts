/**
 * Daily cron trigger for the FFL ShowMojo Agent (the Homes-on-market specialist).
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — recurring,
 * laptop-off runs need an EXTERNAL trigger. This Vercel cron is that trigger.
 *
 * Per D14/D15, the Homes-on-market work (Company Numbers row 20 + the Homes
 * Property-Detail block A40/A41/A43/A44) was split OUT of the AppFolio agent
 * (#2, FFL Daily Occupancy Counter) into this dedicated ShowMojo specialist so
 * ShowMojo becomes a reusable system specialist (later: showings digests,
 * no-showing alerts, vacancy marketing) — not just a row-filler.
 *
 * AI OPERATING SYSTEM: after kickoff, posts a best-effort run-status report to ffl-crm
 * /api/v1/agent/run-status (agentKey 'showmojo') so the dashboard + Ruckus can
 * see the morning pipeline fired. Best-effort: never breaks the run.
 *
 * On each fire it (1) creates a Managed Agents session bound to the ShowMojo
 * agent, the shared environment, and the shared credential vault, then (2)
 * sends a `user.message` event to start the daily task. The agent runs entirely
 * on Anthropic's cloud (no laptop) and writes FFL Homes row 20 (A20/B20/D20/E20,
 * never C20) + the Property-Detail block into the Company Numbers sheet via the
 * existing get_ffl_homes smart tool + the Zapier Google Sheets values:batchUpdate
 * write path.
 *
 * WRITER-ONLY / staggered: this agent does NOT create the day's tab. The Sales
 * Daily Lead Counter is the interim "tab steward" and creates it at 6:00 AM CT;
 * the AppFolio agent runs 6:10 AM CT (+retries); this ShowMojo cron is staggered
 * to fire at 6:20 AM CT (+20-min retries to 8:00 AM) so the tab already exists.
 * If the tab is missing the agent STOPs and reports (it never creates). The
 * agent is idempotent (its A104 status cell): a homes write already done today is
 * skipped, so the later retries only re-attempt a homes row that errored.
 *
 * The session is created WITHOUT pinning a version, so it always runs the agent's
 * current active version.
 *
 * Schedule: see vercel.json (`20 11 * * *` UTC = 6:20 AM America/Chicago in CDT).
 * NOTE Vercel crons are UTC-only — in CST (Nov–Mar) this lands at 5:20 AM CT.
 *
 * Auth: when CRON_SECRET is set in Vercel env, Vercel includes
 * `Authorization: Bearer <CRON_SECRET>` on cron invocations; we require it.
 *
 * Secrets (ALL placed by Mo in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY        — key with Managed Agents access (shared)
 *   FFL_SHOWMOJO_AGENT_ID    — agent_... (the ShowMojo agent; Mo places after create)
 *   FFL_ENVIRONMENT_ID       — env_01JaER…hnr6GA  (ffl-agents, shared)
 *   FFL_VAULT_ID             — vlt_011CbdGFbUSSxVsDm7Mymq77  (ffl-mcp, shared)
 *   CRON_SECRET              — random string; gates this endpoint (shared)
 *   FFL_SHOWMOJO_PROMPT      — optional; overrides the default kickoff message
 *   FFL_WORKFORCE_API_KEY    — ffl-crm API key (ffl_live_...) with agent:write; reports run-status
 *   AGENT_OS_BASE_URL        — optional; ffl-crm base for the run-status report (default https://crm.vestlaunch.com)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { logAgentRun, shouldSkipRedundantKickoff } from "../workforce-hub";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "showmojo";

const DEFAULT_PROMPT = [
  "Run your daily FFL Homes update for today (America/Chicago).",
  "Call your get_ffl_homes tool ONCE (no arguments) — do NOT compute anything",
  "yourself. Confirm today's tab (M.D.2026) ALREADY EXISTS in the Company Numbers",
  "sheet; do NOT create it — if it is missing, STOP and report so it can be created",
  "first. If your status cell A104 already shows homes=done for today, report it complete",
  "(see FINAL STEP) and stop. Otherwise apply your plausibility gate: showmojo_diagnostics.ok MUST be",
  "true and auth_style must not be null — if it is not, do NOT write anything and",
  "report the ShowMojo auth failure. When the gate passes, write Homes row 20 in one",
  "batch: A20=homes_listed, B20=listed_rent_total (write A20:B20), then D20=homes_to_list,",
  "E20=fmr_potential (write D20:E20) — NEVER write C20. Then write the Property-Detail",
  "block A40/A41/A43/A44 (labels + the on_market_block / to_list_block strings verbatim).",
  "Set A104 to homes=done, then read A20/B20/D20/E20 + A40/A41/A43/A44 back and report",
  "exactly what you wrote. If get_ffl_homes fails or the gate fails, DO NOT write or",
  "guess — leave the cells for the next retry and clearly report the failure.",
  "FINAL STEP — when (and only when) every item in your scope is done for today (written now",
  "or verified already done), call report_run_complete with agent_key 'showmojo' and a one-line",
  "detail: it stands down today's remaining retry crons. Best-effort: if that tool is missing",
  "or errors, say so in your report and finish — one attempt only, never let it block you.",
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
  if (await shouldSkipRedundantKickoff(AGENT_KEY, { healWindowStartUtcMinutes: 12 * 60 + 35 })) {
    json(res, 200, { ok: true, skipped: "spend guard: already ran ok twice today" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentId = process.env.FFL_SHOWMOJO_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const prompt = process.env.FFL_SHOWMOJO_PROMPT?.trim() || DEFAULT_PROMPT;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_SHOWMOJO_AGENT_ID", agentId],
    ["FFL_ENVIRONMENT_ID", environmentId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `showmojo: missing env ${missing.join(", ")}`, needsHuman: true });
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
      title: `FFL daily homes ${today}`,
    };
    if (vaultId) sessionBody.vault_ids = [vaultId];

    const createRes = await fetch(`${ANTHROPIC_BASE}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify(sessionBody),
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `showmojo: create_session failed (HTTP ${createRes.status})`, needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: "showmojo: create_session returned no id", needsHuman: true });
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
      await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `showmojo: send_event failed (HTTP ${eventRes.status})`, needsHuman: true });
      json(res, 502, {
        ok: false,
        stage: "send_event",
        session_id: sessionId,
        status: eventRes.status,
        body: eventText.slice(0, 1000),
      });
      return;
    }

    await logAgentRun({ agentKey: AGENT_KEY, status: "ok", summary: `showmojo agent triggered for ${today} (session ${sessionId})` });
    json(res, 200, { ok: true, session_id: sessionId, date: today, triggered_at: new Date().toISOString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAgentRun({ agentKey: AGENT_KEY, status: "failed", summary: `showmojo: ${msg}`, needsHuman: true });
    json(res, 500, { ok: false, error: msg });
  }
}
