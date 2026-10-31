# Company Numbers direct Sheets rollout

Status: implementation prepared 2026-10-31; no agent switched yet. Live agent configuration inspection is blocked by Claude Platform browser verification. Do not equate a deployed tool with a completed migration.

## Transport and authorization

The CRM `/api/v1/me` manifest registers `sheets_read` (GET `/api/v1/sheets/read`), `sheets_batch_update` (POST `/api/v1/sheets/batch-update`), and `sheets_create_day_tab` (POST `/api/v1/sheets/create-day-tab`) on the existing `/api/mcp` and stdio server. `/api/sheets-mcp` is an optional three-tool-only alias, explicitly routed in `server.ts` and listed in `/health`. Existing agents should KEEP the existing MCP URL so vault credential bindings do not change.

The CRM uses Vercel OIDC → Google STS → the existing `GCP_SERVICE_ACCOUNT_EMAIL` service account, with `https://www.googleapis.com/auth/spreadsheets`. GA4 continues to request only `analytics.readonly`. The only allowed spreadsheet is `1cZdZC2EW7yPILZXwDR7D4H180CuvdY1e7VGuO-Jz30k`. No arbitrary URL or template argument. The backend requires agent:read / agent:write and an FFL or AI Ops workspace key; legacy hosted writes still require `VESTLAUNCH_ENABLE_WRITES=true` plus the existing write allowlist. Add only `sheets_batch_update,sheets_create_day_tab` to that allowlist, preserving existing entries.

Documented GA4 service account: `ffl-scorecard-ga4@stalwart-method-489818-r3.iam.gserviceaccount.com` (`ffl-crm/src/__tests__/ga4-auth.test.ts`). Production Vercel stores the value as sensitive, so the downloaded environment cannot verify it. A direct read response returns `service_account_email`; a Google error identifies the configured account. Mo must share the KPI spreadsheet with that account as Editor; enable the Google Sheets API in the same GCP project if necessary. No downloaded service-account key.

CRM mutation gate: `COMPANY_NUMBERS_SHEETS_ENABLED=true`. Reads work without this switch, allowing preflight before writes. Rollback: remove the selected agent from `COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS`, restore its saved previous prompt/toolset, and keep Zapier Sheets until final retirement. Disabling the CRM mutation gate alone is an emergency stop, not a functioning rollback for a migrated agent.

## Preserve data behavior

Use `{ranges:["'10.31.2026'!A104"]}` to read and `{data:[{range:"'10.31.2026'!A20:B20",values:[[12,34567]]}]}` to write. Objects, not serialized JSON strings. RAW is default; explicit USER_ENTERED preserves existing intentional percent/formula parsing. Empty strings clear; null/undefined/nonfinite values are rejected. On source failure: clear ONLY the failed source's current owned ranges, leave that status not-done, set its existing alert cells, retry. Do not fall back to Zapier.

Do not migrate cell locations based on the old registry: it names A50–A59 while current crons use A100+ (ShowMojo A104, Sales A108). Export and inspect the LIVE system prompts/toolsets first. Preserve all existing current status/alert cell references and source definitions.

Sales alone calls `sheets_create_day_tab({date:'YYYY-MM-DD'})`. It duplicates the latest earlier daily tab, clears the existing Oct 12 stale range list in the SAME atomic batch, and verifies far-right placement. Retries never clear an existing tab. After all Sales work, call again with `housekeeping_only:true` to hide date tabs older than the trailing seven days. Others are writer-only and stop on a missing tab.

## Stages and evidence

1. Deploy both PRs and verify `/health`, `tools/list`, backend authorization and foreign-ID rejection. Using the production CRM identity, read today's existing cells, confirm the service account, then perform a supervised write/read-back only to ShowMojo-owned output using verified source data. Do not fabricate KPI values for tests.
2. Export all five active agent configs and version IDs as rollback evidence. For ShowMojo ONLY, replace the Zapier Sheets recipe with `directSheetsAddendum('showmojo')`, add `sheets_read` and `sheets_batch_update` to the existing VestLaunch MCP toolset, preserve all source tools and cells, and forbid Zapier except LeadSimple lookups. Save/read back the new active version. Do not add tab-creation authority to ShowMojo.
3. Set `COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS=showmojo` on the MCP project; keep the other four on Zapier. The cron addendum overrides any older leave-stale wording and applies even with an env-provided kickoff.
4. Verify TWO separate scheduled mornings after cutover. For each, record CT date, session/version, source diagnostics and as_of, native tool calls, actual current owned values/details/status/alerts, read-back match, no C20 or unrelated writes, and no ShowMojo Zapier Sheets calls. A kickoff HTTP 200 or two same-day retries are NOT two mornings. On an error, validate clear-on-error and stop promotion.
5. Only after both receipts pass, update Sales, AppFolio, CFA and CF Leads active prompts/toolsets similarly; add the tab tool to Sales only. Preserve Zapier for LeadSimple lookups. Set the rollout env to `showmojo,sales-lead-count,occupancy,cfa,cf-leads`. Verify each agent's full scope and read-back; Sales no longer receives Zapier duplicate/clear/hide kickoff instructions.
6. Inspect **mcp.zapier.com → Claude MCP Server → History** across a complete all-five daily cycle including retries. Record Google Sheets call count and the time window. Only after it is approximately zero, remove Google Sheets from that server, preserve LeadSimple, and verify the remaining enabled apps. Update Company HQ registry write path and rollout receipts. Do not remove Sheets during the canary.

## Current evidence

- Native endpoint lifecycle/validation/authorization and GA4 regression tests are implemented.
- MCP rollout tests ensure default-off and ShowMojo-only selection; server route/health wiring covered.
- Live prompt exports: pending browser login ("We couldn’t verify your browser").
- Service-account Editor access / production WIF proof: pending.
- ShowMojo morning receipts: 0/2. All other agent switches, Zapier history proof and Sheets removal: pending.
