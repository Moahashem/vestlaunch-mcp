/**
 * 2026-09-09 — regression guard for a three-week silent gap.
 *
 * The VideoAsk nudge tools (get_videoask_pending / send_videoask_reminder)
 * shipped 2026-08-20 in PR #66. That PR deliberately did NOT add them to the
 * daily cron kickoff, on the reasoning that the prompt must not call tools that
 * are not deployed yet — and said the wiring would land in a follow-up. It never
 * did. So from 2026-08-20 to 2026-09-09 the cloud half kept inviting candidates
 * and never followed up with a single one, while the tooling sat live and
 * unreachable. Mo hit the same gap by hand on the LinkedIn side on 9/9 and set
 * the standing rule these assertions encode.
 *
 * If someone rewrites the kickoff prompt and drops the nudge stage, this test
 * fails instead of the funnel quietly going cold again.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt.js";

describe("recruiting sweep kickoff prompt", () => {
  it("runs the nudge pass with both of its tools", () => {
    expect(DEFAULT_PROMPT).toContain("NUDGE PASS");
    expect(DEFAULT_PROMPT).toContain("get_videoask_pending");
    expect(DEFAULT_PROMPT).toContain("send_videoask_reminder");
  });

  it("asks for Mo's 72-hour delay, not the tool default by accident", () => {
    expect(DEFAULT_PROMPT).toContain("days_since_invite 3");
    expect(DEFAULT_PROMPT).toContain("72");
  });

  it("keeps the one-nudge-ever rule visible to the agent", () => {
    expect(DEFAULT_PROMPT).toContain("ONE nudge per candidate ever");
  });

  it("excludes candidates who wrote back", () => {
    expect(DEFAULT_PROMPT).toContain("WRITTEN BACK");
    expect(DEFAULT_PROMPT).toContain("candidate_replies");
  });

  it("states the roster coverage caveat so the report cannot overclaim", () => {
    expect(DEFAULT_PROMPT).toContain("COVERAGE CAVEAT");
    expect(DEFAULT_PROMPT).toContain("LinkedIn-invited");
  });

  it("still sweeps, invites, watchdogs and reports around the new stage", () => {
    for (const tool of [
      "get_recruiting_state",
      "get_new_applicants",
      "send_recruiting_invite",
      "send_watchdog_alert",
      "update_recruiting_state",
      "get_videoask_completers",
      "send_testgorilla_invite",
      "report_recruiting_run",
    ]) {
      expect(DEFAULT_PROMPT).toContain(tool);
    }
  });

  it("orders the stages: nudge after TestGorilla, before the report", () => {
    const nudge = DEFAULT_PROMPT.indexOf("NUDGE PASS");
    const testgorilla = DEFAULT_PROMPT.indexOf("TestGorilla stage");
    const report = DEFAULT_PROMPT.indexOf("(8) report_recruiting_run");
    expect(testgorilla).toBeGreaterThan(-1);
    expect(nudge).toBeGreaterThan(testgorilla);
    expect(report).toBeGreaterThan(nudge);
  });
});
