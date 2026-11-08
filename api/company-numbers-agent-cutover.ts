/** Temporary, default-off deterministic cutover. No caller-supplied prompt,
 * tools, upstream URL, credentials, or arbitrary agent IDs are accepted.
 * Set APPLY_AGENTS=showmojo only after Sheets access proof; promote the other
 * four only after two scheduled morning receipts. Remove both gates afterward.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { COMPANY_NUMBER_AGENTS, configFingerprint } from "./company-numbers-agent-migration";
import { readMcpProfile } from "./_mcp-onboarding-policy";
import { prepareMigration } from "../scripts/prepare-company-numbers-migration.mjs";
export const CFA_OLD_COUNT_GATE = "D15_balances_over_500 between 0 and 100.";
export const CFA_COUNT_GATE = "D15_balances_over_500 is an ACCOUNT COUNT, not a percentage: require a non-negative safe integer no greater than delinquency.components.aging_accounts, which must also be a non-negative safe integer. Preserve the tool's existing account scope (including former residents/HAP); do not cap this count at 100 or at total doors. Null remains unavailable and must be skipped; missing/invalid aging_accounts fails the D15 gate and alerts.";
export function repairCfaCountGate(agent: Record<string, unknown>) {
  if (agent.id !== COMPANY_NUMBER_AGENTS.cfa || agent.version !== 12 || typeof agent.system !== "string" || agent.system.split(CFA_OLD_COUNT_GATE).length !== 2) throw new Error("CFA count-gate baseline changed");
  return {system: agent.system.replace(CFA_OLD_COUNT_GATE, CFA_COUNT_GATE), tools: agent.tools};
}
const BASELINE_VERSIONS: Record<string, number> = { showmojo: 7, "sales-lead-count": 15, occupancy: 19, cfa: 11, "cf-leads": 5 };

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
export function patchFingerprint(patch: unknown) {
  return createHash("sha256").update(JSON.stringify(patch)).digest("hex");
}
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const selected = process.env.COMPANY_NUMBERS_MIGRATION_API_KEY_ID;
  const allowed = (process.env.COMPANY_NUMBERS_MIGRATION_APPLY_AGENTS || "").split(",").map(s => s.trim());
  if (!selected || !allowed.some(k => Object.hasOwn(COMPANY_NUMBER_AGENTS, k))) return json(res, 404, { error: "Cutover disabled" });
  if (req.method !== "POST") return json(res, 405, { error: "POST required" });
  const key = new URL(req.url || "/", "http://localhost").searchParams.get("agent_key") || "";
  if (!Object.hasOwn(COMPANY_NUMBER_AGENTS, key) || !allowed.includes(key)) return json(res, 403, { error: "Agent not enabled for cutover" });
  const token = req.headers.authorization || "";
  if (!token.startsWith("Bearer ffl_live_")) return json(res, 401, { error: "CRM API key required" });
  const base = process.env.VESTLAUNCH_BASE_URL?.replace(/\/+$/, "");
  const secret = process.env.ANTHROPIC_API_KEY;
  if (!base || !secret) return json(res, 503, { error: "Cutover not configured" });
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 2048) return json(res, 413, { error: "Request too large" });
    }
    let input: Record<string, unknown>;
    try { input = JSON.parse(body); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const repair = input?.repair === "cfa-count-gate";
    const rollback = input && Object.hasOwn(input, "rollback_version");
    const keys = repair ? "expected_fingerprint,repair,reviewed_patch_fingerprint" : rollback ? "expected_fingerprint,reviewed_patch_fingerprint,rollback_version" : "expected_fingerprint,reviewed_patch_fingerprint";
    if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== keys || (rollback && input.rollback_version !== BASELINE_VERSIONS[key]) ||
      !/^[a-f0-9]{64}$/.test(String(input.expected_fingerprint)) || !/^[a-f0-9]{64}$/.test(String(input.reviewed_patch_fingerprint))) return json(res, 400, { error: "Two review fingerprints required" });
    const auth = await fetch(`${base}/api/v1/me`, { headers: { Authorization: token }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!auth.ok) return json(res, 401, { error: "CRM authentication failed" });
    const me = await auth.json() as { data?: { identity?: { apiKeyId?: string; scopes?: string[] } } };
    if (readMcpProfile(me.data?.identity) !== "absent") return json(res, 403, { error: "This key is limited to the onboarding MCP." });
    if (me.data?.identity?.apiKeyId !== selected || !me.data.identity.scopes?.includes("*")) return json(res, 403, { error: "Selected migration admin key required" });
    const url = `https://api.anthropic.com/v1/agents/${COMPANY_NUMBER_AGENTS[key]}`;
    const headers = { "x-api-key": secret, "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01", "content-type": "application/json" };
    const read = async (version?: number) => {
      const response = await fetch(url + (version ? `?version=${version}` : ""), { headers, cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error("Agent read failed");
      return await response.json() as Record<string, unknown>;
    };
    const before = await read();
    const fingerprint = configFingerprint(before);
    if (fingerprint !== input.expected_fingerprint) return json(res, 409, { error: "Live agent changed; export and review again" });
    let patch: { system: unknown; tools: unknown };
    if (repair) {
      if (key !== "cfa" || before.version !== 12) return json(res, 409, {error: "CFA v12 required for count-gate repair"});
      patch = repairCfaCountGate(before);
    } else if (rollback) {
      const original = await read(BASELINE_VERSIONS[key]);
      const migrated = prepareMigration({ agent_key: key, fingerprint: configFingerprint(original), agent: original }).patch;
      if (original.version !== BASELINE_VERSIONS[key] || before.system !== migrated.system || !isDeepStrictEqual(before.tools, migrated.tools) ||
        !isDeepStrictEqual(before.mcp_servers, original.mcp_servers) || !isDeepStrictEqual(before.model, original.model)) return json(res, 409, { error: "Current config is not the reviewed migration of this baseline; refusing rollback" });
      patch = { system: original.system, tools: original.tools };
    } else {
      if (before.version !== BASELINE_VERSIONS[key]) return json(res, 409, { error: "Baseline version changed; re-review migration and rollback baseline" });
      patch = prepareMigration({ agent_key: key, fingerprint, agent: before }).patch;
    }
    if (patchFingerprint(patch) !== input.reviewed_patch_fingerprint) return json(res, 409, { error: "Reviewed patch does not match deterministic migration" });
    // Never include mcp_servers/model: vault URLs and model remain unchanged.
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(patch), signal: AbortSignal.timeout(20000) });
    if (!response.ok) return json(res, 502, { error: `Agent update failed (HTTP ${response.status}); inspect active version before retry` });
    const after = await read();
    if (after.system !== patch.system || !isDeepStrictEqual(after.tools, patch.tools) ||
      !isDeepStrictEqual(after.mcp_servers, before.mcp_servers) || !isDeepStrictEqual(after.model, before.model)) return json(res, 502, { error: "Agent update read-back mismatch; inspect active version before retry" });
    console.info("company-numbers-cutover", { agent_key: key, rollback, previous_version: before.version, version: after.version, reviewed_patch_fingerprint: input.reviewed_patch_fingerprint });
    return json(res, 200, { agent_key: key, previous_version: before.version, version: after.version, fingerprint: configFingerprint(after), verified: true });
  } catch { return json(res, 502, { error: "Cutover failed; inspect active version before retry" }); }
}
