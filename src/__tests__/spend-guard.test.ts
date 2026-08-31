/**
 * Spend guard v2 (completion-aware) — api/workforce-hub.ts.
 *
 * Regression tests for the 2026-08-30/31 incident: both morning occupancy
 * sessions ended with renewals/delinquency unwritten, and guard v1 (kickoff
 * counting) suppressed every retry slot including the alert pass. v2 must:
 *   - stand down ONLY on an explicit WORK COMPLETE row, and
 *   - always let heal-window (final) slots run when completion is unconfirmed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reportWorkComplete,
  shouldSkipRedundantKickoff,
  WORK_COMPLETE_PREFIX,
} from "../../api/workforce-hub";

const HUB_KEY = "ffl_live_test_key";

function mockHubRuns(rows: Array<{ summary: string }>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () =>
    new Response(JSON.stringify({ success: true, data: rows }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A UTC instant before every heal window used by the crons (11:20 UTC). */
const EARLY_SLOT = new Date("2026-08-31T11:20:00Z");
/** A UTC instant inside the default heal window (12:50 UTC cron slot). */
const HEAL_SLOT = new Date("2026-08-31T12:50:00Z");

describe("shouldSkipRedundantKickoff (v2, completion-aware)", () => {
  beforeEach(() => {
    vi.stubEnv("FFL_WORKFORCE_API_KEY", HUB_KEY);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fails open (never skips) when no hub key is configured", async () => {
    vi.stubEnv("FFL_WORKFORCE_API_KEY", "");
    vi.stubEnv("VESTLAUNCH_API_KEY", "");
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(false);
  });

  it("fails open when the hub read throws", async () => {
    vi.setSystemTime(EARLY_SLOT);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(false);
  });

  it("skips early retry slots after two successful kickoffs (v1 behavior kept)", async () => {
    vi.setSystemTime(EARLY_SLOT);
    mockHubRuns([
      { summary: "occupancy agent triggered for 8/31/2026 (session a)" },
      { summary: "occupancy agent triggered for 8/31/2026 (session b)" },
    ]);
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(true);
  });

  it("runs early retry slots while fewer than two kickoffs exist", async () => {
    vi.setSystemTime(EARLY_SLOT);
    mockHubRuns([{ summary: "occupancy agent triggered for 8/31/2026 (session a)" }]);
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(false);
  });

  it("NEVER skips a heal-window slot when completion is unconfirmed — the 8/30-8/31 regression", async () => {
    vi.setSystemTime(HEAL_SLOT);
    mockHubRuns([
      { summary: "occupancy agent triggered for 8/31/2026 (session a)" },
      { summary: "occupancy agent triggered for 8/31/2026 (session b)" },
    ]);
    expect(
      await shouldSkipRedundantKickoff("occupancy", { healWindowStartUtcMinutes: 12 * 60 + 45 }),
    ).toBe(false);
  });

  it("skips heal-window slots once WORK COMPLETE is reported", async () => {
    vi.setSystemTime(HEAL_SLOT);
    mockHubRuns([
      { summary: "occupancy agent triggered for 8/31/2026 (session a)" },
      { summary: `${WORK_COMPLETE_PREFIX} 2026-08-31: all five items done` },
    ]);
    expect(
      await shouldSkipRedundantKickoff("occupancy", { healWindowStartUtcMinutes: 12 * 60 + 45 }),
    ).toBe(true);
  });

  it("skips even the verification slot once WORK COMPLETE is reported (spend win)", async () => {
    vi.setSystemTime(EARLY_SLOT);
    mockHubRuns([{ summary: `${WORK_COMPLETE_PREFIX} 2026-08-31: all five items done` }]);
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(true);
  });

  it("honors a per-cron heal window start", async () => {
    // 12:10 UTC = daily-cfa's final slot; its heal window starts 12:05 UTC.
    vi.setSystemTime(new Date("2026-08-31T12:10:00Z"));
    mockHubRuns([
      { summary: "cranbrook-cfa agent triggered (session a)" },
      { summary: "cranbrook-cfa agent triggered (session b)" },
    ]);
    expect(
      await shouldSkipRedundantKickoff("cranbrook-cfa", { healWindowStartUtcMinutes: 12 * 60 + 5 }),
    ).toBe(false);
  });
});

describe("reportWorkComplete", () => {
  beforeEach(() => {
    vi.stubEnv("FFL_WORKFORCE_API_KEY", HUB_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("POSTs a run-status row whose summary carries the WORK COMPLETE prefix", async () => {
    const fn = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fn);

    await reportWorkComplete("occupancy", "all five items done");

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/api/v1/agent/run-status");
    const body = JSON.parse(String(init.body)) as { agentKey: string; status: string; summary: string };
    expect(body.agentKey).toBe("occupancy");
    expect(body.status).toBe("ok");
    expect(body.summary.startsWith(WORK_COMPLETE_PREFIX)).toBe(true);
    expect(body.summary).toContain("all five items done");
  });

  it("never throws when the hub write fails (best-effort)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("hub down");
    }));
    await expect(reportWorkComplete("occupancy")).resolves.toBeUndefined();
  });
});
