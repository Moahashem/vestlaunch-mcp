/**
 * Vercel HTTP entrypoint (Node.js runtime, BYO server).
 *
 * This Vercel project deploys a single Node HTTP server entrypoint (it does
 * NOT use the /api zero-config functions convention). So this file is the one
 * server Vercel runs; it routes requests to the same handlers used elsewhere:
 *   - POST/GET /api/mcp                   → the VestLaunch read MCP (Bearer-protected)
 *   - POST/GET /api/ruckus-mcp            → Ruckus's reply MCP (ruckus_send; Bearer-protected)
 *   - GET/POST /api/cron/daily-lead-count → the daily Sales lead-count trigger
 *   - GET/POST /api/cron/daily-occupancy  → the daily FFL occupancy trigger (Agent #2)
 *   - GET/POST /api/cron/daily-showmojo   → the daily FFL ShowMojo/Homes trigger
 *
 * ⚠️ ROUTING RULE (learned 2026-06-09): adding a file under api/cron/ does NOT
 * create a route. Every new cron/endpoint MUST also be (1) imported here,
 * (2) added to the route checks below, and (3) listed in the /health payload —
 * or Vercel's cron will fire into the catch-all 404 silently.
 *
 * The repo's STDIO MCP (src/* → dist/*) is unrelated and unchanged; it is
 * hidden from Vercel via .vercelignore so it isn't picked as the entrypoint.
 *
 * Vercel injects PORT and proxies all routes to this listening server
 * (https://vercel.com/docs/functions/runtimes/node-js). The vercel.json crons
 * hit /api/cron/* on this same server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import mcpHandler from "./api/mcp";
import ruckusMcpHandler from "./api/ruckus-mcp";
import cronHandler from "./api/cron/daily-lead-count";
import occupancyCronHandler from "./api/cron/daily-occupancy";
import showmojoCronHandler from "./api/cron/daily-showmojo";
import cfaCronHandler from "./api/cron/daily-cfa";

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/mcp") {
      await mcpHandler(req as IncomingMessage & { body?: unknown }, res);
      return;
    }
    if (path === "/api/ruckus-mcp") {
      await ruckusMcpHandler(req as IncomingMessage & { body?: unknown }, res);
      return;
    }
    if (path === "/api/cron/daily-lead-count") {
      await cronHandler(req, res);
      return;
    }
    if (path === "/api/cron/daily-occupancy") {
      await occupancyCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/daily-showmojo") {
      await showmojoCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/daily-cfa") {
      await cfaCronHandler(req, res);
      return;
    }
    if (path === "/" || path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "vestlaunch-mcp",
          endpoints: [
            "/api/mcp",
            "/api/ruckus-mcp",
            "/api/cron/daily-lead-count",
            "/api/cron/daily-occupancy",
            "/api/cron/daily-showmojo",
            "/api/cron/daily-cfa",
          ],
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(Number(process.env.PORT ?? 3000));
