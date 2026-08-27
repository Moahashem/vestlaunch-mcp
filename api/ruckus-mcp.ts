/**
 * Ruckus reply MCP — HTTP (Streamable) transport for Vercel.
 *
 * A tiny, SELF-CONTAINED MCP server exposing Ruckus's (FFL Chief of Staff)
 * ACTING tools:
 *   1. `ruckus_send`         — post a message into its own RingCentral channel,
 *                              via ffl-crm POST /api/ringcentral/ruckus-send
 *                              (posts as the Ruckus bot).
 *   2. `ruckus_rerun_worker` — re-trigger one of the scheduled worker agents by
 *                              hitting THIS deployment's own /api/cron/* kickoff
 *                              endpoint with the server-side CRON_SECRET (green
 *                              tier; the intake chain is deliberately excluded).
 *   3. `ruckus_publish_blog_pr` — merge ONE open [LEGAL REVIEW]/[CALENDAR REVIEW]
 *                              blog PR on flatfeelandlord-com, only after an
 *                              explicit human approval in-channel (which is
 *                              recorded on the PR as an audit comment). Inert
 *                              until FFL_GITHUB_TOKEN is set.
 * We keep this SEPARATE from the shared read MCP (api/mcp.ts) so Ruckus's
 * "acting" path can never affect the read tools the other FFL agents rely on.
 *
 * Why a tool (not the model holding a secret): the CRM send endpoint is gated by
 * a bearer token. That token lives ONLY in this server's env (RUCKUS_SEND_TOKEN)
 * and is injected server-side here — the model just calls `ruckus_send({text})`
 * and never sees the secret.
 *
 * Auth model: this server is a THIN AUTHENTICATED RELAY. It requires the agent to
 * present some bearer (the vault injects one) and forwards that exact bearer to
 * ruckus-send, whose CRON_SECRET check is the real gate. So the vault credential's
 * token must equal the CRM CRON_SECRET; there is no second token to keep in sync.
 *
 * Env (set by Mo in Vercel — never hard-coded):
 *   RUCKUS_SEND_TOKEN    — fallback bearer for the CRM send endpoint (= CRON_SECRET)
 *                          if the agent's forwarded bearer is somehow absent.
 *   RUCKUS_SEND_BASE_URL — optional CRM base; defaults to VESTLAUNCH_BASE_URL,
 *                          then https://crm.vestlaunch.com
 *   VESTLAUNCH_TIMEOUT_MS — optional request timeout (default 30s)
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export const config = { maxDuration: 60 };

const TOOL_NAME = "ruckus_send";
const TOOL_DESC =
  "Post a message into Ruckus's own RingCentral channel — this is Ruckus's reply " +
  "path as FFL Chief of Staff. Calls ffl-crm POST /api/ringcentral/ruckus-send, which " +
  "posts as the Ruckus bot. Your text is NOT auto-delivered: you MUST call this tool to " +
  "be heard, whether replying to a person or posting your morning brief. Args: { text } " +
  "(required); optional { chatId } overrides the default channel. Returns { ok, chatId }.";
const TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    text: { type: "string", description: "The message text to post into Ruckus's channel." },
    chatId: {
      type: "string",
      description: "Optional RingCentral chat id to override the default Ruckus channel.",
    },
  },
  required: ["text"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// ruckus_rerun_worker — Ruckus's "re-run a worker" lever (green tier)
// ---------------------------------------------------------------------------
//
// Each FFL worker agent is normally kicked off by a Vercel cron hitting one of
// THIS deployment's /api/cron/* endpoints. This tool lets Ruckus hit the same
// endpoint on demand — e.g. when a morning run failed, or when Mo asks for a
// fresh pull in RingCentral. It is the Chief-of-Staff charter's "re-trigger a
// failed data pull" made concrete.
//
// Auth: the cron endpoints gate on `Authorization: Bearer <CRON_SECRET>`, and
// CRON_SECRET lives in THIS deployment's env — injected server-side here, so
// the model never sees it (same pattern as ruckus_send's token).
//
// Scope (deliberate): ONLY the scheduled data-pull / report workers below.
// `appfolio-entry` (the owner-intake chain that WRITES into AppFolio) is
// EXCLUDED on purpose — per the intake-reliability dossier, nothing touches
// that chain out of schedule without a human.

const RERUN_TOOL_NAME = "ruckus_rerun_worker";

/** worker key → its cron kickoff path on THIS deployment, plus a label. */
const RERUN_WORKERS: Record<string, { path: string; label: string }> = {
  "sales-leads": { path: "/api/cron/daily-lead-count", label: "FFL Sales Daily Lead Counter" },
  occupancy: { path: "/api/cron/daily-occupancy", label: "FFL Daily Occupancy Counter (AppFolio)" },
  showmojo: { path: "/api/cron/daily-showmojo", label: "FFL ShowMojo Agent" },
  cfa: { path: "/api/cron/daily-cfa", label: "FFL CFA Daily Numbers (Cranbrook/ResMan)" },
  "cf-leads": { path: "/api/cron/daily-cf-leads", label: "FFL CF Leasing Daily Lead Counter" },
  onboarding: { path: "/api/cron/daily-onboarding", label: "FFL Owner Onboarding Tracker" },
  "boom-screenings": { path: "/api/cron/daily-boom-screenings", label: "Boom screenings pull" },
  "recruiting-sweep": { path: "/api/cron/recruiting-sweep", label: "Daily recruiting sweep" },
  "caller-name-fill": { path: "/api/cron/caller-name-fill", label: "Caller name fill" },
};

