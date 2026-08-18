/**
 * Recruiting MCP — HTTP (Streamable) transport for Vercel.
 *
 * The DEDICATED, tightly-curated MCP server for the recruiting cloud agent
 * (the email half of the recruiting invite sweep — see Mo's Recruiting folder:
 * RECRUITING-SOP.md + HANDOFF-recruiting-cloud-agent.md, 2026-08-17).
 *
 * Kept SEPARATE from the shared read MCP (api/mcp.ts) on purpose, exactly like
 * ruckus-mcp and agent-os-mcp: an unattended Managed Agent needs always_allow,
 * and always_allow is only safe when the server exposes nothing beyond the one
 * job. This server exposes 8 narrow tools and nothing else:
 *
 *   READ  get_videoask_completers   — {name,email,completed_at} only; transcripts
 *                                     stripped server-side (D13 — the ~5k-token
 *                                     VideoAsk payload trap)
 *   READ  search_videoask_contacts  — all-forms contact-index dedup check
 *   READ  get_new_applicants        — SOP Gmail sweeps, parsed + verified mailbox
 *   WRITE send_recruiting_invite    — ONE fixed template, hard-coded role→link
 *                                     map, server-ENFORCED dedup + denylist +
 *                                     daily cap (Mo's choice 2026-08-17)
 *   WRITE send_watchdog_alert       — email Mo when the browser half is stale
 *   READ  get_recruiting_state      — shared state (ffl-crm Workforce Hub)
 *   WRITE update_recruiting_state   — same
 *   WRITE report_recruiting_run     — run-status row for the AI OS dashboard +
 *                                     Mo's bullet report → his RingCentral
 *                                     channel (Ruckus send path; Mo 2026-08-18)
 *
 * Auth: static Bearer — the vault credential's token must equal the Vercel env
 * RECRUITING_MCP_TOKEN (≥32 chars; endpoint fails CLOSED until set). Same
 * model as the ruckus/agent-os relays: the vault injects the Bearer only for
 * this URL, which is the ONLY credential path Managed Agents has (D8).
 *
 * Gmail here is DIRECT API via an OAuth refresh token (house pattern), NOT the
 * shared agent Zapier server — Gmail stays off that server (D11) and this
 * endpoint's curation is what keeps the blast radius to one email template.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  getNewApplicants,
  getRecruitingState,
  getVideoaskCompleters,
  recruitingMcpTokenOk,
  searchVideoaskContacts,
  sendRecruitingInvite,
  sendTestgorillaInvite,
  sendWatchdogAlert,
  updateRecruitingState,
} from "./recruiting-tools";
import { reportRecruitingRunWithRc } from "./recruiting-report";

// 300s: the contact-index rebuild (first dedup call after 12h) pages every
// form's contacts through Zapier — parallel across forms, but the largest
// form's sequential pages can exceed 60s.
export const config = { maxDuration: 300 };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "get_videoask_completers",
    description:
      "List people who completed the VideoAsk screening question since a given time. Returns ONLY " +
      "[{name, email, completed_at}] — transcripts are stripped server-side. Args: " +
      "{ since_iso (required, ISO timestamp), question_id (optional — defaults to the Virtual PM " +
      "screening question) }.",
    inputSchema: {
      type: "object",
      properties: {
        since_iso: { type: "string", description: "ISO timestamp; completions at/after this instant are returned." },
        question_id: { type: "string", description: "VideoAsk question id (optional)." },
      },
      required: ["since_iso"],
      additionalProperties: false,
    },
  },
  {
    name: "search_videoask_contacts",
    description:
      "Search VideoAsk contacts across ALL forms in the org — the REQUIRED dedup check before " +
      "judging anyone 'never submitted'. Search by LAST NAME, not email (candidates often complete " +
      "under a different email). Backed by an all-forms index the server rebuilds when >12h old; " +
      "the first call of a run may take 1-2 minutes while it rebuilds — that is normal, wait for it. " +
      "Returns { hits: [{name, email, created_at, form}], index_updated_at, index_total }. Args: { query }.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search string — usually the candidate's last name." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_new_applicants",
    description:
      "Run one recruiting email channel's SOP sweep and return parsed applicants. Channels: " +
      "'website' (Careers Application leads), 'wix' (contact-form submissions — often NOT " +
      "applicants, judge each), 'wizehire' (30-day minimum window enforced; ACD = our ACM role), " +
      "'indeed' (individual Indeed application notifications with FULL body — extract candidate " +
      "name/email/role yourself; relay …@indeedemail.com addresses are valid invite targets), " +
      "'true_analysis' (broad catch-all — returns {from, subject, snippet} hits for you to eyeball), " +
      "'hazelequity' (mo@hazelequity.com catch-all; if it returns swept:false it is UNSWEPT — report " +
      "that, never 'zero applicants'). Every swept result includes mailbox_verified so an " +
      "empty list is trustworthy. Args: { channel, since_iso }.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "'website' | 'wix' | 'wizehire' | 'indeed' | 'true_analysis' | 'hazelequity'",
        },
        since_iso: { type: "string", description: "ISO timestamp — start of the sweep window." },
      },
      required: ["channel", "since_iso"],
      additionalProperties: false,
    },
  },
  {
    name: "send_recruiting_invite",
    description:
      "Send THE standard VideoAsk-invite email from mo@flatfeelandlord.com. The template and the " +
      "role→link mapping are fixed server-side; dedup (Gmail in:sent + VideoAsk contacts by last " +
      "name), the do-not-contact list, a per-day cap, and same-day idempotency are ENFORCED here — " +
      "if the tool refuses, accept the refusal and report it (do not retry with altered names). " +
      "Roles (ALL invitable since 2026-08-18, Mo's ruling): Regional Manager, Community/Apartment " +
      "Manager, Assistant Community Manager (Wizehire 'Assistant Community Director' = this), " +
      "Leasing Agent, BD/Sales Manager, Executive Assistant, Virtual Sales Rep/Executive, Virtual " +
      "PM, Virtual Leasing Specialist, Maintenance Coordinator (the last three share the Virtual PM " +
      "questionnaire — server-mapped). A role the server cannot map is refused — report it by name. " +
      "Args: { email, " +
      "first_name, last_name, role, personal_note? (short phrase from their background, e.g. " +
      "'five years of leasing experience' — used as: Your <note> really stood out.) }.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Candidate email address." },
        first_name: { type: "string", description: "Candidate first name (used in the greeting)." },
        last_name: { type: "string", description: "Candidate last name (drives the contacts dedup)." },
        role: { type: "string", description: "Role they applied for (free text; mapped server-side)." },
        personal_note: {
          type: "string",
          description: "Optional short personalization phrase from their background.",
        },
      },
      required: ["email", "first_name", "last_name", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "send_testgorilla_invite",
    description:
      "Send THE TestGorilla skills-assessment email (fixed template + link, from " +
      "mo@flatfeelandlord.com) to a candidate who FULLY COMPLETED the Virtual PM VideoAsk — i.e. " +
      "someone returned by get_videoask_completers. Dedup (Gmail Sent, subject-scoped — covers all " +
      "~290 historical manual batches), a per-day cap, same-day idempotency, and the do-not-contact " +
      "list are ENFORCED here; if it refuses, accept the refusal. Flow each run: read " +
      "testgorilla_boundary from state → get_videoask_completers since that boundary → this tool " +
      "per completer (OLDEST first) → update testgorilla_boundary to the newest completed_at you " +
      "actually processed. If the cap is hit, STOP advancing the boundary. The email names the " +
      "role they applied for: pass `role` if you know it from context; otherwise the server " +
      "recovers it from our own sent invite, and if neither works the wording stays role-neutral " +
      "(never guesses). Args: { email, name (full name), role?, completed_at? (ISO, for the log) }.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Candidate email address." },
        name: { type: "string", description: "Candidate full name (greeting uses the first word)." },
        role: { type: "string", description: "Role they applied for, if known (free text)." },
        completed_at: { type: "string", description: "When they completed the VideoAsk (ISO)." },
      },
      required: ["email", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "send_watchdog_alert",
    description:
      "Email Mo a watchdog alert (fixed recipient, capped at 3/day). Use when the browser half " +
      "(LinkedIn/Indeed) hasn't run in >3 days, when a channel is unreadable, or when something " +
      "needs a human. Args: { reason (one line), detail? }.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One-line reason (goes in the subject)." },
        detail: { type: "string", description: "Optional longer detail for the body." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    name: "get_recruiting_state",
    description:
      "Read the shared recruiting-sweep coordination state (ffl-crm Workforce Hub): last-run " +
      "timestamps per half, carry-forward list, TestGorilla batch boundary, etc. Returns { state: " +
      "{key: value, ...} }. No args.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_recruiting_state",
    description:
      "Upsert one key in the shared recruiting-sweep state. Use at the end of every run (e.g. key " +
      "'last_run_cloud' = ISO timestamp; key 'carry_forward' = array). Keys prefixed sent_/" +
      "watchdog_sent_ and the dedup index are reserved. Args: { key, value (any JSON) }.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "State key, e.g. 'last_run_cloud'." },
        value: { description: "Any JSON-serializable value." },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "report_recruiting_run",
    description:
      "Report this run to the AI Workforce Hub dashboard (agentKey recruiting-sweep) AND post Mo's " +
      "bullet report into his RingCentral channel (via the Ruckus send path). Call once at the end " +
      "of EVERY run — success or failure. Args: { status: 'ok'|'partial'|'failed', summary (one " +
      "line), needsHuman?, report }. `report` is what Mo reads on his phone: 3-8 short '- ' bullets, " +
      "plain text, no markdown headers/bold — invites sent (name + role), refusals and the one-line " +
      "why, per-channel counts, unswept channels, watchdog fired?, carry-forward, anything needing " +
      "him. ALWAYS include `report` — except on a same-day retry where the first run already " +
      "completed and you did nothing: then omit `report` so Mo isn't messaged twice (a non-ok " +
      "status still posts automatically).",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "'ok' | 'partial' | 'failed'" },
        summary: { type: "string", description: "One-line summary of what was swept/sent/skipped." },
        needsHuman: { type: "boolean", description: "True if Mo needs to look." },
        report: {
          type: "string",
          description:
            "Bullet report for Mo's RingCentral channel: 3-8 short '- ' bullets, plain text. " +
            "Omit ONLY on a no-op same-day retry.",
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
  },
];

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_videoask_completers":
      return getVideoaskCompleters(str(args, "question_id") || undefined, str(args, "since_iso"));
    case "search_videoask_contacts":
      return searchVideoaskContacts(str(args, "query"));
    case "get_new_applicants":
      return getNewApplicants(str(args, "channel"), str(args, "since_iso"));
    case "send_recruiting_invite":
      return sendRecruitingInvite({
        email: str(args, "email"),
        first_name: str(args, "first_name"),
        last_name: str(args, "last_name"),
        role: str(args, "role"),
        personal_note: str(args, "personal_note") || undefined,
      });
    case "send_testgorilla_invite":
      return sendTestgorillaInvite({
        email: str(args, "email"),
        name: str(args, "name"),
        role: str(args, "role") || undefined,
        completed_at: str(args, "completed_at") || undefined,
      });
    case "send_watchdog_alert":
      return sendWatchdogAlert(str(args, "reason"), str(args, "detail") || undefined);
    case "get_recruiting_state":
      return getRecruitingState();
    case "update_recruiting_state":
      return updateRecruitingState(str(args, "key"), args.value);
    case "report_recruiting_run":
      return reportRecruitingRunWithRc({
        status: str(args, "status"),
        summary: str(args, "summary"),
        needsHuman: args.needsHuman === true,
        report: str(args, "report") || undefined,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function buildServer(): Server {
  const server = new Server(
    { name: "recruiting-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      const result = await dispatch(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error invoking ${name}: ${err instanceof Error ? err.message : String(err)}`,
          },
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
  const incomingBearer = (req.headers["authorization"] ?? "")
    .toString()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!incomingBearer || !recruitingMcpTokenOk(incomingBearer)) {
    // Fails closed when RECRUITING_MCP_TOKEN is unset/short.
    sendJson(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }
  const server = buildServer();
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
