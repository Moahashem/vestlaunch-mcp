/**
 * POST /api/ruckus-execute — run ONE VestLaunch tool for an action a person approved in
 * RingCentral (ffl-crm lib/ruckus/approvals checked "approve A12" and calls this).
 * Body: { actionId, business: ffl|cranbrook, tool, args }. Bearer = CRM CRON_SECRET
 * (RUCKUS_SEND_TOKEN here). The model never calls this; only ffl-crm does.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { runApprovedTool } from "./_ruckus-cranbrook";

export const config = { maxDuration: 60 };

function send(res: ServerResponse, code: number, obj: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  const expected = (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!expected || req.headers.authorization !== `Bearer ${expected}`) return send(res, 401, { ok: false, error: "Unauthorized" });
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only" });
  let body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") {
    let raw = "";
    for await (const c of req) raw += c;
    try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { ok: false, error: "Invalid JSON" }); }
  }
  const b = body as { actionId?: string; business?: string; tool?: string; args?: Record<string, unknown> };
  if (!b.actionId || !b.tool) return send(res, 400, { ok: false, error: "actionId and tool are required" });
  try {
    const r = await runApprovedTool({ business: b.business === "cranbrook" ? "cranbrook" : "ffl", tool: b.tool, args: b.args ?? {} });
    console.log(`[ruckus-execute] ${b.actionId} ${b.tool} -> ${r.ok ? "ok" : r.error}`);
    return send(res, r.ok ? 200 : 422, r);
  } catch (e) {
    return send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
