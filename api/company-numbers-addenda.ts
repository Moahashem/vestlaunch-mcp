/**
 * Company Numbers accuracy rules (Mo, 2026-10-12: "track the root and fix that
 * too so you are always getting accurate data").
 *
 * The 10/12 audit found the root of most wrong cells: the tab steward makes each
 * day's tab by DUPLICATING yesterday's, so any value no agent rewrites that morning
 * (B16 combined delinquency, the Agreements row, the Coming Soon value) silently
 * carries yesterday's number forward, and a failed agent leaves yesterday's numbers
 * looking like today's. Blank is honest; a stale number is not.
 *
 * These are appended to the kickoff prompts (whether the prompt comes from the
 * env override or the default) so they always apply.
 */

/**
 * Value cells the morning agents own or that nobody owns. Labels, formulas (row 6,
 * E7, row 11, D16/E16) and status cells are never listed. MUST stay identical to
 * STALE_VALUE_RANGES in ffl-crm src/lib/company-numbers-sheets.ts.
 * 2026-11-24 (Mo): row 32 (Homes Under Contract) is no longer wiped daily; K4,
 * C16/F16 and column L of the onboarding block are now agent-owned values.
 */
export const STALE_VALUE_RANGES = [
  "B4:J5",
  "K4",
  "B9:F10",
  "B11:D11",
  "F11",
  "B14:F15",
  "B16",
  "C16",
  "F16",
  "A20:E20",
  "A23:E23",
  "B26:E29",
  "H29",
  "B35:E38",
  "A41",
  "H41",
  "A44",
  "H44",
  "H47",
  "A49",
  "A51:L100",
] as const;

/** For the tab steward (Sales Daily Lead Counter): clear carried-over values right after it creates the tab. */
export const CLEAR_STALE_ADDENDUM = [
  "STALE-VALUE RULE (Mo, 2026-10-12): whenever you CREATE today's tab by duplicating",
  "yesterday's, IMMEDIATELY (before writing anything, and before any other agent runs)",
  "clear the carried-over VALUES in the new tab with ONE Sheets values:batchClear via the",
  "Zapier raw MUTATING request to",
  "https://sheets.googleapis.com/v4/spreadsheets/1cZdZC2EW7yPILZXwDR7D4H180CuvdY1e7VGuO-Jz30k/values:batchClear",
  `with the body as a PRE-SERIALIZED JSON STRING: {"ranges":[${STALE_VALUE_RANGES.map((r) => `"'<TODAY_TAB>'!${r}"`).join(",")}]}`,
  "where <TODAY_TAB> is today's tab title (M.D.YYYY). Clear ONLY these ranges: never row 6,",
  "never E7, never any label, never a status cell (A108/A112 and the like). Do this only when",
  "YOU created the tab this run; if the tab already existed, skip it (another run already did).",
  "Then write your own cells as usual. A cell an agent cannot fill today must stay BLANK —",
  "never copy or keep yesterday's number. Row 28 (Agreements) is retired (Mo, 2026-11-24):",
  "leave A28:E28 blank and KEEP the empty row (Mo, 2:34 PM: clear, not delete) — never delete, insert",
  "or move rows or columns; H28 (occupancy notes header) is unaffected. Row 32 (Homes Under Contract)",
  "is NOT cleared and must be left as is.",
].join(" ");

/**
 * Template formulas and labels every new day tab must carry (Mo, 2026-11-24).
 * MUST stay identical to TEMPLATE_CELLS in ffl-crm src/lib/company-numbers-sheets.ts,
 * which writes them natively when the steward uses sheets_create_day_tab. On the
 * Zapier path the steward writes them right after the stale clear.
 */
export const TEMPLATE_CELLS: ReadonlyArray<{ cell: string; value: string }> = [
  { cell: "F6", value: '=IF(COUNT(F4:F5)<2,"",F4+F5)' },
  { cell: "C6", value: '=IFERROR(IF(COUNT(C4:C5,$G4:$G5)<4,"",(C4*$G4+C5*$G5)/($G4+$G5)),"")' },
  { cell: "D6", value: '=IFERROR(IF(COUNT(D4:D5,$G4:$G5)<4,"",(D4*$G4+D5*$G5)/($G4+$G5)),"")' },
  { cell: "E6", value: '=IFERROR(IF(COUNT(E4:E5,$G4:$G5)<4,"",(E4*$G4+E5*$G5)/($G4+$G5)),"")' },
  // B11/C11/D11/F11 are values written by the CFA agent (Mo 11/24: today..+90), never templated.
  { cell: "E11", value: '=IFERROR(JOIN(" - ",ARRAYFORMULA(REGEXEXTRACT(SPLIT(E9," - "),"^[A-Za-z]+")&"("&(VALUE(REGEXEXTRACT(SPLIT(E9," - "),"\\((\\d+)\\)"))+VALUE(REGEXEXTRACT(SPLIT(E10," - "),"\\((\\d+)\\)")))&")")),"")' },
  { cell: "D16", value: '=IF(COUNT(D14:D15)<2,"",D14+D15)' },
  { cell: "E16", value: '=IF(COUNT(E14:E15)<2,"",E14+E15)' },
  { cell: "K3", value: "Doors added in AppFolio (this month)" },
  { cell: "A28", value: "" },
  { cell: "E34", value: "VestLaunch leads still in New Inquiry (30d)" },
  { cell: "L50", value: "Orientation held" },
];

/** values:batchUpdate body for the template cells, as the exact JSON string the steward sends. */
export function templateBatchBody(tab = "<TODAY_TAB>"): string {
  return JSON.stringify({
    valueInputOption: "USER_ENTERED",
    data: TEMPLATE_CELLS.map((t) => ({ range: `'${tab}'!${t.cell}`, values: [[t.value]] })),
  });
}

