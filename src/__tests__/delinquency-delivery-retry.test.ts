import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
vi.mock("../../api/delinquency-brief", () => ({
  fetchWorklist: vi.fn(async () => ({ rows: [{ stage: "late_rent" }] })),
  formatBrief: () => "Staff late-rent summary. Nothing sent to tenants.",
  formatFailure: () => "Could not compute staff brief.",
}));
import handler, { hasConfirmedBriefDelivery } from "../../api/cron/daily-delinquency";
import { fetchWorklist } from "../../api/delinquency-brief";
import { shouldSkipRedundantKickoff } from "../../api/workforce-hub";

type Row = { status: string; summary: string; payload?: Record<string, unknown> };
const date = "2026-11-12";
let rows: Row[];
let sendReply: unknown;
let sendCalls: number;
async function run(query = "") {
  let result: any;
  const res = { statusCode: 0, setHeader: vi.fn(), end: (text: string) => { result = JSON.parse(text); } };
  await handler({ url: `/api/cron/daily-delinquency${query}`, headers: { authorization: "Bearer test-cron" } } as IncomingMessage, res as unknown as ServerResponse);
  return { status: res.statusCode, body: result };
}
beforeEach(() => {
  rows = []; sendReply = { ok: true, chatId: "staff-test-chat" }; sendCalls = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date(`${date}T12:00:00Z`));
  vi.stubEnv("CRON_SECRET", "test-cron"); vi.stubEnv("FFL_WORKFORCE_API_KEY", "test-key");
  vi.stubEnv("RUCKUS_SEND_TOKEN", "test-token"); vi.stubEnv("DELINQUENCY_BRIEF_DRY_RUN", "");
  vi.stubEnv("VESTLAUNCH_BASE_URL", "https://crm.example.test");
  vi.mocked(fetchWorklist).mockResolvedValue({ rows: [{ stage: "late_rent" }] } as any);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/v1/agent/run-status")) {
      if (init?.method === "POST") { rows.push(JSON.parse(String(init.body))); return Response.json({ success: true }); }
      return Response.json({ success: true, data: rows });
    }
    if (url.endsWith("/api/ringcentral/ruckus-send")) { sendCalls++; return Response.json(sendReply); }
    throw new Error(`Unexpected test request: ${url}`);
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("morning staff brief and 6:30 CST retry", () => {
  it("records a disabled HTTP200 as failed and lets the retry run", async () => {
    sendReply = { ok: false, skipped: "ruckus_disabled", note: "Ruckus is off. Nothing was posted." };
    expect((await run()).status).toBe(502);
    expect(rows[0]).toMatchObject({ status: "failed", needsHuman: true, payload: {
      report: expect.stringContaining("Staff late-rent"), delivery: { posted: false, error: expect.stringContaining("ruckus_disabled") },
    } });
    vi.setSystemTime(new Date(`${date}T12:30:00Z`));
    expect((await run()).status).toBe(502);
    expect(sendCalls).toBe(2);
  });
  it("does not cancel on legacy false successes, counts or WORK COMPLETE text", async () => {
    rows.push({ status: "ok", summary: `delinquency brief ${date} posted to Ruckus (4 past grace)` },
      { status: "ok", summary: `WORK COMPLETE ${date}` });
    vi.setSystemTime(new Date(`${date}T12:30:00Z`));
    expect((await run()).body.posted).toBe(true);
    expect(sendCalls).toBe(1);
  });
  it("saves truthful report detail and acknowledgment, then suppresses a confirmed duplicate", async () => {
    expect((await run()).body.posted).toBe(true);
    expect(rows[0]).toMatchObject({ status: "ok", payload: {
      version: 1, kind: "delinquency-morning-brief", date, report: expect.any(String),
      delivery: { posted: true, confirmation: "ruckus-send-response", chatId: "staff-test-chat", confirmedAt: `${date}T12:00:00.000Z` },
      evidenceLimit: expect.stringContaining("not independent provider delivery"),
    } });
    vi.setSystemTime(new Date(`${date}T12:30:00Z`));
    expect((await run()).body.skipped).toBe("spend guard: already posted today");
    expect(sendCalls).toBe(1);
  });
  it("does not let a delivered failure notice cancel the actual brief retry", async () => {
    vi.mocked(fetchWorklist).mockRejectedValueOnce(new Error("source unavailable"));
    expect((await run()).body.failure_posted).toBe(true);
    expect(rows[0]).toMatchObject({ status: "failed", payload: { kind: "delinquency-failure-notice" } });
    vi.setSystemTime(new Date(`${date}T12:30:00Z`));
    expect((await run()).body.posted).toBe(true);
    expect(sendCalls).toBe(2);
  });
  it("dry runs create neither a post nor a completion record", async () => {
    expect((await run("?dry=1")).body.dry_run).toBe(true);
    expect(sendCalls).toBe(0); expect(rows).toEqual([]);
  });
  it("leaves the default guard behavior for other jobs unchanged", async () => {
    rows.push({ status: "ok", summary: "kickoff" }, { status: "ok", summary: "kickoff" });
    expect(await shouldSkipRedundantKickoff("occupancy")).toBe(true);
  });
  it.each(["2026-11-11T12:00:00Z", "2026-11-13T12:00:00Z", "invalid"])("rejects stale, future or invalid confirmation %s", confirmedAt => {
    expect(hasConfirmedBriefDelivery({ status: "ok", payload: { version: 1, kind: "delinquency-morning-brief", date,
      delivery: { posted: true, confirmation: "ruckus-send-response", confirmedAt } } }, date)).toBe(false);
  });
  it("does not accept a partial row or summary alone as delivery proof", () => {
    expect(hasConfirmedBriefDelivery({ status: "ok" }, date)).toBe(false);
    expect(hasConfirmedBriefDelivery({ status: "partial", payload: { version: 1, kind: "delinquency-morning-brief", date,
      delivery: { posted: true, confirmation: "ruckus-send-response", confirmedAt: `${date}T12:00:00Z` } } }, date)).toBe(false);
  });
});
