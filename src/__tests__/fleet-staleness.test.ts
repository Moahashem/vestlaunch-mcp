/**
 * Fleet staleness guard — decision logic (api/cron/fleet-staleness.ts).
 * The guard must stay SILENT for agents that have never reported completion
 * (transition period), but catch never-kicked-off crons and, once an agent is
 * completion-enabled, any day it goes quiet — the 8/30–8/31 failure mode.
 */
import { describe, expect, it } from "vitest";

import { composeAlert, countMissedDaysBefore, judgeAgent } from "../../api/cron/fleet-staleness";
import { WORK_COMPLETE_PREFIX } from "../../api/workforce-hub";

const kickoff = { status: "ok", summary: "occupancy agent triggered (session a)" };
const failed = { status: "failed", summary: "occupancy: create_session failed (HTTP 529)" };
const complete = { status: "ok", summary: `${WORK_COMPLETE_PREFIX} 2026-08-31: all items done` };

describe("judgeAgent", () => {
  it("alerts NEVER KICKED OFF when today has no ok rows (works day one)", () => {
    const v = judgeAgent("occupancy", [failed], []);
    expect(v.alert).toContain("NEVER KICKED OFF");
  });

  it("stays silent for a not-yet-completion-enabled (unwatched) agent with normal kickoffs", () => {
    const v = judgeAgent("some-new-agent", [kickoff, kickoff], [kickoff]);
    expect(v.alert).toBeNull();
    expect(v.completionEnabled).toBe(false);
  });

  it("a watched agent stays completion-required even after a week with no completion (no day-8 silence)", () => {
    const v = judgeAgent("cranbrook-cfa", [kickoff, kickoff, kickoff], [kickoff, kickoff]);
    expect(v.completionEnabled).toBe(true);
    expect(v.alert).toContain(`no ${WORK_COMPLETE_PREFIX} today`);
    expect(v.alert).toContain("Cranbrook ResMan numbers");
  });

  it("alerts on failed rows even before completion reporting is enabled", () => {
    const v = judgeAgent("occupancy", [kickoff, failed], [kickoff]);
    expect(v.alert).toContain("failed run(s)");
  });

  it("alerts when a completion-enabled agent has no WORK COMPLETE today — the 8/30-8/31 case", () => {
    const v = judgeAgent("occupancy", [kickoff, kickoff], [complete]);
    expect(v.completionEnabled).toBe(true);
    expect(v.alert).toContain(`no ${WORK_COMPLETE_PREFIX} today`);
  });

  it("stays silent when today carries a WORK COMPLETE row", () => {
    const v = judgeAgent("occupancy", [kickoff, complete], [complete]);
    expect(v.alert).toBeNull();
    expect(v.completeToday).toBe(true);
  });

  it("a completion row also clears earlier failed rows (healed by a retry)", () => {
    const v = judgeAgent("occupancy", [failed, kickoff, complete], [complete]);
    expect(v.alert).toBeNull();
  });
});

// ── 2026-10-26: missed-day streak + plain-words alert (after the 10/24–10/26 Cranbrook outage) ──
describe("countMissedDaysBefore / streak", () => {
  // Monday 10/26/2026, 8:10 AM CDT
  const now = new Date("2026-10-26T13:10:00Z");
  const doneOn = (iso: string) => ({ status: "ok", summary: `${WORK_COMPLETE_PREFIX} x`, ranAt: iso });

  it("is 0 when yesterday completed", () => {
    expect(countMissedDaysBefore([doneOn("2026-10-25T11:35:00Z")], now)).toBe(0);
  });

  it("counts Sat + Sun when the last completion was Friday — the real 10/24–10/26 case", () => {
    const rows = [doneOn("2026-10-23T11:34:37Z"), { status: "ok", summary: "cranbrook-cfa agent triggered", ranAt: "2026-10-25T11:30:00Z" }];
    expect(countMissedDaysBefore(rows, now)).toBe(2);
    const v = judgeAgent("cranbrook-cfa", [kickoff], rows, now);
    expect(v.missedDaysBefore).toBe(2);
    expect(v.alert).toContain("3 days in a row");
  });

  it("uses the Chicago date, not UTC (a 11 PM CDT completion counts for that day)", () => {
    // 2026-10-26T04:30Z = 10/25 11:30 PM CDT → counts as Sunday
    expect(countMissedDaysBefore([doneOn("2026-10-26T04:30:00Z")], now)).toBe(0);
  });

  it("caps at 6 and says 'or more'", () => {
    expect(countMissedDaysBefore([], now)).toBe(6);
    expect(judgeAgent("occupancy", [kickoff], [], now).alert).toContain("7 days in a row or more");
  });

  it("walks days correctly across the Nov 1 DST change", () => {
    const afterDst = new Date("2026-11-02T14:10:00Z"); // Mon 11/2 8:10 AM CST
    expect(countMissedDaysBefore([doneOn("2026-10-31T11:35:00Z")], afterDst)).toBe(1); // Sun 11/1 missed only
  });

  it("no streak text when the agent completed today", () => {
    const v = judgeAgent("cranbrook-cfa", [kickoff, complete], [], now);
    expect(v.alert).toBeNull();
  });
});

describe("composeAlert", () => {
  it("leads with plain words and a red marker, then the details", () => {
    const text = composeAlert(["Cranbrook leads (row 35) [cranbrook-cf-leads]: no WORK COMPLETE today"]);
    expect(text.startsWith("🔴 Morning numbers: one part of today's Company Numbers sheet did not fill in.")).toBe(true);
    expect(text).toContain("• Cranbrook leads (row 35)");
    expect(text).toContain("/agent-os/daily");
  });

  it("counts several parts", () => {
    expect(composeAlert(["a", "b"])).toContain("2 parts of today's");
  });
});