/** For the tab steward on the Zapier path: write the template right after the stale clear. */
export const TEMPLATE_ADDENDUM = [
  "TEMPLATE RULE (Mo, 2026-11-24): right after the stale-value clear, and only when YOU created",
  "today's tab this run, write the standing formulas and labels with ONE Sheets values:batchUpdate",
  "via the Zapier raw MUTATING request to",
  "https://sheets.googleapis.com/v4/spreadsheets/1cZdZC2EW7yPILZXwDR7D4H180CuvdY1e7VGuO-Jz30k/values:batchUpdate",
  `with the body as this PRE-SERIALIZED JSON STRING (replace <TODAY_TAB> with today's tab title): ${templateBatchBody()}`,
  "Send it exactly as given; never edit a formula. If the write fails, say so in your report and",
  "carry on with your counts. Never write these cells on a tab you did not create.",
].join(" ");

/** For the CFA agent: write B16 from the endpoint, never compute it. */
export const COMBINED_B16_ADDENDUM = [
  "COMBINED DELINQUENCY RULE (Mo, 2026-10-12): get_cfa_numbers now returns",
  "combined.cells.B16_combined_delinquency_pct, computed in VestLaunch from both",
  "businesses' real owed and billed amounts. Write it to B16 as a percent (e.g. 9.2%) as",
  "part of your scope. If it is null, leave B16 BLANK. Never compute B16 yourself and",
  "never keep a previous value. Renewals B10 and D10 now come from ResMan's renewal",
  "matrix (expiring / signed renewals this month); write them exactly as returned.",
].join(" ");

/** For the CFA agent: Cranbrook boundary cells and the 259-door constant (Mo, 2026-11-24). */
export const CFA_BOUNDARIES_ADDENDUM = [
  "CRANBROOK BOUNDARY RULE (Mo, 2026-11-24): this replaces any 'never C15/F15' wording.",
  "get_cfa_numbers now also returns, from VestLaunch's own daily history:",
  "occupancy.cells.C5_start_of_week_pct -> C5, D5_start_of_month_pct -> D5,",
  "E5_last_of_prev_month_pct -> E5; delinquency.cells.C15_start_of_week_pct -> C15,",
  "F15_last_month_pct -> F15; combined.cells.C16_combined_start_of_week_pct -> C16,",
  "F16_combined_last_month_pct -> F16. Write each as a percent, like B5 and B15. G5 is",
  "occupancy.cells.G5_total_doors, which is now always 259 (the door count Mo gave). Any null",
  "cell stays BLANK; never compute, copy or carry a value. If stale=true write nothing, as before.",
  "ROW 11 (Mo, 2026-11-24, today through the next 90 days): write combined.cells.B11_expiring_90d -> B11,",
  "C11_pending_90d -> C11, D11_signed_90d -> D11 (counts) and F11_renewal_pct_90d -> F11 (percent).",
  "They are FFL (exactly today..+90) + Cranbrook (the 3 whole months that best cover that window, listed in",
  "combined.row11_inputs.windows.cranbrook_months), computed for you; null => leave BLANK. Never touch E11.",
].join(" ");

/** For the CF leads agent: tours row 36, the E34 label and the snapshot source tag (Mo, 2026-11-24). */
export const CF_LEADS_TOURS_ADDENDUM = [
  "TOURS + LABEL RULE (Mo, 2026-11-24): get_cf_lead_numbers now also returns tours.cells.",
  "Besides B35:E35, write tours.cells.B36_tours_this_week -> B36, C36_tours_this_month -> C36,",
  "D36_tours_last_month -> D36 in the same batch, then read back B35:E36. If tours.cells is null,",
  "leave B36:D36 BLANK and still write the leads. E35 is 'VestLaunch leads still in New Inquiry",
  "(30d)' (the E34 label). These counts come from VestLaunch, not LeadSimple: if you save a metric",
  "snapshot, use source 'internal', never 'leadsimple'.",
].join(" ");

/** For the occupancy agent: K4 next to I4 (Mo, 2026-11-24). */
export const OCCUPANCY_K4_ADDENDUM = [
  "K4 RULE (Mo, 2026-11-24): with row 4, also write K4 = doors_added_this_month from the",
  "ffl-portfolio numbers (managed doors added to AppFolio this month, same rows as I4). K3 is its label.",
  "If it is null, leave K4 BLANK. It is informational only: never change how I4 or J4 are",
  "written.",
].join(" ");

/** For the onboarding agent: column L 'Orientation held' (Mo, 2026-11-24). */
export const ONBOARDING_ORIENTATION_ADDENDUM = [
  "ORIENTATION HELD RULE (Mo, 2026-11-24): the block is now A51:L78. Column L (header L50",
  "'Orientation held') gets ☑ when the row's orientationHeld is true and ☐ when it is false.",
  "Blank unused rows through L78. Rows whose management has ended are already removed by",
  "get_ffl_onboarding; do not add them back.",
].join(" ");

/** For the ShowMojo agent: tenant-in-place flags on the to-list (Mo, 2026-11-24). */
export const SHOWMOJO_FLAGS_ADDENDUM = [
  "TO-LIST FLAG RULE (Mo, 2026-11-24): some to_list_block lines now end with '— FLAG: ...'",
  "(AppFolio shows a tenant on a current lease, or the owner said PM-only with a tenant in",
  "place), and every line now carries 'N days vacant (since <basis> M/D/YYYY)' (Mo, 10:41 AM).",
  "Former tenants (moved out or Past) never flag. Write the block verbatim, flags and days",
  "vacant included. D20 and E20 are unchanged: write",
  "homes_to_list and fmr_potential exactly as returned.",
].join(" ");