const RERUN_TOOL_DESC =
  "Re-run one of FFL's scheduled worker agents right now, instead of waiting for its " +
  "next scheduled time. Use this when a worker failed or didn't run (check get_agent_runs " +
  "first), or when Mo/Yuliana explicitly ask for a fresh pull. Green tier: safe and " +
  "reversible — each worker just re-reads its sources and re-writes its numbers. " +
  "Workers: " +
  Object.entries(RERUN_WORKERS)
    .map(([k, w]) => `'${k}' (${w.label})`)
    .join(", ") +
  ". The owner-intake AppFolio chain is deliberately NOT re-runnable from here. " +
  "Kickoff takes up to a minute; results land in the hub a few minutes later — tell the " +
  "requester you triggered it and check get_agent_runs afterward rather than promising " +
  "instant numbers. Args: { worker } (required, one of the keys above). " +
  "Returns the kickoff endpoint's response.";

const RERUN_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    worker: {
      type: "string",
      enum: Object.keys(RERUN_WORKERS),
      description: "Which worker to re-run (see tool description for what each key is).",
    },
  },
  required: ["worker"],
  additionalProperties: false,
};

/** Base URL of THIS deployment (mirrors api/mcp.ts: stable prod host first). */
function selfBaseUrl(): string {
  const productionHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (productionHost) return `https://${productionHost}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://vestlaunch-mcp.vercel.app";
}

async function ruckusRerunWorker(
  args: Record<string, unknown>,
  forwardToken?: string,
): Promise<unknown> {
  // REAL GATE (unlike ruckus_send, whose gate is downstream in ffl-crm): the
  // caller's bearer must equal the known Ruckus vault credential value
  // (RUCKUS_SEND_TOKEN). Without this check, ANY bearer reaching this MCP
  // could trigger reruns, because the CRON_SECRET below is injected
  // server-side. Inert until RUCKUS_SEND_TOKEN is set — consistent with the
  // rest of the Ruckus stack.
  const expectedBearer = (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!expectedBearer) {
    throw new Error(
      "ruckus_rerun_worker is not configured: set RUCKUS_SEND_TOKEN in this MCP's env " +
        "(the Ruckus vault credential value) to enable rerun authentication.",
    );
  }
  if ((forwardToken ?? "").trim() !== expectedBearer) {
    throw new Error("ruckus_rerun_worker: unauthorized bearer.");
  }

  const worker = typeof args.worker === "string" ? args.worker.trim() : "";
  const entry = RERUN_WORKERS[worker];
  if (!entry) {
    throw new Error(
      `Unknown worker '${worker}'. Valid workers: ${Object.keys(RERUN_WORKERS).join(", ")}.`,
    );
  }

  const cronSecret = (process.env.CRON_SECRET ?? "").trim();
  if (!cronSecret) {
    throw new Error(
      "ruckus_rerun_worker is not configured: CRON_SECRET is missing from this deployment's env.",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  try {
    const res = await fetch(`${selfBaseUrl()}${entry.path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "User-Agent": "ruckus-mcp-rerun/0.1.0",
      },
      signal: controller.signal,
    });
    const out = await res.text();
    let json: unknown = null;
    try {
      json = out ? JSON.parse(out) : null;
    } catch {
      json = { raw: out.slice(0, 500) };
    }
    if (!res.ok) {
      return { ok: false, worker, label: entry.label, status: res.status, error: json ?? out };
    }
    return { ok: true, worker, label: entry.label, kickoff: json ?? { status: res.status } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // An abort does NOT mean the kickoff failed — the endpoint may still be
    // finishing server-side. Say so instead of reporting a false failure.
    if (msg.toLowerCase().includes("abort")) {
      return {
        ok: true,
        worker,
        label: entry.label,
        note:
          "Kickoff request sent but the response took >50s — the worker is likely still " +
          "starting. Check get_agent_runs in a few minutes before retrying.",
      };
    }
    return { ok: false, worker, label: entry.label, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// ruckus_publish_blog_pr — publish a held blog post AFTER explicit human OK
// ---------------------------------------------------------------------------
//
// The blog drafter (GitHub Action in Moahashem/flatfeelandlord-com) holds
// statutory/legal-adjacent posts as open "[LEGAL REVIEW]" / "[CALENDAR REVIEW]"
// PRs until a human signs off. This tool is the LAST INCH of that approval
// loop: when Mo or Yuliana explicitly approves a specific post in the channel
// ("push it live"), Ruckus merges that one PR. The HUMAN decision is the
// red-tier sign-off; this tool only executes it, and its gates make it unable
// to do anything else:
//
//   • hardcoded to the flatfeelandlord-com repo — no other repo reachable
//   • the PR must be OPEN and titled "[LEGAL REVIEW]" or "[CALENDAR REVIEW]"
//   • GitHub must report it mergeable with green checks (mergeable_state clean)
//   • an audit comment (who approved + their verbatim words) is posted on the
//     PR before merging, so the sign-off trail lives where the content lives
//   • caller bearer must equal RUCKUS_SEND_TOKEN (same gate as rerun)
//   • inert until FFL_GITHUB_TOKEN is set in this deployment's env — use a
//     fine-grained PAT scoped to ONLY flatfeelandlord-com (Contents +
//     Pull requests: read/write). The model never sees the token.

const PUBLISH_TOOL_NAME = "ruckus_publish_blog_pr";
const PUBLISH_REPO = "Moahashem/flatfeelandlord-com";
const PUBLISH_TITLE_RE = /\[(LEGAL|CALENDAR) REVIEW\]/i;

const PUBLISH_TOOL_DESC =
  "Publish (merge) ONE blog post PR on the flatfeelandlord-com website that is being held " +
  "for review — ONLY after Mo or Yuliana has explicitly approved THAT SPECIFIC post in the " +
  "channel (e.g. 'push it live', 'approved, ship it'). The human's message is the required " +
  "legal sign-off: NEVER call this on your own judgment, on a hunch, or because a post " +
  "seems fine — no explicit human approval in this conversation, no call. Pass their " +
  "approval verbatim: it is posted on the PR as the audit record. Only works on OPEN PRs " +
  `in ${PUBLISH_REPO} titled [LEGAL REVIEW] or [CALENDAR REVIEW] with green checks; ` +
  "refuses everything else. Args: { pr_number, approved_by, approval_quote } (all " +
  "required; approved_by is the human's name, approval_quote their exact words). " +
  "Returns { ok, merged, title, url } or a refusal reason. After success, confirm to the " +
  "channel that the post is live (the site deploys automatically within a few minutes).";

const PUBLISH_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    pr_number: {
      type: "number",
      description: "The PR number to publish (from the alert, e.g. 532).",
    },
    approved_by: {
      type: "string",
      description: "Name of the human who approved in-channel (e.g. 'Mo').",
    },
    approval_quote: {
      type: "string",
      description:
        "The human's approval message, verbatim — posted on the PR as the audit record.",
    },
  },
  required: ["pr_number", "approved_by", "approval_quote"],
  additionalProperties: false,
};

