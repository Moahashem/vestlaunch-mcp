/**
 * Recruiting run report → Mo's RingCentral channel (via the Ruckus send path).
 *
 * Mo asked (2026-08-18): every recruiting-sweep run should land a SHORT BULLET
 * report in his RingCentral channel — success AND failure — so a missing
 * message is itself a signal that the sweep did not run.
 *
 * Transport: ffl-crm POST /api/ringcentral/ruckus-send — the exact endpoint
 * api/ruckus-mcp.ts relays to; the message posts as the Ruckus bot into its
 * channel. Bearer = RUCKUS_SEND_TOKEN (= the ffl-crm CRON_SECRET; already in
 * this project's Vercel env since Jun 14 — no new secret).
 *
 * This lives in its OWN file (not recruiting-tools.ts) deliberately: pushes go
 * through the GitHub MCP with inline content, and re-transmitting the ~1,250
 * line tools file for a ~90-line feature is exactly how content drift happens
 * (the 2026-08-17 lesson). Small file, small diff, byte-verifiable.
 */

import { reportRecruitingRun } from "./recruiting-tools";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function crmBaseUrl(): string {
  return env("VESTLAUNCH_BASE_URL").replace(/\/+$/, "") || "https://crm.vestlaunch.com";
}

function chicagoDateStamp(d: Date = new Date()): string {
  // en-CA gives YYYY-MM-DD (same helper as recruiting-tools.ts).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Post a message into Mo's Ruckus RingCentral channel. Never throws — the
 * Workforce run-status write must survive an RC outage, so failures are
 * returned to the caller, not raised.
 */
export async function postToRuckusChannel(text: string): Promise<{ posted: boolean; error?: string }> {
  const token = env("RUCKUS_SEND_TOKEN");
  if (!token) return { posted: false, error: "RUCKUS_SEND_TOKEN not set" };
  const body = text.trim();
  if (!body) return { posted: false, error: "empty text" };
  try {
    const res = await fetch(`${crmBaseUrl()}/api/ringcentral/ruckus-send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!res.ok) {
      const out = (await res.text()).slice(0, 300);
      return { posted: false, error: `HTTP ${res.status}: ${out}` };
    }
    return { posted: true };
  } catch (err) {
    return { posted: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * report_recruiting_run's implementation since 2026-08-18: writes the
 * Workforce Hub run-status row (via the original reportRecruitingRun), then
 * posts Mo's bullet report to RingCentral.
 *
 * Posting rules:
 *  - `report` present → post it (with a status header line).
 *  - status !== "ok"  → ALWAYS post (falls back to the one-line summary), so
 *    "it didn't work" is never silent.
 *  - ok + no `report` → post nothing. This is the same-day retry no-op path —
 *    the kickoff prompt tells the agent to omit `report` there so Mo gets one
 *    message per day, not two.
 */
export async function reportRecruitingRunWithRc(args: {
  status: string;
  summary: string;
  needsHuman?: boolean;
  report?: string;
}): Promise<Record<string, unknown>> {
  const base = await reportRecruitingRun({
    status: args.status,
    summary: args.summary,
    needsHuman: args.needsHuman,
  });

  const status = ["ok", "failed", "partial"].includes(args.status) ? args.status : "ok";
  const report = (args.report ?? "").trim();
  let rc: { posted: boolean; error?: string } = { posted: false, error: "skipped (no report; status ok)" };
  if (report || status !== "ok") {
    const icon = status === "ok" ? "✅" : status === "partial" ? "⚠️" : "❌";
    const header =
      `${icon} Recruiting sweep (cloud) — ${chicagoDateStamp()} — ${status.toUpperCase()}` +
      (args.needsHuman ? " — NEEDS MO" : "");
    rc = await postToRuckusChannel(`${header}\n${report || `- ${args.summary.trim()}`}`);
  }

  return { ...base, rc_posted: rc.posted, ...(rc.error ? { rc_error: rc.error } : {}) };
}
