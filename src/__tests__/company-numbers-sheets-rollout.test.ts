import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { directSheetsAddendum, usesDirectSheets } from "../../api/company-numbers-sheets-rollout";
const file = (s: string) => readFileSync(new URL(`../../${s}`, import.meta.url), "utf8");
afterEach(() => vi.unstubAllEnvs());
describe("ShowMojo-first rollout", () => {
  it("does not silently cut over any agent by deploying", () => { vi.stubEnv("COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS", ""); expect(directSheetsAddendum("showmojo")).toBe(""); });
  it("only opts in the named agent", () => { vi.stubEnv("COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS", "showmojo"); expect(usesDirectSheets("showmojo")).toBe(true); for (const key of ["sales-lead-count", "occupancy", "cfa", "cf-leads"]) expect(usesDirectSheets(key)).toBe(false); });
  it("preserves D16 and forbids Zapier fallback", () => { vi.stubEnv("COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS", "showmojo"); const s = directSheetsAddendum("showmojo"); expect(s).toContain("empty strings"); expect(s).toContain("never pre-serialized"); expect(s).toContain("LeadSimple lookups only"); expect(s).toContain("WRITER ONLY"); expect(s).toContain("status and alert cells"); });
  it("Sales replaces legacy tab addenda only after opt-in", () => { const s = file("api/cron/daily-lead-count.ts"); expect(s).toContain('usesDirectSheets("sales-lead-count")'); expect(s).toContain("${CLEAR_STALE_ADDENDUM}"); vi.stubEnv("COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS", "sales-lead-count"); expect(directSheetsAddendum("sales-lead-count")).toContain("housekeeping_only:true"); });
  it("all five cron kickoff bodies include the rollout addendum", () => { for (const name of ["showmojo", "lead-count", "occupancy", "cfa", "cf-leads"]) expect(file(`api/cron/daily-${name}.ts`)).toContain("directSheetsAddendum("); });
  it("registers the new transport route and health entry", () => { const s = file("server.ts"); expect(s).toContain('if (path === "/api/sheets-mcp")'); expect(s).toContain('await sheetsMcpHandler(req, res)'); expect(s).toContain('sheets: { tools: SHEETS_TOOL_NAMES, crm_endpoints: SHEETS_BACKEND_ROUTES }'); expect((s.match(/"\/api\/sheets-mcp"/g) || []).length).toBe(2); });
});
