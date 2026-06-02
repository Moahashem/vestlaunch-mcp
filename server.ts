/**
 * Vercel HTTP entrypoint (Node.js runtime, BYO server).
 *
 * This Vercel project deploys a single Node HTTP server entrypoint (it does
 * NOT use the /api zero-config functions convention). So this file is the one
 * server Vercel runs; it routes requests to the same handlers used elsewhere:
 *   - POST/GET /api/mcp                   → the VestLaunch read MCP (Bearer-protected)
 *   - GET/POST /api/cron/daily-lead-count → the daily Sales lead-count trigger
 *   - GET/POST /api/cron/daily-occupancy  → the daily FFL occupancy trigger (Agent #2)
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
import cronHandler from "./api/cron/daily-lead-count";
import occupancyCronHandler from "./api/cron/daily-occupancy";

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/mcp") {
      await mcpHandler(req as IncomingMessage & { body?: unknown }, res);
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
    if (path === "/" || path === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "vestlaunch-mcp",
          endpoints: ["/api/mcp", "/api/cron/daily-lead-count", "/api/cron/daily-occupancy"],
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
