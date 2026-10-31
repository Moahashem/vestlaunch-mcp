// Offline only: prepare a reviewable proposal from the authenticated inspector's
// export. Never edits a live agent. Keep exports/proposals outside this repo.
// node scripts/prepare-company-numbers-migration.mjs export.json proposal.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sources = {
  showmojo: ['get_ffl_homes'],
  'sales-lead-count': ['count_landlord_leads', 'get_ffl_sales_calls', 'get_ffl_sales_signups', 'get_ffl_huddle_sales'],
  occupancy: ['get_ffl_occupancy', 'get_ffl_renewals', 'get_ffl_delinquency', 'get_ffl_leasing', 'get_ffl_huddle_appfolio'],
  cfa: ['get_cfa_numbers', 'get_ffl_delinquency'],
  'cf-leads': ['get_cf_lead_numbers'],
};
const endMarkers = { showmojo: '- Homes header', occupancy: '- Occupancy header', cfa: '- Occupancy map', 'cf-leads': '- Cell map', 'sales-lead-count': '== DAILY' };

export function prepareMigration(exported) {
  const { agent_key: key, fingerprint, agent } = exported;
  if (!Object.hasOwn(sources, key)) throw new Error('Unknown agent');
  const actual = createHash('sha256').update(JSON.stringify({ system: agent.system, tools: agent.tools, mcp_servers: agent.mcp_servers, version: agent.version })).digest('hex');
  if (actual !== fingerprint) throw new Error('Export fingerprint mismatch');
  let system = agent.system;
  if (system.includes('DIRECT SHEETS MIGRATION')) throw new Error('Already migrated');
  const start = system.indexOf('- HOW TO WRITE');
  const end = system.indexOf(endMarkers[key], start);
  if (start < 0 || end <= start || !system.slice(start, end).includes('_zap_raw_request')) throw new Error('Write recipe changed; re-review live prompt');
  system = system.slice(0, start) + `- HOW TO WRITE: use VestLaunch sheets_batch_update with a structured object: {data:[{range:"'<TODAY_TAB>'!<owned-range>",values:[[...]]}],value_input_option:"USER_ENTERED"}. Never stringify the data. Preserve the existing numeric/percent representations. Single-quote dotted tab names. Batch owned ranges and your status update together. To skip a null optional cell, split ranges to exclude it; never pass null. Use empty strings to clear on error. Read status and verify writes using sheets_read({ranges:["'<TODAY_TAB>'!<range>", ...]}) in one batch, never one cell per call. Never write outside your owned cells.\n\n` + system.slice(end);
  system = system.replaceAll('Google Sheets via Zapier', 'Google Sheets via VestLaunch direct Sheets tools')
    .replaceAll('Google Sheets WRITE/READ actions through the Zapier connection', 'VestLaunch sheets_batch_update and sheets_read tools')
    .replaceAll('Google Sheets actions through the Zapier connection', 'VestLaunch sheets_batch_update, sheets_read and sheets_create_day_tab tools')
    .replaceAll('minimize slow Zapier round-trips', 'batch native Sheets calls')
    .replaceAll('Do NOT re-list or discover Zapier actions - call the Sheets read/write actions directly.', 'Call sheets_read and sheets_batch_update directly; do not discover Zapier actions.')
    .replaceAll('do not re-list available Zapier actions between steps', 'use the native Sheets tools directly between steps')
    .replaceAll('the Sheets write body is passed as a PRE-SERIALIZED JSON STRING (avoids Zapier\'s HTTP-400 dict-mangling)', 'the Sheets write body is a structured object passed directly to sheets_batch_update');
  if (key === 'cfa') {
    const line = system.split('\n').find(l => l.startsWith("2. Confirm today's tab EXISTS"));
    if (!line?.includes('Zapier raw request')) throw new Error('CFA existence check changed');
    system = system.replace(line, "2. Read today's A112 with sheets_read; this also confirms the tab exists. On a missing-tab error, STOP and report; never create/copy/rename/delete a tab. Use sheets_read for all cell reads, with multiple ranges in one call.");
  }
  if (key === 'sales-lead-count') {
    const line = system.split('\n').find(l => l.startsWith("2. Read A108 on today's tab"));
    if (!line?.includes('copying the most recent existing tab')) throw new Error('Sales tab creation changed');
    system = system.replace(line, '2. Call sheets_create_day_tab({date:"YYYY-MM-DD"}) for today in America/Chicago. It duplicates the latest earlier date tab, sets A1 to the new date, atomically clears the established stale-value ranges, and verifies rightmost placement. It never clears an existing tab on retry. Read A108 with sheets_read. If empty or stale-dated, write "SALES <today>: tab=done,leads=-,calls=-,signups=-,hud=-"; otherwise preserve today\'s flags. After completing your scope, run sheets_create_day_tab({date:"YYYY-MM-DD",housekeeping_only:true}) to hide older date tabs; housekeeping failure does not block counts.');
  }
  const prefix = `== DIRECT SHEETS MIGRATION — TRANSPORT OVERRIDE ==\nThis section overrides earlier tool restrictions only to permit sheets_read and sheets_batch_update${key === 'sales-lead-count' ? ' and the Sales-only sheets_create_day_tab' : ''}, plus the existing save_metric_snapshot and report_run_complete exceptions. Keep all source definitions, gates, owned cells, status formats, alerts and snapshot behavior below unchanged. Never use Zapier for Google Sheets, even if a native tool fails. Zapier remains connected for LeadSimple lookups only; no Zapier mutations or app/action discovery. D16 clear-on-error remains mandatory: source failure or failed gate clears ONLY that source's owned output cells with empty strings, keeps its flag not-done, and writes its existing alert. Never retain stale numbers on a failed source. Do not claim completion without read-back.\n\n`;
  system = prefix + system;
  if (/PRE-SERIALIZED|_zap_raw_request|Google Sheets[^\n]*through the Zapier connection/.test(system)) throw new Error('Obsolete transport instruction remains');
  const tools = structuredClone(agent.tools);
  const vest = tools.find(t => t.type === 'mcp_toolset' && t.mcp_server_name === 'vestlaunch');
  const zapier = tools.find(t => t.type === 'mcp_toolset' && t.mcp_server_name === 'zapier');
  if (!vest || !zapier) throw new Error('Expected toolsets missing');
  const names = [...sources[key], 'save_metric_snapshot', 'report_run_complete', 'sheets_read', 'sheets_batch_update'];
  if (key === 'sales-lead-count') names.push('sheets_create_day_tab');
  vest.default_config = { enabled: false, permission_policy: { type: 'always_ask' } };
  vest.configs = names.map(name => ({ name, enabled: true, permission_policy: { type: 'always_allow' } }));
  zapier.default_config = { enabled: false, permission_policy: { type: 'always_ask' } };
  zapier.configs = [{ name: 'execute_zapier_read_action', enabled: true, permission_policy: { type: 'always_allow' } }];
  return { agent_key: key, agent_id: agent.id, expected_fingerprint: fingerprint, previous_version: agent.version, apply_after: key === 'showmojo' ? 'Direct Sheets access proof' : 'Two verified ShowMojo mornings', patch: { system, tools } };
}

if (process.argv[1]?.endsWith('prepare-company-numbers-migration.mjs')) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: script export.json proposal.json');
  writeFileSync(output, JSON.stringify(prepareMigration(JSON.parse(readFileSync(input, 'utf8'))), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Prepared offline proposal; no live agent changed.');
}
