/**
 * Daily cron trigger for the FFL Sales Daily Lead Counter (Managed Agent).
 *
 * Managed Agents is a runtime, not a scheduler (project D12) — recurring,
 * laptop-off runs need an EXTERNAL trigger. This Vercel cron is that trigger.
 *
 * On each fire it (1) creates a Managed Agents session bound to the agent,
 * environment, and credential vault, then (2) sends a `user.message` event
 * to start the daily task. The agent then runs entirely on Anthropic's
 * cloud (no laptop required) and writes the four lead counts to the sheet.
 *
 * The session is created WITHOUT pinning a version, so it always runs the
 * agent's current active version (v5 = thin agent + count_landlord_leads).
 *
 * Schedule: see vercel.json (`0 11 * * *` UTC = 6:00 AM America/Chicago in
 * CDT). NOTE Vercel crons are UTC-only — in CST (Nov–Mar) this lands at
 * 5:00 AM CT. See vercel.json for the DST-exact dual-cron alternative.
 *
 * Auth: when CRON_SECRET is set in Vercel env, Vercel includes
 * `Authorization: Bearer <CRON_SECRET>` on cron invocations; we require it
 * so the endpoint can't be triggered by random callers.
 *
 * Secrets (ALL placed by Mo in Vercel env — never hard-coded):
 *   ANTHROPIC_API_KEY     — key with Managed Agents access
 *   FFL_AGENT_ID          — agent_01UQzJ4ZKLP7JGYsBvwptu74
 *   FFL_ENVIRONMENT_ID    — env_01JaER…hnr6GA  (ffl-agents)
 *   FFL_VAULT_ID          — vlt_011CbdGFbUSSxVsDm7Mymq77  (ffl-mcp)
 *   CRON_SECRET           — random string; gates this endpoint
 *   FFL_DAILY_PROMPT      — optional; overrides the default kickoff message
 *                           (the tab-housekeeping addendum below is appended
 *                           to EITHER prompt, so it applies regardless)
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const config = { maxDuration: 60 };

const ANTHROPIC_BASE = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

const DEFAULT_PROMPT = [
  "Run your FULL daily Sales update for today (America/Chicago) — every item",
  "your status cell A54 does not already mark done for TODAY: the day's tab",
  "(create it if missing — you are the tab steward), Leads row 26, Calls row",
  "27, Sign Ups row 29, and the huddle notes H46/H47 (verbatim block + your",
  "RADAR analysis). Follow your system prompt exactly: read A54 first, skip",
  "done items, work through ALL remaining items even if one fails, update A54",
  "after each, clear-on-error, never row 28. This fire may be a RETRY — that",
  "is normal; A54 makes it idempotent. Read back what you wrote and report",
  "which items were filled, skipped (already done), or failed.",
].join(" ");

/**
 * Tab housekeeping (Mo, 2026-06-09): keep only the trailing 7 days of daily
 * tabs visible so the team isn't scrolling through months of tabs. HIDE only —
 * data is never deleted and any tab can be unhidden from the Sheets UI.
 * Appended to the kickoff prompt (env-override or default) so it always
 * applies. Runs LAST and must never block the lead counts.
 */
const HOUSEKEEPING_ADDENDUM = [
  "AFTER your main job is fully done (tab created, rows written, read-back",
  "reported), perform one extra TAB-STEWARD housekeeping step — this is part of",
  "your tab-lifecycle authority from Mo and does not violate your cell-scope",
  "rules (you still write only your own cells): keep only the trailing 7",
  "calendar days of DATE tabs visible. (1) GET the tab list via the Zapier raw",
  "request action: https://sheets.googleapis.com/v4/spreadsheets/1cZdZC2EW7yPILZXwDR7D4H180CuvdY1e7VGuO-Jz30k?fields=sheets.properties(sheetId,title,hidden)",
  "(2) A tab must be HIDDEN if and only if: its title parses as M.D.YYYY (skip",
  "any title that does not match exactly), AND its date is OLDER than (today",
  "minus 6 days) in America/Chicago, AND it is not already hidden. (3) If any",
  "qualify, send ONE Sheets batchUpdate via the Zapier raw MUTATING request to",
  "https://sheets.googleapis.com/v4/spreadsheets/1cZdZC2EW7yPILZXwDR7D4H180CuvdY1e7VGuO-Jz30k:batchUpdate",
  'with the body as a PRE-SERIALIZED JSON STRING: {"requests":[{"updateSheetProperties":{"properties":{"sheetId":<id>,"hidden":true},"fields":"hidden"}},...]}',
  "(4) HIDE ONLY — never delete, rename, or unhide a tab, never hide today's",
  "tab or any non-date tab, and never touch cell values during this step.",
  "(5) If this step errors or you are unsure about any tab, SKIP it and note",
  "that in your report — housekeeping must NEVER fail or delay the lead counts.",
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
  const agentId = process.env.FFL_AGENT_ID;
  const environmentId = process.env.FFL_ENVIRONMENT_ID;
  const vaultId = process.env.FFL_VAULT_ID;
  const basePrompt = process.env.FFL_DAILY_PROMPT?.trim() || DEFAULT_PROMPT;
  const prompt = `${basePrompt}\n\n${HOUSEKEEPING_ADDENDUM}`;

  const missing = [
    ["ANTHROPIC_API_KEY", apiKey],
    ["FFL_AGENT_ID", agentId],
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
    // --- 1. Create the session ---
    const sessionBody: Record<string, unknown> = {
      agent: agentId,
      environment_id: environmentId,
      title: `FFL daily lead count ${today}`,
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
