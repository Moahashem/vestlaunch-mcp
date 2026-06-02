/**
 * validate-count.mjs — call the LIVE count_landlord_leads smart tool and print the result.
 *
 * Purpose: prove the tool's numbers against the validated baseline BEFORE any agent
 * writes to the Company Numbers sheet (thin-agent / smart-tools, D13).
 *
 * Usage (from the repo root, after `npm install`):
 *   MCP_BEARER_TOKEN=<the vault token> node scripts/validate-count.mjs            # as of today
 *   MCP_BEARER_TOKEN=<the vault token> node scripts/validate-count.mjs 2026-06-01 # as of a specific day
 *
 * Optional: MCP_URL to override the endpoint (defaults to production).
 *
 * Baseline (locked, 2026-06-01): This Month 2 / Last Month 44 / Quarter 90.
 * NOTE: "This Week" runs Sunday–Saturday; as of 2026-06-01 (a Monday) its week is
 * Sun May 31 – Sat Jun 6, so This Week may differ from the old Mon–Sun value of 2 —
 * eyeball it against VestLaunch.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "https://vestlaunch-mcp.vercel.app/api/mcp";
const token = process.env.MCP_BEARER_TOKEN;
const asOf = process.argv[2]; // optional YYYY-MM-DD

if (!token) {
  console.error("ERROR: set MCP_BEARER_TOKEN (the same token stored in the ffl-mcp vault).");
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "validate-count", version: "0.1.0" }, { capabilities: {} });

const t0 = Date.now();
try {
  await client.connect(transport);
  const args = asOf ? { as_of: asOf } : {};
  const res = await client.callTool({ name: "count_landlord_leads", arguments: args });
  const text = res?.content?.find?.((c) => c.type === "text")?.text ?? JSON.stringify(res, null, 2);
  console.log(text);
  console.log(`\n(took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
} catch (err) {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {}
}
