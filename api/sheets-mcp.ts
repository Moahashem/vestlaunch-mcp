/** Optional Sheets-only MCP surface; the same tools also appear on /api/mcp
 * from the CRM manifest, preserving existing exact-URL vault credentials. */
import type { IncomingMessage, ServerResponse } from "node:http";
import mcpHandler from "./mcp";
export const SHEETS_TOOL_NAMES = ["sheets_read", "sheets_batch_update", "sheets_create_day_tab"] as const;
export const SHEETS_BACKEND_ROUTES = ["/api/v1/sheets/read", "/api/v1/sheets/batch-update", "/api/v1/sheets/create-day-tab"] as const;
export default async function sheetsMcpHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/api/sheets-mcp", "http://localhost");
  url.searchParams.set("tools", SHEETS_TOOL_NAMES.join(","));
  req.url = url.pathname + url.search;
  return mcpHandler(req, res);
}
