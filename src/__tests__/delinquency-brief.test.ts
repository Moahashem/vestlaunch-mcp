/**
 * Delinquency morning brief (api/delinquency-brief.ts). Every number in the post is
 * arithmetic over the worklist rows — these tests pin that arithmetic and the
 * wording Zulema/Mo read every morning.
 */
import { describe, expect, it } from "vitest";
import { formatBrief, formatFailure, type WorklistPayload, type WorklistRow } from "../../api/delinquency-brief";

const row = (o: Partial<WorklistRow>): WorklistRow => ({
  unit_id: "af:1", portfolio: "appfolio", property: "1 Main St, Katy, TX 77449", unit: null, state: "TX", jurisdiction: "TX",
  balance: 1000, current_period_balance: 1000, prior_balance: 0, days_past_due: 5, stage: "late_rent", late_day: 3,
  steps_due_today: [], notice: { preconditions_met: true, blocked_reason: null, required_type: "3-day notice to vacate" }, flags: [], ...o,
});

const payload = (rows: WorklistRow[], over: Partial<WorklistPayload> = {}): WorklistPayload => ({
  as_of: "2026-10-06",
  summary: { total_delinquent_units: rows.length, total_balance: rows.reduce((s, r) => s + r.balance, 0), by_state: {}, by_stage: {}, agent_steps_today: 0, human_steps_today: 0, needs_human: 0, blocked_notices: 0, cares_unknown: 0 },
  rows,
  sources: { appfolio: "ok", resman: "ok (VPS fetch ct_date 2026-10-06)" },
  rules_version: { attorney_reviewed: false },
  ...over,
});

describe("formatBrief", () => {
  it("splits past-grace from in-grace and counts Zulema's steps from the rows", () => {
    const text = formatBrief(payload([
      row({ unit_id: "a", stage: "notice_pending", balance: 2500, steps_due_today: [{ type: "notice", template_id: "tx_3day_ntv", owner: "human" }, { type: "call", template_id: "tenant_call", owner: "human" }] }),
      row({ unit_id: "b", stage: "grace", balance: 1800, days_past_due: 1 }),
      row({ unit_id: "c", stage: "grace", balance: 1200, days_past_due: 1 }),
      row({ unit_id: "d", portfolio: "resman", unit: "601", property: "Cranbrook Forest Apartments", stage: "needs_human", balance: 3300, flags: ["ResMan status Under eviction — already in eviction; ladder suppressed"] }),
    ]));
    expect(text).toContain("Tue, Oct 6");
    expect(text).toContain("Past grace: 1 units · $2,500");
    expect(text).toContain("In grace: 2 · $3,000");
    expect(text).toContain("Under eviction: 1");
    expect(text).toContain("Zulema today: 1 notice(s) to prepare · 1 tenant call(s) · 0 owner call(s) · 0 decision(s)");
    expect(text).toContain("• 1 Main St (TX) — $2,500, ~5d past due, notice pending");
    expect(text).toContain("Nothing was sent to any tenant");
    expect(text).toContain("state rules DRAFT");
  });

  it("surfaces blocked notices, frozen units, carry-overs and county jurisdiction", () => {
    const text = formatBrief(payload([
      row({ unit_id: "dc", state: "DC", jurisdiction: "DC", property: "418 Gallatin St NW, Washington, DC", balance: 468.57, stage: "late_rent", notice: { preconditions_met: false, blocked_reason: "balance $468.57 is under the DC $600 minimum to issue a notice", required_type: "30-day notice to pay or vacate" } }),
      row({ unit_id: "md", state: "MD", jurisdiction: "MD — Montgomery County, MD", property: "3002 Findley Rd, Kensington, MD 20895", balance: 1100.16, prior_balance: 1100.16, days_past_due: 31, stage: "frozen" }),
    ]));
    expect(text).toContain("Blocked: 418 Gallatin St NW — balance $468.57 is under the DC $600 minimum");
    expect(text).toContain("⚠️ FROZEN (payment after notice — Zulema must clear): 3002 Findley Rd");
    expect(text).toContain("Still owe from a prior month: 1 units · $1,100 carried");
    expect(text).toContain("(Montgomery County, MD)");
    expect(text).toContain("Past grace by state: MD 1 ($1,100) · DC 1 ($469)");
  });

  it("caps the list and says how many more; strips AppFolio prefixes; names Cranbrook units", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ unit_id: `u${i}`, property: i === 0 ? "+14102 Spring Birch Ln, Pearland, TX" : `${i} Elm St, Spring, TX`, balance: 5000 - i * 100, stage: "notice_pending" }));
    rows.push(row({ unit_id: "rm", portfolio: "resman", unit: "212", property: "Cranbrook Forest Apartments", balance: 6000, stage: "late_rent" }));
    const text = formatBrief(payload(rows), { top: 3 });
    expect(text).toContain("• Cranbrook #212 (TX) — $6,000");
    expect(text).toContain("• 14102 Spring Birch Ln (TX) — $5,000");
    expect(text).toContain("…and 8 more. Full list: get_delinquency_worklist.");
  });

  it("says so plainly when nobody is past grace, and when a source failed", () => {
    const text = formatBrief(payload([row({ stage: "grace", days_past_due: 1 })], { sources: { appfolio: "ok", resman: "FAILED: delinquency_with_aging missing" } }));
    expect(text).toContain("Nobody is past grace today.");
    expect(text).toContain("ResMan FAILED");
  });

  it("failure post names the day and the reason", () => {
    expect(formatFailure("2026-10-06", "worklist HTTP 502")).toBe("🧾 Delinquency brief — Tue, Oct 6: could not run (worklist HTTP 502). No numbers today; check /api/cron/daily-delinquency.");
  });
});
