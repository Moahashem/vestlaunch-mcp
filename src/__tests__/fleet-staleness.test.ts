/**
 * Fleet staleness guard — decision logic (api/cron/fleet-staleness.ts).
 * The guard must stay SILENT for agents that have never reported completion
 * (transition period), but catch never-kicked-off crons and, once an agent is
 * completion-enabled, any day it goes quiet — the 8/30–8/31 failure mode.
 */
import { describe, expect, it } from "vitest";

import { judgeAgent } from "../../api/cron/fleet-staleness";
import { WORK_COMPLETE_PREFIX } from "../../api/workforce-hub";

const kickoff = { status: "ok", summary: "occupancy agent triggered (session a)" };
const failed = { status: "failed", summary: "occupancy: create_session failed (HTTP 529)" };
const complete = { status: "ok", summary: `${WORK_COMPLETE_PREFIX} 2026-08-31: all items done` };

describe("judgeAgent", () => {
  it("alerts NEVER KICKED OFF when today has no ok rows (works day one)", () => {
    const v = judgeAgent("occupancy", [failed], []);
    expect(v.alert).toContain("NEVER KICKED OFF");
  });

  it("stays silent for a not-yet-completion-enabled agent with normal kickoffs", () => {
    const v = judgeAgent("occupancy", [kickoff, kickoff], [kickoff]);
    expect(v.alert).toBeNull();
    expect(v.completionEnabled).toBe(false);
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
