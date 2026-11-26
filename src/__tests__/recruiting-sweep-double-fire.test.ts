/**
 * 2026-09-15 — the recruiting sweep ran TWICE in one morning (13:30 and 13:50
 * UTC slots), both full runs, both messaging Mo. Two things let it happen:
 *   1. the generic spend guard only stands down on a WORK COMPLETE row, which
 *      this agent never writes, and both slots sit inside the heal window;
 *   2. the prompt-level "last_run_cloud < 2h → no-op" rule never tripped
 *      because the agent had stored last_run_cloud ~45 min in the FUTURE.
 * These tests pin both fixes: the retry slot skips server-side once the agent
 * has filed today's finished-run row, and future run timestamps are clamped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldSkipRedundantKickoff } from "../../api/workforce-hub";
import { isFinishedSweepRow } from "../../api/cron/recruiting-sweep";
import { sanitizeRunTimestamp, updateRecruitingState } from "../../api/recruiting-tools";

const HUB_KEY = "ffl_live_test_key";
/** The 13:50 UTC retry slot — inside the default heal window. */
const RETRY_SLOT = new Date("2026-09-15T13:50:00Z");

function mockHubRuns(rows: Array<{ status: string; summary: string; payload?: unknown }>) {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ success: true, data: rows }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const KICKOFF = {
  status: "ok",
  summary: "recruiting sweep (cloud half) triggered for 9/15/2026 (session sesn_x)",
};
const FINISHED = {
  status: "ok",
  summary: "No new invites; 6 TestGorilla assessments sent; all sources swept clean.",
  payload: { report: "NEEDS YOU:\n- Indeed replies waiting (1): ..." },
};

describe("isFinishedSweepRow", () => {
  it("ignores this cron's own kickoff and failure bookkeeping rows", () => {
    expect(isFinishedSweepRow(KICKOFF)).toBe(false);
    expect(isFinishedSweepRow({ status: "failed", summary: "recruiting sweep: create_session failed" })).toBe(false);
    expect(isFinishedSweepRow({ status: "ok", summary: "Recruiting sweep (cloud half) triggered ..." })).toBe(false);
  });
  it("accepts the agent's own ok/partial report rows", () => {
    expect(isFinishedSweepRow(FINISHED)).toBe(true);
    expect(isFinishedSweepRow({ status: "partial", summary: "3 invites, cap hit" })).toBe(true);
  });
  it("rejects failed or empty rows", () => {
    expect(isFinishedSweepRow({ status: "failed", summary: "Gmail down" })).toBe(false);
    expect(isFinishedSweepRow({ status: "ok", summary: "" })).toBe(false);
  });
});

describe("retry slot skips once the agent has reported (server-side)", () => {
  beforeEach(() => {
    vi.stubEnv("FFL_WORKFORCE_API_KEY", HUB_KEY);
    vi.useFakeTimers();
    vi.setSystemTime(RETRY_SLOT);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("skips the 13:50 slot when a finished-run row exists (the 9/15 double fire)", async () => {
    const fetchMock = mockHubRuns([KICKOFF, FINISHED]);
    expect(await shouldSkipRedundantKickoff("recruiting-sweep", { completionPredicate: isFinishedSweepRow })).toBe(true);
    // Partial rows are needed for this check, so the status=ok filter must be gone.
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain("status=ok");
  });

  it("still runs the retry when only the kickoff row exists (session died mid-run)", async () => {
    mockHubRuns([KICKOFF]);
    expect(await shouldSkipRedundantKickoff("recruiting-sweep", { completionPredicate: isFinishedSweepRow })).toBe(false);
  });

  it("still runs the retry when the agent reported a FAILED run", async () => {
    mockHubRuns([KICKOFF, { status: "failed", summary: "Gmail auth expired" }]);
    expect(await shouldSkipRedundantKickoff("recruiting-sweep", { completionPredicate: isFinishedSweepRow })).toBe(false);
  });

  it("keeps the old behaviour for crons that do not pass a predicate", async () => {
    const fetchMock = mockHubRuns([KICKOFF, FINISHED]);
    // Inside the heal window with no WORK COMPLETE row → run.
    expect(await shouldSkipRedundantKickoff("recruiting-sweep")).toBe(false);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=ok");
  });
});

describe("sanitizeRunTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T13:36:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("clamps a future last_run_cloud to now and explains", () => {
    const r = sanitizeRunTimestamp("last_run_cloud", "2026-09-15T14:21:33.000Z");
    expect(r.value).toBe("2026-09-15T13:36:00.000Z");
    expect(r.note).toMatch(/future/);
  });
  it("passes a real past time through, normalised to ISO", () => {
    const r = sanitizeRunTimestamp("last_run_browser", "2026-09-14T19:00:00Z");
    expect(r.value).toBe("2026-09-14T19:00:00.000Z");
    expect(r.note).toBeUndefined();
  });
  it("tolerates a few seconds of clock skew", () => {
    const r = sanitizeRunTimestamp("last_run_cloud", "2026-09-15T13:36:30Z");
    expect(r.note).toBeUndefined();
  });
  it("rejects junk instead of storing it", () => {
    expect(() => sanitizeRunTimestamp("last_run_cloud", "yesterday")).toThrow(/ISO-8601/);
    expect(() => sanitizeRunTimestamp("last_run_cloud", 12345)).toThrow(/ISO-8601/);
  });
  it("leaves every other key alone", () => {
    expect(sanitizeRunTimestamp("carry_forward_cloud", ["x"])).toEqual({ value: ["x"] });
  });
});

describe("updateRecruitingState rejects the retired shared key", () => {
  it("refuses carry_forward and names both replacements", async () => {
    await expect(updateRecruitingState("carry_forward", ["x"])).rejects.toThrow(
      /carry_forward_cloud.*carry_forward_browser/,
    );
  });
  it("still accepts the split keys", async () => {
    // Reaches the network call, which is proof the guard let it through.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })));
    vi.stubEnv("FFL_WORKFORCE_API_KEY", HUB_KEY);
    await expect(updateRecruitingState("carry_forward_browser", ["linkedin item"])).resolves.toMatchObject({ saved: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
