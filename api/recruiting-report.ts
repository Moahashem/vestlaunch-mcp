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

const ALL_CLEAR = "Nothing needs you.";

/**
 * The one line to show when the agent raised its hand but its reason did not
 * survive — a marker it never wrote, or a report that arrived empty. Saying so
 * beats printing the all-clear under a header that shouts NEEDS YOU.
 */
const REASON_MISSING =
  "- Something was flagged for you on this run but the reason did not come through. Ask Claude to look.";

/**
 * Keep only the agent's judgement half: everything from NEEDS YOU onward.
 * Returns null on a clean run so the caller can tell "all clear" apart from
 * "flagged but silent" — two very different messages to wake up to.
 */
function needsYouTail(agentReport: string): string | null {
  // Anchored to a line start so the "needs you" inside the all-clear line
  // "Nothing needs you." can never match — that slice produced a bare
  // "needs you." in Lando's 2026-08-20 4:17pm report. Case-insensitive from
  // 2026-08-26: the marker is uppercase in the agent's system prompt but the
  // cron kickoff prompt asked for "👉 Needs you:", and a report that follows
  // the kickoff wording must not lose its reason over letter case.
  const m = /^[ \t]*(?:👉[ \t]*)?NEEDS YOU\b/im.exec(agentReport ?? "");
  if (!m) return null;
  // Drop the marker line itself — the header already says NEEDS YOU, and
  // saying it twice in two consecutive lines is noise on a phone screen.
  const bullets = agentReport
    .slice(m.index)
    // Only the marker LINE goes — never the "- " starting the first bullet.
    .replace(/^[ \t]*(?:👉[ \t]*)?NEEDS YOU\b[ \t]*:?[ \t]*\r?\n?/i, "")
    .trim();
  return bullets || null;
}

/**
 * Build the exact message that lands in Lando's channel. Pure — no network, no
 * clock beyond the date stamp — so every rule below is unit-testable.
 *
 * Two rules, both learned the hard way (2026-08-26):
 *  1. ONE vocabulary. The header used to say "NEEDS MO" while the block below
 *     said "NEEDS YOU". Same thing, two names.
 *  2. The ask goes FIRST. It used to sit under the routine "Did:" list, so a
 *     day that needed him looked identical to a quiet one until he scrolled.
 *
 * The flag is raised by EITHER signal — the agent's `needsHuman` boolean or an
 * actual NEEDS YOU block — so forgetting one can no longer hide the other. And
 * a flag with no reason says so out loud instead of printing the all-clear.
 */
export function composeReport(args: {
  status: string;
  summary: string;
  report?: string;
  needsHuman?: boolean;
  /** Receipt-counted "Did:" block, or null when the state store was unreachable. */
  did?: { block: string; total: number } | null;
  dateStamp?: string;
}): string {
  const status = ["ok", "failed", "partial"].includes(args.status) ? args.status : "ok";
  const icon = status === "ok" ? "✅" : status === "partial" ? "⚠️" : "❌";
  const report = (args.report ?? "").trim();

  const tail = needsYouTail(report);
  const action = tail ?? (args.needsHuman === true ? REASON_MISSING : null);
  const header =
    `${icon} Recruiting sweep (cloud) — ${args.dateStamp ?? chicagoDateStamp()} — ${status.toUpperCase()}` +
    (action ? " — 👉 NEEDS YOU" : "");

  // A null `did` means the receipt store was unreachable. Post the agent's own
  // words rather than nothing, but never print the reason twice.
  const didBlock = args.did?.block ?? null;
  if (action) {
    // Blank line under the header so the ask reads as its own paragraph.
    return didBlock ? `${header}\n\n${action}\n\n${didBlock}` : `${header}\n\n${action}`;
  }
  return `${header}\n${didBlock ? `${didBlock}\n\n${ALL_CLEAR}` : report || `- ${args.summary.trim()}`}`;
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
  const status = ["ok", "failed", "partial"].includes(args.status) ? args.status : "ok";
  const report = (args.report ?? "").trim();

  // The agent's own words are kept on the run row (payload.report) so a reason
  // that gets garbled on the way to RingCentral is still recoverable later.
  // On 2026-08-26 a run was flagged NEEDS MO and only `summary` was stored, so
  // answering "why?" meant reading the Console transcript by hand.
  const base = await reportRecruitingRun({
    status: args.status,
    summary: args.summary,
    needsHuman: args.needsHuman,
    payload: report ? { report } : undefined,
  });

  let rc: { posted: boolean; error?: string } = { posted: false, error: "skipped (no report; status ok)" };
  let receiptTotal: number | undefined;
  let bodySource = "agent";
  if (report || status !== "ok") {
    // Numbers from receipts, judgement from the agent. If the state store is
    // unreachable we fall back to the agent's own text rather than drop the
    // message — a silent day is worse than an unaudited one.
    let did: { block: string; total: number } | null = null;
    try {
      did = didBlockFromReceipts(await getTodaySendReceipts());
      receiptTotal = did.total;
      bodySource = "receipts";
    } catch {
      bodySource = "agent (receipts unavailable)";
    }

    rc = await postToRuckusChannel(
      composeReport({
        status,
        summary: args.summary,
        report,
        needsHuman: args.needsHuman,
        did,
      }),
    );
  }

  return {
    ...base,
    rc_posted: rc.posted,
    report_body_source: bodySource,
    ...(receiptTotal === undefined ? {} : { receipts_counted: receiptTotal }),
    ...(rc.error ? { rc_error: rc.error } : {}),
  };
}
