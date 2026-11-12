/**
 * THE DAILY RECRUITING MESSAGE (2026-08-26).
 *
 * This message is the only place Lando learns that a recruiting day needed him,
 * and it has now broken three separate ways:
 *
 *  1. #70 sliced the all-clear line "Nothing needs you." into a bare
 *     "needs you." — an alarm on a quiet day.
 *  2. #71 fixed that by demanding an uppercase line-start marker, while the
 *     cron kickoff prompt kept asking the agent for "👉 Needs you:". A report
 *     written to the kickoff's wording would have lost its reason entirely and
 *     printed the all-clear under a header shouting NEEDS MO.
 *  3. The reason, when it did survive, was printed BELOW the routine "Did:"
 *     list — so a day that needed him opened exactly like a quiet one.
 *
 * Each case below is one of those failures, locked.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { composeReport, postToRuckusChannel } from "../../api/recruiting-report.js";

describe("postToRuckusChannel delivery confirmation", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubEnv("RUCKUS_SEND_TOKEN", "test-only-token");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("requires an affirmative JSON delivery result", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    expect(await postToRuckusChannel("Staff summary")).toEqual({ posted: true, delivery: {
      confirmation: "ruckus-send-response", confirmedAt: expect.any(String),
    } });
  });

  it("reports the disabled reason instead of recording a successful send", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: false, skipped: "ruckus_disabled", note: "Ruckus is off. Nothing was posted." }));
    const result = await postToRuckusChannel("Staff summary");
    expect(result.posted).toBe(false);
    expect(result.error).toContain("ruckus_disabled");
    expect(result.error).toContain("Nothing was posted.");
  });

  it.each([
    { ok: false }, {}, null, [], { ok: "true" },
    { ok: true, skipped: "duplicate" }, { ok: true, skipped: false },
    { ok: true, held: true }, { ok: true, posted: false },
    { ok: true, note: "Nothing was posted." },
    { ok: true, dryRun: true }, { ok: true, quiet: true }, { ok: true, deferred: true },
    { ok: true, sent: false }, { ok: true, note: "Test post — not sent to any chat." },
  ])("does not claim delivery for %j", async reply => {
    fetchMock.mockResolvedValue(Response.json(reply));
    expect(await postToRuckusChannel("Staff summary")).toEqual({ posted: false, error: expect.any(String) });
  });

  it.each(["", "not JSON", "<html>upstream error</html>"])("does not throw for an invalid success body: %j", async body => {
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
    expect(await postToRuckusChannel("Staff summary")).toEqual({ posted: false, error: expect.stringContaining("JSON") });
  });

  it("preserves HTTP failure details", async () => {
    fetchMock.mockResolvedValue(new Response("unavailable", { status: 503 }));
    expect(await postToRuckusChannel("Staff summary")).toEqual({ posted: false, error: "HTTP 503: unavailable" });
  });

  it("returns network failures without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("connection failed"));
    expect(await postToRuckusChannel("Staff summary")).toEqual({ posted: false, error: "connection failed" });
  });
});

const DID = {
  block: "Did:\n- Invited 3 new applicants (1 by email, 2 by Indeed message)\n\n(counted from 3 send receipts)",
  total: 3,
};
const STAMP = "2026-08-26";
const base = { status: "ok", summary: "3 invites sent", did: DID, dateStamp: STAMP };

// The real 2026-08-26 08:35 report, verbatim from the Console transcript.
const REAL_REPORT =
  "NEEDS YOU:\n- One person completed the video screening but entered their email address as " +
  "their name — no real name is on file, so no assessment invite was sent to " +
  "klau24_1198@hotmail.com. Check VideoAsk for this contact and send manually if they're a " +
  "real candidate.";

describe("composeReport", () => {
  it("puts the ask above the routine list, not below it", () => {
    const out = composeReport({ ...base, report: REAL_REPORT, needsHuman: true });
    expect(out.indexOf("klau24_1198@hotmail.com")).toBeLessThan(out.indexOf("Did:"));
  });

  it("says NEEDS YOU once — the header carries it, the block is just the ask", () => {
    const out = composeReport({ ...base, report: REAL_REPORT, needsHuman: true });
    expect(out.match(/NEEDS YOU/g)).toHaveLength(1);
  });

  it("strips the marker line without eating the first bullet's dash", () => {
    const out = composeReport({
      ...base,
      report: "NEEDS YOU:\n- first thing\n- second thing",
      needsHuman: true,
    });
    expect(out).toContain("- first thing\n- second thing");
  });

  it("uses one vocabulary — never NEEDS MO in the header and NEEDS YOU below", () => {
    const out = composeReport({ ...base, report: REAL_REPORT, needsHuman: true });
    expect(out).not.toContain("NEEDS MO");
    expect(out.split("\n")[0]).toContain("👉 NEEDS YOU");
  });

  it("keeps the reason when the agent writes the kickoff prompt's Title-Case marker", () => {
    const out = composeReport({
      ...base,
      report: "3 invites sent.\n👉 Needs you:\n- A mailbox could not be read.",
      needsHuman: true,
    });
    expect(out).toContain("A mailbox could not be read.");
    expect(out).not.toContain("Nothing needs you.");
    // The narration above the marker is still discarded — receipts own the numbers.
    expect(out).not.toContain("3 invites sent.");
  });

  it("says so when the run is flagged but the reason did not come through", () => {
    const out = composeReport({ ...base, report: "3 invites sent, all quiet.", needsHuman: true });
    expect(out.split("\n")[0]).toContain("👉 NEEDS YOU");
    expect(out).toContain("the reason did not come through");
    expect(out).not.toContain("Nothing needs you.");
  });

  it("still flags the header when the agent wrote a block but forgot needsHuman", () => {
    const out = composeReport({ ...base, report: REAL_REPORT, needsHuman: false });
    expect(out.split("\n")[0]).toContain("👉 NEEDS YOU");
    expect(out).toContain("klau24_1198@hotmail.com");
  });

  it("leaves a quiet day quiet — no flag, all-clear last", () => {
    const out = composeReport({ ...base, report: "Nothing needs you." });
    expect(out.split("\n")[0]).not.toContain("NEEDS YOU");
    expect(out).toContain("Did:");
    expect(out.trim().endsWith("Nothing needs you.")).toBe(true);
    // #70's bug: the all-clear must never be sliced into a bare "needs you."
    expect(out).not.toMatch(/\n\s*needs you\.\s*$/);
  });

  it("does not print the reason twice when the receipt store is unreachable", () => {
    const out = composeReport({
      status: "ok",
      summary: "3 invites sent",
      report: REAL_REPORT,
      needsHuman: true,
      did: null,
      dateStamp: STAMP,
    });
    expect(out.match(/klau24_1198@hotmail\.com/g)).toHaveLength(1);
  });

  it("marks a failed run with ❌ and posts the summary when there is no report", () => {
    const out = composeReport({
      status: "failed",
      summary: "gmail auth expired",
      did: null,
      dateStamp: STAMP,
    });
    expect(out.startsWith("❌")).toBe(true);
    expect(out).toContain("gmail auth expired");
  });
});
