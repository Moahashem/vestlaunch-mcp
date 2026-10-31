/** Explicit per-agent rollout. Default is no cutover; do not turn on the other
 * four until TWO dated ShowMojo morning receipts have been reviewed. This only
 * selects the kickoff transport; the live system prompt/toolset must be saved
 * and verified too. Keep Zapier connected for LeadSimple lookups only. */
const AGENTS = new Set(["showmojo", "sales-lead-count", "occupancy", "cfa", "cf-leads"]);
export function usesDirectSheets(agentKey: string): boolean {
  return AGENTS.has(agentKey) && (process.env.COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS || "").split(",").map((s) => s.trim()).includes(agentKey);
}
export function directSheetsAddendum(agentKey: string): string {
  if (!usesDirectSheets(agentKey)) return "";
  return [
    "DIRECT SHEETS TRANSPORT (replaces all Zapier Google Sheets instructions):",
    "Use sheets_read({ranges:[\"'<TODAY_TAB>'!<range>\"]}) for tab/status checks and read-back.",
    "Use sheets_batch_update({data:[{range:\"'<TODAY_TAB>'!<range>\",values:[[...]]}],value_input_option:'RAW'}) for writes.",
    "Pass structured objects, never pre-serialized strings. Use USER_ENTERED only for intentional existing percent/formula parsing.",
    "The server hard-allows only the Company Numbers spreadsheet. Never use Zapier for Sheets, including on native-tool errors.",
    "Keep all current KPI definitions, owned ranges, A-column status and alert cells, and manual-carry rules exactly unchanged.",
    "D16 takes precedence over leave-cells-unchanged wording: if a source errors or fails its gate, clear ONLY that source's owned output cells with empty strings, leave its flag not-done, write the existing alert, and retry. Never write null or stale numbers.",
    "Read back written values before claiming completion; a write failure cannot be marked done. Zapier is allowed for LeadSimple lookups only, never discovery/enabling of other apps.",
    agentKey === "sales-lead-count"
      ? "TAB STEWARD: call sheets_create_day_tab({date:'YYYY-MM-DD'}) first. It duplicates the latest previous date tab, atomically clears the established stale ranges and verifies rightmost placement. Do not separately duplicate or batchClear. Existing tabs are never cleared on retry. After your full scope completes, call sheets_create_day_tab({date:'YYYY-MM-DD',housekeeping_only:true}) to hide older date tabs; housekeeping errors must not block counts."
      : "WRITER ONLY: do not call sheets_create_day_tab. If today's tab is missing, stop and report.",
  ].join(" ");
}
