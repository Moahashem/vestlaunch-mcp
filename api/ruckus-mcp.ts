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
 *   3. `ruckus_diagnose_worker` — read a worker's recent hub runs (incl. real
 *                              errorMessage), classify against known failure
 *                              signatures, recommend rerun vs escalate. Read-only.
 *   4. `ruckus_publish_blog_pr` — merge ONE open [LEGAL REVIEW]/[CALENDAR REVIEW]
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
// ruckus_diagnose_worker — Ruckus's EYES on a failed worker (read-only)
// ---------------------------------------------------------------------------
//
// Reads a worker's recent run-status rows from the AI Workforce hub (ffl-crm
// GET /api/v1/agent/run-status — includes the real errorMessage the cron
// recorded), classifies the failure against FFL's known failure signatures,
// and returns a plain-English diagnosis + a recommended next step. Read-only:
// this tool changes nothing; acting on the recommendation is a separate,
// deliberate call (ruckus_rerun_worker) or an escalation to a human.

const DIAGNOSE_TOOL_NAME = "ruckus_diagnose_worker";

/** worker key (same keys as ruckus_rerun_worker) → hub agentKey + notes. */
const DIAGNOSE_WORKERS: Record<
  string,
  { agentKey: string; label: string; rerunnable: boolean; note?: string }
> = {
  "sales-leads": { agentKey: "sales-lead-count", label: "FFL Sales Daily Lead Counter", rerunnable: true },
  occupancy: { agentKey: "occupancy", label: "FFL Daily Occupancy Counter (AppFolio)", rerunnable: true },
  showmojo: { agentKey: "showmojo", label: "FFL ShowMojo Agent", rerunnable: true },
  cfa: { agentKey: "cranbrook-cfa", label: "FFL CFA Daily Numbers (Cranbrook/ResMan)", rerunnable: true },
  "cf-leads": { agentKey: "cranbrook-cf-leads", label: "FFL CF Leasing Daily Lead Counter", rerunnable: true },
  onboarding: { agentKey: "onboarding", label: "FFL Owner Onboarding Tracker", rerunnable: true },
  "boom-screenings": {
    agentKey: "boom-screenings",
    label: "Boom screenings pull",
    rerunnable: true,
    note:
      "KNOWN ISSUE since mid-June: the Boom Partner API rejects every key (HTTP 401); only their " +
      "sandbox connects. This is a Boom-side/vendor problem — re-running does NOT fix it. " +
      "Status of the Boom support ticket is the only real fix.",
  },
  "recruiting-sweep": { agentKey: "recruiting-sweep", label: "Daily recruiting sweep", rerunnable: true },
  "caller-name-fill": { agentKey: "caller-name-fill", label: "Caller name fill", rerunnable: true },
  "appfolio-entry": {
    agentKey: "appfolio-entry",
    label: "AppFolio owner-intake entry (intake chain)",
    rerunnable: false,
    note:
      "INTAKE CHAIN — diagnosis only, NEVER re-run out of schedule. It writes real owner data into " +
      "AppFolio and has its own watchdogs. About half of historical intake alerts are false alarms " +
      "from the watchdogs themselves. Anything here beyond reading status needs a human.",
  },
};

/** A known failure signature: pattern → what it means and what to do. */
interface FailureSignature {
  kind: string;
  pattern: RegExp;
  plainEnglish: string;
  recommendation: "rerun_likely_fixes" | "wait_then_rerun" | "needs_human" | "needs_engineer";
}