async function githubApi(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ruckus-mcp-publish/0.1.0",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

async function ruckusPublishBlogPr(
  args: Record<string, unknown>,
  forwardToken?: string,
): Promise<unknown> {
  // Gate 1: caller must be the Ruckus vault credential (same as rerun).
  const expectedBearer = (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!expectedBearer) {
    throw new Error(
      "ruckus_publish_blog_pr is not configured: RUCKUS_SEND_TOKEN missing from this MCP's env.",
    );
  }
  if ((forwardToken ?? "").trim() !== expectedBearer) {
    throw new Error("ruckus_publish_blog_pr: unauthorized bearer.");
  }

  // Gate 2: inert until a repo-scoped GitHub token exists server-side.
  const ghToken = (process.env.FFL_GITHUB_TOKEN ?? "").trim();
  if (!ghToken) {
    return {
      ok: false,
      error:
        "Not configured yet: FFL_GITHUB_TOKEN is missing from this deployment's env. " +
        "Tell Mo the publish lever needs its GitHub key added in Vercel before it can work.",
    };
  }

  const prNumber = typeof args.pr_number === "number" ? Math.trunc(args.pr_number) : NaN;
  const approvedBy = typeof args.approved_by === "string" ? args.approved_by.trim() : "";
  const approvalQuote =
    typeof args.approval_quote === "string" ? args.approval_quote.trim() : "";
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error("ruckus_publish_blog_pr requires a valid pr_number.");
  }
  if (!approvedBy || !approvalQuote) {
    throw new Error(
      "ruckus_publish_blog_pr requires approved_by and approval_quote — the human approval " +
        "IS the sign-off; do not call without it.",
    );
  }

  // Gate 3: the PR itself must be a held review PR, open, mergeable, green.
  const pr = await githubApi(ghToken, "GET", `/repos/${PUBLISH_REPO}/pulls/${prNumber}`);
  if (pr.status !== 200) {
    return { ok: false, error: `Could not load PR #${prNumber} (HTTP ${pr.status}).` };
  }
  const p = pr.json as {
    state?: string;
    title?: string;
    merged?: boolean;
    mergeable_state?: string;
    html_url?: string;
    head?: { ref?: string };
  };
  if (p.merged) {
    return { ok: true, merged: true, title: p.title, url: p.html_url, note: "Already published." };
  }
  if (p.state !== "open") {
    return { ok: false, error: `PR #${prNumber} is not open (state: ${p.state}).`, title: p.title };
  }
  if (!PUBLISH_TITLE_RE.test(p.title ?? "")) {
    return {
      ok: false,
      error:
        `PR #${prNumber} ("${p.title}") is not a held review PR — this tool only publishes ` +
        "PRs titled [LEGAL REVIEW] or [CALENDAR REVIEW]. Anything else needs Mo directly.",
    };
  }
  if (p.mergeable_state !== "clean") {
    return {
      ok: false,
      error:
        `PR #${prNumber} is not cleanly mergeable right now (state: ` +
        `${p.mergeable_state ?? "unknown"}). Checks may still be running or something needs ` +
        "a human look — report this back instead of retrying blindly.",
      title: p.title,
      url: p.html_url,
    };
  }

  // Audit trail BEFORE merging: the sign-off lives on the PR itself.
  await githubApi(ghToken, "POST", `/repos/${PUBLISH_REPO}/issues/${prNumber}/comments`, {
    body:
      `✅ **Published on explicit in-channel approval.**\n\n` +
      `Approved by: **${approvedBy}**\n` +
      `Their words: "${approvalQuote.slice(0, 500)}"\n\n` +
      `_Merged by Ruckus (FFL Chief of Staff) via ruckus_publish_blog_pr._`,
  });

  const merge = await githubApi(ghToken, "PUT", `/repos/${PUBLISH_REPO}/pulls/${prNumber}/merge`, {
    merge_method: "squash",
  });
  if (merge.status !== 200) {
    return {
      ok: false,
      error: `Merge failed (HTTP ${merge.status}): ${JSON.stringify(merge.json).slice(0, 300)}`,
      title: p.title,
      url: p.html_url,
    };
  }

  // Best-effort branch cleanup — a failure here is cosmetic, never surfaced as an error.
  if (p.head?.ref) {
    await githubApi(
      ghToken,
      "DELETE",
      `/repos/${PUBLISH_REPO}/git/refs/heads/${encodeURIComponent(p.head.ref)}`,
    ).catch(() => undefined);
  }

  return { ok: true, merged: true, title: p.title, url: p.html_url };
}

