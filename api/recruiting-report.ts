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

import {
  reportRecruitingRun,
  getTodaySendReceipts,
  sendChannelFor,
  type SendReceipt,
} from "./recruiting-tools";

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
 * The "Did:" block, COUNTED from send receipts rather than written by the agent.
 *
 * Lando, 2026-08-20: "how can we be for sure that these things happened?" It
 * could not be — the report was a narration. Now every line here is a count of
 * receipts written at send time, each carrying a real Gmail message id, so the
 * report cannot claim a send that did not happen. The agent still writes the
 * NEEDS YOU part, which is judgement, not arithmetic.
 *
 * A line with zero sends is dropped: caps and quiet days are normal operation
 * and Lando asked for only what he needs to know.
 */
function channelSuffix(list: SendReceipt[]): string {
  const viaIndeed = list.filter((r) => sendChannelFor(r.email ?? "") === "indeed_message").length;
  const viaEmail = list.length - viaIndeed;
  if (viaIndeed === 0) return "(all by email)";
  if (viaEmail === 0) return "(all by Indeed message)";
  return `(${viaEmail} by email, ${viaIndeed} by Indeed message)`;
}

function didBlockFromReceipts(r: {
  invites: SendReceipt[];
  skills_tests: SendReceipt[];
  reminders: SendReceipt[];
}): { block: string; total: number } {
  const lines: string[] = [];
  if (r.invites.length > 0) {
    const plural = r.invites.length === 1 ? "applicant" : "applicants";
    lines.push(`- Invited ${r.invites.length} new ${plural} ${channelSuffix(r.invites)}`);
  }
  if (r.reminders.length > 0) {
    lines.push(
      `- Nudged ${r.reminders.length} people to finish their video ${channelSuffix(r.reminders)}`,
    );
  }
  if (r.skills_tests.length > 0) {
    lines.push(`- Skills tests: ${r.skills_tests.length} ${channelSuffix(r.skills_tests)}`);
  }
  const total = r.invites.length + r.reminders.length + r.skills_tests.length;
  if (lines.length === 0) return { block: "Nothing new today.", total: 0 };
  const receipts = total === 1 ? "1 send receipt" : `${total} send receipts`;
  return { block: `Did:\n${lines.join("\n")}\n\n(counted from ${receipts})`, total };
}

/** Keep only the agent's judgement half: everything from NEEDS YOU onward. */
function needsYouTail(agentReport: string): string {
  // Case-SENSITIVE and anchored to a line start. The first cut used /NEEDS YOU/i,
  // which matched the "needs you" inside the all-clear line "Nothing needs you."
  // and sliced it into a bare "needs you." — Lando's 2026-08-20 4:17pm report.
  // The marker is a literal uppercase block header, so match it as one.
  const m = /^NEEDS YOU\b/m.exec(agentReport ?? "");
  return m ? agentReport.slice(m.index).trim() : "Nothing needs you.";
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
  let receiptTotal: number | undefined;
  let bodySource = "agent";
  if (report || status !== "ok") {
    const icon = status === "ok" ? "✅" : status === "partial" ? "⚠️" : "❌";
    const header =
      `${icon} Recruiting sweep (cloud) — ${chicagoDateStamp()} — ${status.toUpperCase()}` +
      (args.needsHuman ? " — NEEDS MO" : "");

    // Numbers from receipts, judgement from the agent. If the state store is
    // unreachable we fall back to the agent's own text rather than drop the
    // message — a silent day is worse than an unaudited one.
    let body = report || `- ${args.summary.trim()}`;
    try {
      const receipts = await getTodaySendReceipts();
      const did = didBlockFromReceipts(receipts);
      receiptTotal = did.total;
      bodySource = "receipts";
      body = `${did.block}\n\n${needsYouTail(report)}`;
    } catch {
      bodySource = "agent (receipts unavailable)";
    }

    rc = await postToRuckusChannel(`${header}\n${body}`);
  }

  return {
    ...base,
    rc_posted: rc.posted,
    report_body_source: bodySource,
    ...(receiptTotal === undefined ? {} : { receipts_counted: receiptTotal }),
    ...(rc.error ? { rc_error: rc.error } : {}),
  };
}
