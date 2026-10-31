/** Temporary, default-off inspection surface for the Sheets migration.
 * The Anthropic key stays in Vercel. Only a deliberately selected existing CRM
 * admin API-key identity may inspect the five Company Numbers configurations.
 * No arbitrary upstream paths, new agents, sessions, credentials, or writes.
 * Remove COMPANY_NUMBERS_MIGRATION_API_KEY_ID after rollout.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

export const COMPANY_NUMBER_AGENTS: Record<string, string> = {
  "sales-lead-count": "agent_01UQzJ4ZKLP7JGYsBvwptu74",
  occupancy: "agent_015XERb8X96E2JiXpKrWrdEn",
  showmojo: "agent_01RKzvz2PqD2SkqpcoJL5gEg",
  cfa: "agent_019VLn9nhFmWrDNsasKfChMq",
  "cf-leads": "agent_01HCjnrgzuhgt3pCnd291Ryn",
};
export function configFingerprint(agent: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ system: agent.system, tools: agent.tools, mcp_servers: agent.mcp_servers, version: agent.version })).digest("hex");
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const selectedKeyId = process.env.COMPANY_NUMBERS_MIGRATION_API_KEY_ID;
  if (!selectedKeyId) return json(res, 404, { error: "Migration endpoint disabled" });
  if (req.method !== "GET") return json(res, 405, { error: "Read-only migration inspection" });
  const token = req.headers.authorization || "";
  if (!token.startsWith("Bearer ffl_live_")) return json(res, 401, { error: "CRM API key required" });
  const url = new URL(req.url || "/", "http://localhost");
  const key = url.searchParams.get("agent_key") || "";
  if (!Object.hasOwn(COMPANY_NUMBER_AGENTS, key)) return json(res, 400, { error: "Unknown Company Numbers agent" });
  const base = process.env.VESTLAUNCH_BASE_URL?.replace(/\/+$/, "");
  if (!base || !process.env.ANTHROPIC_API_KEY) return json(res, 503, { error: "Migration inspection is not configured" });
  try {
    const auth = await fetch(`${base}/api/v1/me`, { headers: { Authorization: token }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!auth.ok) return json(res, 401, { error: "CRM authentication failed" });
    const me = await auth.json() as { data?: { identity?: { apiKeyId?: string; scopes?: string[] } } };
    const identity = me.data?.identity;
    if (identity?.apiKeyId !== selectedKeyId || !identity.scopes?.includes("*")) return json(res, 403, { error: "Selected migration admin key required" });
    const response = await fetch(`https://api.anthropic.com/v1/agents/${COMPANY_NUMBER_AGENTS[key]}`, {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "managed-agents-2026-04-01" },
      signal: AbortSignal.timeout(20000), cache: "no-store",
    });
    if (!response.ok) return json(res, 502, { error: `Anthropic agent read failed (HTTP ${response.status})` });
    const agent = await response.json() as Record<string, unknown>;
    // Configuration fields only. Never return vaults or environment credentials.
    return json(res, 200, { agent_key: key, fingerprint: configFingerprint(agent), agent: {
      id: agent.id, name: agent.name, version: agent.version, system: agent.system,
      tools: agent.tools, mcp_servers: agent.mcp_servers, model: agent.model,
    } });
  } catch { return json(res, 502, { error: "Migration inspection failed" }); }
}