// Ordered — first match wins. Specific signatures before generic ones.
const FAILURE_SIGNATURES: FailureSignature[] = [
  {
    kind: "passkey_or_2fa",
    pattern: /passkey|two.?factor|2fa|verification code|mfa|authenticator/i,
    plainEnglish:
      "The source system is demanding a passkey/verification code the server cannot provide. This is " +
      "the recurring AppFolio-style lockout — re-running just hits the same wall.",
    recommendation: "needs_human",
  },
  {
    kind: "auth_rejected",
    pattern: /\b401\b|unauthoriz|invalid[^.]*(key|token|credential)|expired[^.]*(key|token|session)|login failed|authentication/i,
    plainEnglish:
      "A login or API key was rejected. Re-running won't fix a bad credential — the key or password " +
      "needs to be checked/rotated by a human.",
    recommendation: "needs_human",
  },
  {
    kind: "permission_denied",
    pattern: /\b403\b|forbidden|insufficient scope|permission denied/i,
    plainEnglish:
      "Access was denied — the account or API key doesn't have the right permission. A human needs to " +
      "grant the missing access.",
    recommendation: "needs_human",
  },
  {
    kind: "rate_limited",
    pattern: /\b429\b|rate limit|too many requests/i,
    plainEnglish:
      "The source system said 'slow down' (rate limit). Waiting a bit and re-running usually works.",
    recommendation: "wait_then_rerun",
  },
  {
    kind: "sheet_write_shape",
    pattern: /batchUpdate|\bHTTP 400\b.*(sheet|zapier)|zapier.*400/i,
    plainEnglish:
      "The write to Google Sheets was rejected (malformed request — the known Zapier " +
      "pre-serialized-JSON landmine). This is a code bug, not a flake: an engineer needs to fix the " +
      "payload; re-running will fail the same way.",
    recommendation: "needs_engineer",
  },
  {
    kind: "page_changed",
    pattern: /selector|locator|element not found|no element|waiting for.*(failed|timed? ?out)|navigation (failed|timeout)|page.crash/i,
    plainEnglish:
      "The scraper couldn't find what it expected on the page — the website's layout likely changed. " +
      "One re-run is worth trying (sites glitch), but if it fails the same way twice, the scraper code " +
      "needs an engineer.",
    recommendation: "rerun_likely_fixes",
  },
  {
    kind: "transient_network",
    pattern: /time.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|network|\b50[234]\b|bad gateway|service unavailable|gateway/i,
    plainEnglish:
      "The source website or API was slow or briefly down when the worker ran. This is the classic " +
      "transient failure — a re-run very likely just works.",
    recommendation: "rerun_likely_fixes",
  },
  {
    kind: "not_configured",
    pattern: /missing env|not configured|no api key|env var/i,
    plainEnglish:
      "The worker is missing a setting (an environment variable or key was removed or never set). A " +
      "human needs to restore the setting; re-running changes nothing.",
    recommendation: "needs_human",
  },
  {
    kind: "empty_data",
    pattern: /no data|empty|zero (rows|records)|nothing (found|returned)/i,
    plainEnglish:
      "The worker ran but found no data. Sometimes that's real (nothing happened yesterday); sometimes " +
      "the source moved. Re-run once; if still empty and that seems wrong, escalate.",
    recommendation: "rerun_likely_fixes",
  },
];

function classifyFailure(text: string): {
  kind: string;
  plainEnglish: string;
  recommendation: string;
} {
  for (const sig of FAILURE_SIGNATURES) {
    if (sig.pattern.test(text)) {
      return { kind: sig.kind, plainEnglish: sig.plainEnglish, recommendation: sig.recommendation };
    }
  }
  return {
    kind: "unknown",
    plainEnglish:
      "This failure doesn't match any known pattern. Try ONE re-run; if it fails again the same way, " +
      "report the error text to Mo and recommend an engineer look at it — do not keep re-running.",
    recommendation: "rerun_likely_fixes",
  };
}

const DIAGNOSE_TOOL_DESC =
  "Diagnose a worker agent's recent runs — your EYES when something fails. Reads the worker's last " +
  "runs from the AI Workforce hub INCLUDING the real recorded error message, matches the failure " +
  "against FFL's known failure signatures, and returns a plain-English root-cause read plus a " +
  "recommended next step (rerun_likely_fixes / wait_then_rerun / needs_human / needs_engineer). " +
  "Read-only — it changes nothing. Standard flow when a run failed or looks wrong: 1) call this, " +
  "2) if it says a re-run likely fixes it AND the worker is rerunnable, call ruckus_rerun_worker, " +
  "3) confirm with get_agent_runs a few minutes later, 4) report the root cause and outcome in plain " +
  "English — never just 'it failed'. Never re-run a worker this tool marks rerunnable:false " +
  "(the AppFolio intake chain). If the same worker fails the same way twice after a re-run, stop and " +
  "escalate — repeated re-runs are noise, not persistence. Workers: " +
  Object.entries(DIAGNOSE_WORKERS)
    .map(([k, w]) => `'${k}' (${w.label})`)
    .join(", ") +
  ". Args: { worker } (required). Returns { worker, label, rerunnable, workerNote, latestRun, " +
  "recentRuns, diagnosis }.";

const DIAGNOSE_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    worker: {
      type: "string",
      enum: Object.keys(DIAGNOSE_WORKERS),
      description: "Which worker to diagnose.",
    },
  },
  required: ["worker"],
  additionalProperties: false,
};

