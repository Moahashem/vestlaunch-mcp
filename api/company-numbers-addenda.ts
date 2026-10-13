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

/** Value cells the morning agents own or that nobody owns. Labels, formulas (row 6, E7) and status cells are never listed. */
export const STALE_VALUE_RANGES = [
  "B4:J5",
  "B9:F10",
  "B14:F15",
  "B16",
  "A20:E20",
  "A23:E23",
  "B26:E29",
  "H29",
  "A32:E32",
  "B35:E38",
  "A41",
  "H41",
  "A44",
  "H44",
  "H47",
  "A49",
  "A51:K100",
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
  "never copy or keep yesterday's number. The Agreements row (B28:E28) is left blank on",
  "purpose until its definition is set.",
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
