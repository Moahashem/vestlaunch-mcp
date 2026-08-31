/**
 * Vercel HTTP entrypoint (Node.js runtime, BYO server).
 *
 * This Vercel project deploys a single Node HTTP server entrypoint (it does
 * NOT use the /api zero-config functions convention). So this file is the one
 * server Vercel runs; it routes requests to the same handlers used elsewhere:
 *   - POST/GET /api/mcp                      → the VestLaunch read MCP (Bearer-protected)
 *   - POST/GET /api/ruckus-mcp               → Ruckus's reply MCP (ruckus_send; Bearer-protected)
 *   - POST/GET /api/agent-os-mcp             → AI OS heartbeat MCP (read/write; Bearer-protected)
 *   - GET/POST /api/cron/daily-lead-count    → the daily Sales lead-count trigger
 *   - GET/POST /api/cron/daily-occupancy     → the daily FFL occupancy trigger (Agent #2)
 *   - GET/POST /api/cron/daily-showmojo      → the daily FFL ShowMojo/Homes trigger
 *   - GET/POST /api/cron/daily-onboarding    → the daily FFL Owner Onboarding trigger
 *   - GET/POST /api/cron/daily-cfa           → the daily Cranbrook/CFA trigger
 *   - GET/POST /api/cron/daily-boom-screenings → the daily Boom screenings → ffl.applications pull
 *   - GET/POST /api/cron/appfolio-entry        → queue-aware hourly AppFolio entry-agent kickoff
 *   - POST/GET /api/recruiting-mcp             → recruiting cloud-half smart tools (Bearer-protected)
 *   - GET/POST /api/cron/recruiting-sweep      → the daily recruiting sweep (cloud half) trigger
 *   - GET/POST /api/cron/fleet-staleness       → 13:10 UTC fleet staleness guard (reads the hub, pings RingCentral)
 *   - GET/POST /api/cron/caller-name-fill      → fills missing caller names on phone-only leads (AppFolio guest cards / LeadSimple)
 *   - POST /api/hooks/leadsimple-listing       → §5.6 owner-intake listing trigger → LeadSimple 03 Leasing Process
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
import agentOsMcpHandler from "./api/agent-os-mcp";
import cronHandler from "./api/cron/daily-lead-count";
import occupancyCronHandler from "./api/cron/daily-occupancy";
import showmojoCronHandler from "./api/cron/daily-showmojo";
import onboardingCronHandler from "./api/cron/daily-onboarding";
import cfaCronHandler from "./api/cron/daily-cfa";
import cfLeadsCronHandler from "./api/cron/daily-cf-leads";
import boomScreeningsCronHandler from "./api/cron/daily-boom-screenings";
import appfolioEntryCronHandler from "./api/cron/appfolio-entry";
import callerNameFillCronHandler from "./api/cron/caller-name-fill";
import recruitingSweepCronHandler from "./api/cron/recruiting-sweep";
import fleetStalenessCronHandler from "./api/cron/fleet-staleness";
import recruitingMcpHandler from "./api/recruiting-mcp";
import leadsimpleListingHookHandler from "./api/hooks/leadsimple-listing";

// Self-hosted OAuth 2.1 authorization server (for Claude Desktop's
// custom-connector "Connect" button). These MUST be routed here because this
// BYO Node server ignores vercel.json rewrites — every request arrives with
// its original path and is dispatched by the explicit table below.
import oauthProtectedResourceHandler from "./api/oauth-protected-resource";
import oauthAuthorizationServerHandler from "./api/oauth-authorization-server";
import authorizeHandler from "./api/authorize";
import tokenHandler from "./api/token";
import oauthRegisterHandler from "./api/oauth-register";

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
    if (path === "/api/agent-os-mcp") {
      await agentOsMcpHandler(req as IncomingMessage & { body?: unknown }, res);
      return;
    }
    if (path === "/api/recruiting-mcp") {
      await recruitingMcpHandler(req as IncomingMessage & { body?: unknown }, res);
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
    if (path === "/api/cron/daily-onboarding") {
      await onboardingCronHandler(req, res);
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
    if (path === "/api/cron/daily-cf-leads") {
      await cfLeadsCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/daily-boom-screenings") {
      await boomScreeningsCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/appfolio-entry") {
      await appfolioEntryCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/caller-name-fill") {
      await callerNameFillCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/recruiting-sweep") {
      await recruitingSweepCronHandler(req, res);
      return;
    }
    if (path === "/api/cron/fleet-staleness") {
      await fleetStalenessCronHandler(req, res);
      return;
    }
    if (path === "/api/hooks/leadsimple-listing") {
      await leadsimpleListingHookHandler(req, res);
      return;
    }
    // ── Self-hosted OAuth 2.1 endpoints ──
    // Protected-resource metadata (RFC 9728). Clients may request the bare
    // well-known path OR the resource-suffixed variant
    // (/.well-known/oauth-protected-resource/api/mcp), so match on prefix.
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path.startsWith("/.well-known/oauth-protected-resource/") ||
      path === "/api/oauth-protected-resource"
    ) {
      await oauthProtectedResourceHandler(req, res);
      return;
    }
    // Authorization-server metadata (RFC 8414).
    if (
      path === "/.well-known/oauth-authorization-server" ||
      path.startsWith("/.well-known/oauth-authorization-server/") ||
      path === "/api/oauth-authorization-server"
    ) {
      await oauthAuthorizationServerHandler(req, res);
      return;
    }
    // Login/consent page + authorization-code issuance.
    if (path === "/authorize" || path === "/api/authorize") {
      await authorizeHandler(req, res);
      return;
    }
    // Token endpoint (authorization_code + refresh_token grants).
    if (path === "/token" || path === "/api/token") {
      await tokenHandler(req, res);
      return;
    }
    // Dynamic client registration (RFC 7591).
    if (path === "/register" || path === "/api/oauth-register") {
      await oauthRegisterHandler(req, res);
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
            "/api/agent-os-mcp",
            "/api/recruiting-mcp",
            "/api/cron/daily-lead-count",
            "/api/cron/daily-occupancy",
            "/api/cron/daily-showmojo",
            "/api/cron/daily-onboarding",
            "/api/cron/daily-cfa",
            "/api/cron/daily-cf-leads",
            "/api/cron/daily-boom-screenings",
            "/api/cron/appfolio-entry",
            "/api/cron/caller-name-fill",
            "/api/cron/recruiting-sweep",
            "/api/cron/fleet-staleness",
            "/api/hooks/leadsimple-listing",
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-authorization-server",
            "/authorize",
            "/token",
            "/register",
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