function baseUrl(): string {
  const explicit = (process.env.RUCKUS_SEND_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  return "https://crm.vestlaunch.com";
}

async function ruckusSend(args: Record<string, unknown>, forwardToken?: string): Promise<unknown> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) throw new Error("ruckus_send requires a non-empty 'text'.");

  // Prefer the bearer the agent presented (the vault-injected CRM credential),
  // forwarded straight through; fall back to the RUCKUS_SEND_TOKEN env var.
  const token = (forwardToken ?? "").trim() || (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "ruckus_send is not configured: set RUCKUS_SEND_TOKEN in this MCP's env " +
        "(= the ffl-crm CRON_SECRET that gates /api/ringcentral/ruckus-send).",
    );
  }

  const body: Record<string, unknown> = { text };
  if (typeof args.chatId === "string" && args.chatId.trim()) body.chatId = args.chatId.trim();

  const t = Number.parseInt(process.env.VESTLAUNCH_TIMEOUT_MS ?? "", 10);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/api/ringcentral/ruckus-send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "ruckus-mcp-http/0.1.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const out = await res.text();
    let json: unknown = null;
    try {
      json = out ? JSON.parse(out) : null;
    } catch {
      json = { raw: out };
    }
    if (!res.ok) return { ok: false, status: res.status, error: json ?? out };
    return json ?? { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function buildServer(forwardToken?: string): Server {
  const server = new Server(
    { name: "ruckus-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: TOOL_NAME, description: TOOL_DESC, inputSchema: TOOL_SCHEMA },
      { name: RERUN_TOOL_NAME, description: RERUN_TOOL_DESC, inputSchema: RERUN_TOOL_SCHEMA },
      { name: PUBLISH_TOOL_NAME, description: PUBLISH_TOOL_DESC, inputSchema: PUBLISH_TOOL_SCHEMA },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    if (name !== TOOL_NAME && name !== RERUN_TOOL_NAME && name !== PUBLISH_TOOL_NAME) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const result =
        name === PUBLISH_TOOL_NAME
          ? await ruckusPublishBlogPr(args, forwardToken)
          : name === RERUN_TOOL_NAME
            ? await ruckusRerunWorker(args, forwardToken)
            : await ruckusSend(args, forwardToken);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Error invoking ${name}: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  });

  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  // THIN AUTHENTICATED RELAY (deliberate): this server requires only that the
  // connecting agent presents SOME bearer (the vault injects one), then forwards
  // that exact bearer to ffl-crm /api/ringcentral/ruckus-send. The real gate is
  // downstream — ruckus-send rejects anything whose bearer != the CRM CRON_SECRET.
  // So the ONLY value that must be correct is the vault credential's token (= the
  // CRM CRON_SECRET); there is no second token to keep in sync here. A caller with
  // a wrong/absent bearer simply gets a 401 from ruckus-send and nothing is posted.
  const incomingBearer = (req.headers["authorization"] ?? "").toString().replace(/^Bearer\s+/i, "").trim();
  if (!incomingBearer) {
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  const server = buildServer(incomingBearer);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
