import { describe, it, expect } from "vitest";
import { CLEAR_STALE_ADDENDUM, COMBINED_B16_ADDENDUM, STALE_VALUE_RANGES } from "../../api/company-numbers-addenda";

describe("Company Numbers stale-value rule (Mo 10/12)", () => {
  it("clears the cells that carried stale numbers on 10/12", () => {
    for (const r of ["B16", "B26:E29", "A32:E32"]) expect(STALE_VALUE_RANGES).toContain(r);
  });
  it("never clears formulas, labels or status cells", () => {
    // No range may touch row 6 (combined formulas), E7 (the +90 day formula), row 50 (headers) or status cells.
    const rowsOf = (r: string) => { const m = r.match(/^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/)!; const a = Number(m[1]); const b = Number(m[2] ?? m[1]); return [a, b]; };
    for (const r of STALE_VALUE_RANGES) {
      const [a, b] = rowsOf(r);
      for (const banned of [6, 7, 50, 108, 112]) expect(banned >= a && banned <= b, `${r} touches row ${banned}`).toBe(false);
    }
  });
  it("the batchClear body is valid JSON once the tab name is filled in", () => {
    const body = CLEAR_STALE_ADDENDUM.match(/\{"ranges":\[.*?\]\}/)![0].replace(/<TODAY_TAB>/g, "10.13.2026");
    expect(JSON.parse(body).ranges[0]).toBe("'10.13.2026'!B4:J5");
  });
  it("the CFA agent writes B16 from the endpoint, never computes it", () => {
    expect(COMBINED_B16_ADDENDUM).toMatch(/Never compute B16 yourself/);
  });
});
