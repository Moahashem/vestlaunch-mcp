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
import { logAgentRun } from "../workforce-hub";
import { postToRuckusChannel } from "../recruiting-report";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const AGENT_KEY = "recruiting-sweep";

const DEFAULT_PROMPT = [
  "Run your daily CLOUD-half recruiting invite sweep for today (America/Chicago).",
  "Follow your system prompt exactly. In short: (1) get_recruiting_state — read",
  "last_run_cloud and last_run_browser; your sweep window starts at last_run_cloud",
  "(minimum 2 days back; if the gap is larger, the window widens automatically —",
  "say so in your report). (2) Sweep every cloud channel via get_new_applicants:",
  "website, wix, wizehire, indeed, true_analysis, hazelequity. If hazelequity",
  "returns swept:false, report it as UNSWEPT, never as zero applicants. The",
  "indeed channel (added 2026-08-18) returns individual application emails with",
  "full body — extract each candidate's name, email (relay …@indeedemail.com",
  "addresses are valid), and role yourself; a hit with no extractable email is",
  "skipped and reported by subject. The indeed channel also returns `digests`",
  "(daily debrief summaries) for DETECTION ONLY: a job title that shows",
  "applications in a digest but has NO individual emails in your hits is an",
  "UNCONFIGURED posting (new/reposted job whose per-application email setting",
  "was never enabled) — flag it under Needs-you by job title so Mo/Claude can",
  "configure it. Never invite from digests, and ignore digest copies appearing",
  "in true_analysis.",
  "The Mac browser half is LinkedIn-ONLY now: only LinkedIn items go to",
  "carry_forward for it. (3) For each",
  "applicant, call send_recruiting_invite — dedup, the do-not-contact",
  "list, and the daily cap are enforced inside the tool; if it refuses, accept",
  "the refusal and log why. Since 2026-08-18 ALL roles are invitable (EA,",
  "Virtual Sales, Virtual PM, VLS, Maintenance included — the tool maps each",
  "role to its questionnaire; this supersedes any out-of-scope list in your",
  "system prompt). If a role cannot be mapped the tool refuses — list that",
  "applicant BY NAME + role in your report for Mo. Wix hits are often",
  "property-owner sales leads, not applicants — only invite real job applicants.",
  "(4) Watchdog: if last_run_browser is more than 3 days old, send_watchdog_alert",
  "so Mo knows LinkedIn/Indeed are going stale. (5) update_recruiting_state:",
  "set last_run_cloud to now — the CURRENT actual UTC time as full ISO, never a",
  "rounded or future time — and carry_forward to anything unfinished.",
  "(6) report_recruiting_run with a one-line summary AND the `report` field.",
  "FORMAT (Mo's rule, 2026-08-18 — headline + action items ONLY, never a log):",
  "the `report` first line is ONE plain-English sentence with the outcome and",
  "counts, e.g. '10 invites sent (8 EA, 2 Maint Coord); all 5 channels swept;",
  "5 duplicates auto-blocked'. Then ONLY if something needs Mo, add a line",
  "'👉 Needs you:' followed by 1-3 short '- ' bullets. Needs-you items are:",
  "unmappable-role applicants (by name + role), any UNSWEPT channel, watchdog",
  "fired / last_run_browser more than 2 days old (say new Indeed/LinkedIn",
  "applicants are waiting on his Mac), send errors, or anything else requiring",
  "his action. A quiet day = the single headline line and NOTHING else. Never",
  "list individual invitees, dedup refusals, per-channel zero counts, or",
  "routine carry-forward — that detail lives in state and the run row, not in",
  "Mo's message.",
  "This fire may be a RETRY — that is normal; the send tool's per-day log makes",
  "duplicate emails impossible, so simply continue any unfinished work. BUT if",
  "last_run_cloud is less than 2 hours old, the first fire already completed:",
  "do NOT re-sweep — call report_recruiting_run with status ok, summary",
  "'retry no-op — first run already completed', and NO report field (so Mo is",
  "not messaged twice), then stop.",
].join(" ");

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
