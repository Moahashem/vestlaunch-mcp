import { describe, it, expect } from "vitest";
import {
  CFA_BOUNDARIES_ADDENDUM,
  CF_LEADS_TOURS_ADDENDUM,
  CLEAR_STALE_ADDENDUM,
  COMBINED_B16_ADDENDUM,
  OCCUPANCY_K4_ADDENDUM,
  ONBOARDING_ORIENTATION_ADDENDUM,
  SHOWMOJO_FLAGS_ADDENDUM,
  STALE_VALUE_RANGES,
  TEMPLATE_ADDENDUM,
  TEMPLATE_CELLS,
  templateBatchBody,
} from "../../api/company-numbers-addenda";

describe("Company Numbers stale-value rule (Mo 10/12)", () => {
  it("clears the cells that carried stale numbers on 10/12", () => {
    for (const r of ["B16", "B26:E29"]) expect(STALE_VALUE_RANGES).toContain(r);
  });
  it("no longer wipes row 32 (Homes Under Contract) every morning (Mo 11/24)", () => {
    const rowsOf = (r: string) => { const m = r.match(/^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/)!; return [Number(m[1]), Number(m[2] ?? m[1])]; };
    for (const r of STALE_VALUE_RANGES) { const [a, b] = rowsOf(r); expect(32 >= a && 32 <= b, r).toBe(false); }
    expect(CLEAR_STALE_ADDENDUM).toMatch(/Row 32 \(Homes Under Contract\) is NOT cleared/);
    expect(CLEAR_STALE_ADDENDUM).toMatch(/leave A28:E28 blank and KEEP the empty row/);
    expect(CLEAR_STALE_ADDENDUM).toMatch(/never delete, insert or move rows or columns/);
  });
  it("matches ffl-crm's STALE_VALUE_RANGES exactly (copy kept in both repos)", () => {
    expect([...STALE_VALUE_RANGES]).toEqual([
      "B4:J5", "K4", "B9:F10", "B11:D11", "F11", "B14:F15", "B16", "C16", "F16", "A20:E20", "A23:E23", "B26:E29", "H29",
      "B35:E38", "A41", "H41", "A44", "H44", "H47", "A49", "A51:L100",
    ]);
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

describe("Company Numbers 11/24 fixes (Mo)", () => {
  it("template body is valid JSON, USER_ENTERED, and never touches a stale-cleared or status cell", () => {
    const body = JSON.parse(templateBatchBody("11.25.2026"));
    expect(body.valueInputOption).toBe("USER_ENTERED");
    expect(body.data.map((d: { range: string }) => d.range)).toContain("'11.25.2026'!F6");
    for (const t of TEMPLATE_CELLS) expect(["B16", "A100", "A104", "A108", "A112", "A116", "A120"]).not.toContain(t.cell);
    const inPrompt = TEMPLATE_ADDENDUM.match(/\{"valueInputOption".*\}\]\}/)![0];
    expect(JSON.parse(inPrompt).data).toHaveLength(TEMPLATE_CELLS.length);
  });
  it("E11 keeps its regex backslashes", () => {
    expect(TEMPLATE_CELLS.find((t) => t.cell === "E11")!.value).toContain(String.raw`"\((\d+)\)"`);
  });
  it("labels Mo asked for", () => {
    const v = Object.fromEntries(TEMPLATE_CELLS.map((t) => [t.cell, t.value]));
    expect(v.E34).toBe("VestLaunch leads still in New Inquiry (30d)");
    expect(v.K3).toBe("Doors added in AppFolio (this month)");
    expect(v.L50).toBe("Orientation held");
    expect(v.A28).toBe("");
    expect(v.F6).toBe('=IF(COUNT(F4:F5)<2,"",F4+F5)');
  });
  it("each agent addendum names its cells and keeps blank-on-null", () => {
    expect(CFA_BOUNDARIES_ADDENDUM).toMatch(/C5.*D5.*E5.*C15.*F15.*C16.*F16/s);
    expect(CFA_BOUNDARIES_ADDENDUM).toMatch(/259/);
    expect(CFA_BOUNDARIES_ADDENDUM).toMatch(/B11_expiring_90d -> B11.*C11_pending_90d -> C11.*D11_signed_90d -> D11.*F11_renewal_pct_90d -> F11/s);
    expect(CFA_BOUNDARIES_ADDENDUM).toMatch(/exactly today\.\.\+90.*cranbrook_months.*Never touch E11/s);
    expect(CFA_BOUNDARIES_ADDENDUM).toMatch(/null\s+cell stays BLANK/);
    expect(CF_LEADS_TOURS_ADDENDUM).toMatch(/B36.*C36.*D36/s);
    expect(CF_LEADS_TOURS_ADDENDUM).toMatch(/source 'internal', never 'leadsimple'/);
    expect(OCCUPANCY_K4_ADDENDUM).toMatch(/K4 BLANK/);
    expect(OCCUPANCY_K4_ADDENDUM).toMatch(/never change how I4 or J4/);
    expect(OCCUPANCY_K4_ADDENDUM).toMatch(/doors_added_this_month/);
    expect(ONBOARDING_ORIENTATION_ADDENDUM).toMatch(/A51:L78/);
    expect(SHOWMOJO_FLAGS_ADDENDUM).toMatch(/D20 and E20 are unchanged/);
    expect(SHOWMOJO_FLAGS_ADDENDUM).toMatch(/days vacant/);
  });
  it("no addendum asks an agent to read or write B16 beyond the existing CFA rule", () => {
    for (const a of [CFA_BOUNDARIES_ADDENDUM, CF_LEADS_TOURS_ADDENDUM, OCCUPANCY_K4_ADDENDUM, ONBOARDING_ORIENTATION_ADDENDUM, SHOWMOJO_FLAGS_ADDENDUM, TEMPLATE_ADDENDUM]) {
      expect(a).not.toMatch(/\bB16\b/);
    }
    expect(COMBINED_B16_ADDENDUM).toMatch(/B16/);
  });
});