/** ffl-crm hub base + API key (mirrors workforce-hub.ts, which keeps them private). */
function diagHubBaseUrl(): string {
  const vest = (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (vest) return vest;
  const legacy = (process.env.AGENT_OS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (legacy) return legacy;
  return "https://crm.vestlaunch.com";
}
function diagHubApiKey(): string {
  const primary = (process.env.FFL_WORKFORCE_API_KEY ?? "").trim();
  if (primary) return primary;
  return (process.env.VESTLAUNCH_API_KEY ?? "").trim();
}

interface HubRunRow {
  agentKey?: string;
  status?: string;
  summary?: string | null;
  errorMessage?: string | null;
  needsHuman?: boolean;
  ranAt?: string;
  durationMs?: number | null;
}

async function ruckusDiagnoseWorker(
  args: Record<string, unknown>,
  forwardToken?: string,
): Promise<unknown> {
  // Same caller gate as rerun/publish.
  const expectedBearer = (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!expectedBearer) {
    throw new Error("ruckus_diagnose_worker is not configured: RUCKUS_SEND_TOKEN missing.");
  }
  if ((forwardToken ?? "").trim() !== expectedBearer) {
    throw new Error("ruckus_diagnose_worker: unauthorized bearer.");
  }

  const worker = typeof args.worker === "string" ? args.worker.trim() : "";
  const entry = DIAGNOSE_WORKERS[worker];
  if (!entry) {
    throw new Error(
      `Unknown worker '${worker}'. Valid workers: ${Object.keys(DIAGNOSE_WORKERS).join(", ")}.`,
    );
  }

  const apiKey = diagHubApiKey();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Not configured: no hub API key (FFL_WORKFORCE_API_KEY) in this deployment's env — " +
        "tell Mo the diagnosis tool can't read the hub yet.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(
      `${diagHubBaseUrl()}/api/v1/agent/run-status?agentKey=${encodeURIComponent(entry.agentKey)}&limit=8`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "ruckus-mcp-diagnose/0.1.0" },
        signal: controller.signal,
      },
    );
    const text = await res.text();
    if (res.status === 403) {
      return {
        ok: false,
        error:
          "The hub API key was refused (needs the agent:read scope). Tell Mo: in the CRM's API key " +
          "settings, the workforce key needs 'agent:read' added — one-time fix.",
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Hub read failed (HTTP ${res.status}): ${text.slice(0, 200)}` };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "Hub returned unparseable data." };
    }
    const rows: HubRunRow[] = Array.isArray((parsed as { data?: unknown })?.data)
      ? ((parsed as { data: HubRunRow[] }).data)
      : Array.isArray(parsed)
        ? (parsed as HubRunRow[])
        : [];

    if (rows.length === 0) {
      return {
        ok: true,
        worker,
        label: entry.label,
        rerunnable: entry.rerunnable,
        workerNote: entry.note,
        diagnosis: {
          kind: "no_runs_recorded",
          plainEnglish:
            "The hub has no recorded runs for this worker. Either it has never reported in, or its " +
            "kickoff is failing before it can even log — that itself is worth flagging to Mo.",
          recommendation: entry.rerunnable ? "rerun_likely_fixes" : "needs_human",
        },
        recentRuns: [],
      };
    }

    const compact = rows.map((r) => ({
      status: r.status,
      ranAt: r.ranAt,
      needsHuman: r.needsHuman,
      summary: (r.summary ?? "").toString().slice(0, 300),
      errorMessage: (r.errorMessage ?? "").toString().slice(0, 500),
    }));
    const latest = compact[0];
    const latestFailed = rows.find((r) => r.status !== "ok");

    let diagnosis: { kind: string; plainEnglish: string; recommendation: string };
    if (latest.status === "ok") {
      diagnosis = {
        kind: "healthy_now",
        plainEnglish:
          "The most recent run succeeded — the worker is healthy right now. If someone reported a " +
          "problem, it either self-recovered or the problem is elsewhere (check the numbers, not the worker).",
        recommendation: "none",
      };
    } else {
      const evidence = `${latest.errorMessage} ${latest.summary}`;
      diagnosis = classifyFailure(evidence);
      // Two same-signature failures in a row → stop recommending re-runs.
      const prior = compact[1];
      if (
        prior &&
        prior.status !== "ok" &&
        diagnosis.recommendation === "rerun_likely_fixes" &&
        classifyFailure(`${prior.errorMessage} ${prior.summary}`).kind === diagnosis.kind
      ) {
        diagnosis = {
          kind: `${diagnosis.kind}_repeated`,
          plainEnglish:
            diagnosis.plainEnglish +
            " HOWEVER: it has now failed the same way twice in a row, so a re-run is unlikely to " +
            "help — escalate with the error text instead of re-running again.",
          recommendation: "needs_engineer",
        };
      }
    }
    if (!entry.rerunnable && diagnosis.recommendation === "rerun_likely_fixes") {
      diagnosis = { ...diagnosis, recommendation: "needs_human" };
    }

    return {
      ok: true,
      worker,
      label: entry.label,
      rerunnable: entry.rerunnable,
      workerNote: entry.note,
      latestRun: latest,
      latestFailedRun: latestFailed
        ? {
            status: latestFailed.status,
            ranAt: latestFailed.ranAt,
            errorMessage: (latestFailed.errorMessage ?? "").toString().slice(0, 500),
            summary: (latestFailed.summary ?? "").toString().slice(0, 300),
          }
        : null,
      recentRuns: compact,
      diagnosis,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, worker, error: `Diagnosis fetch failed: ${msg}` };
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
      { name: DIAGNOSE_TOOL_NAME, description: DIAGNOSE_TOOL_DESC, inputSchema: DIAGNOSE_TOOL_SCHEMA },
      { name: PUBLISH_TOOL_NAME, description: PUBLISH_TOOL_DESC, inputSchema: PUBLISH_TOOL_SCHEMA },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    if (
      name !== TOOL_NAME &&
      name !== RERUN_TOOL_NAME &&
      name !== DIAGNOSE_TOOL_NAME &&
      name !== PUBLISH_TOOL_NAME
    ) {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const result =
        name === PUBLISH_TOOL_NAME
          ? await ruckusPublishBlogPr(args, forwardToken)
          : name === DIAGNOSE_TOOL_NAME
            ? await ruckusDiagnoseWorker(args, forwardToken)
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
