/**
 * Ruckus's standing orders and memory (Mo, 2026-10-13): "i need ruckus … to
 * create new recurring tasks or a memory if i ask it directly in ringcentral
 * … rather than come to claude to build it for me."
 *
 * Thin relay to ffl-crm POST /api/ringcentral/ruckus-schedule, which stores
 * the orders and fires them from cron/ruckus-standing-orders every 5 minutes.
 * Same auth as ruckus_send: the agent's forwarded bearer (= CRM CRON_SECRET).
 */

export const ORDER_TOOL_NAMES = ["ruckus_schedule", "ruckus_memory", "ruckus_action", "ruckus_resman", "ruckus_jordan"] as const;
export type OrderToolName = (typeof ORDER_TOOL_NAMES)[number];

export function isOrderTool(name: string): name is OrderToolName {
  return (ORDER_TOOL_NAMES as readonly string[]).includes(name);
}

export const ORDER_TOOLS = [
  {
    name: "ruckus_schedule",
    description:
      "Your standing orders: things Mo, Yuliana or Sam ask you to do on a schedule or at a later time, which you set up YOURSELF the moment they ask " +
      "(never say a developer must build it). A scheduled run is a fresh session of you with the instruction, where to post, your last summary and the " +
      "notes you saved, so 'add only what is new since the last message' works. Actions: " +
      "create {kind: recurring|once|watch, title (a few words), instruction (plain English, exactly what to do and post each run, for whom, and whether to add only what is new), " +
      "times?: ['17:00','08:00'] Houston clock times (recurring; linked runs like '5 PM tomorrow / 8 AM today' are ONE order with two times, never two orders), days?: daily|weekdays|weekends|'mon,wed,fri' (default daily), runAt?: 'YYYY-MM-DDTHH:MM' Houston (once), " +
      "watch?: {type: gmail {mailbox, query} | ledger {lane?, redOnly?} | agent_failed {agentKey?} | cfa_application | meeting {leadMinutes?}} + everyMinutes? (watch: code checks every N min, default 15, and wakes you only on a NEW hit — 'tell me the moment an email from X lands', 'when an owner gives notice', 'when a worker fails', '20 min before each meeting'), " +
      "chatId: the chat it was asked in (the id from your kickoff prompt, or 'main') unless they name another chat, business?: ffl|cranbrook|both (default ffl), requestedBy: the sender's name} " +
      "→ the order with its # and the first run time; confirm that in one line. " +
      "list {includeInactive?} → every order with #, schedule, chat, last run and summary; " +
      "update {seq or id, by, + any of title/instruction/times/days/runAt/chatId/business}; " +
      "pause {seq, by} · resume {seq} · cancel {seq, by} · run_now {seq} (fires it immediately, schedule unchanged); " +
      "report {id, summary, state?, failed?, error?} — call this at the END of every scheduled run you are given: summary = what you posted in one or two lines, " +
      "state = a small JSON object of what the next run needs (ids or titles already mentioned, the time you covered through). " +
      "commitment {what, owner (a person), due 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' Houston, chatId, requestedBy (who it was promised to)} — someone promised something by a date: logs a ledger item under the owner and chases THEM in that chat when due; use it for delegation too ('have Sergio…' → do it, then log the commitment). " +
      "huddle_undo {n, reason?, by} — a churn-list update landed on the wrong owner or was wrong: restores the board status, marks its contact notes VOID, reopens the churn item; people can also just type 'undo #2' in chat. " +
      "A shared chat (people beyond Mo and Yuliana) refuses orders that touch email, calendar, money or people matters — relay the reason and offer the main chat. " +
      "A scheduled run may do what you may do live in chat; it must not send email, delete, or message a renter or owner unless its instruction says so.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "update", "pause", "resume", "cancel", "run_now", "report", "commitment", "huddle_undo"] },
        n: { type: "integer", description: "huddle_undo: the number on today's churn list (1-99)." },
        reason: { type: "string", description: "huddle_undo: why, in a few words (goes on the VOID note)." },
        kind: { type: "string", enum: ["recurring", "once", "watch"] },
        watch: { type: "object", description: "watch: {type: gmail|ledger|agent_failed|cfa_application|meeting, mailbox?, query?, lane?, redOnly?, agentKey?, leadMinutes?}", additionalProperties: true },
        everyMinutes: { type: "integer", minimum: 5, description: "watch: minutes between checks (default 15)." },
        what: { type: "string", description: "commitment: what was promised." },
        owner: { type: "string", description: "commitment: the person who owes it." },
        due: { type: "string", description: "commitment: 'YYYY-MM-DD' (chased 9 AM) or 'YYYY-MM-DDTHH:MM' Houston." },
        title: { type: "string" },
        instruction: { type: "string" },
        times: { type: "array", items: { type: "string" }, description: "Houston clock times, e.g. ['17:00', '08:00'] or ['5 pm']." },
        days: { type: "string", description: "daily | weekdays | weekends | day names like 'mon,wed,fri'." },
        runAt: { type: "string", description: "once: 'YYYY-MM-DDTHH:MM' Houston time." },
        chatId: { type: "string", description: "RingCentral chat id the result posts into, or 'main'." },
        business: { type: "string", enum: ["ffl", "cranbrook", "both"] },
        requestedBy: { type: "string", description: "create: the person who asked (never an agent)." },
        by: { type: "string", description: "update / pause / cancel: who asked for the change." },
        seq: { type: "integer", description: "The order's # (from list or create)." },
        id: { type: "string", description: "The order's id (report uses the id given in the run prompt)." },
        includeInactive: { type: "boolean" },
        summary: { type: "string", description: "report: what you posted, one or two lines." },
        state: { type: "object", description: "report: small JSON the next run needs.", additionalProperties: true },
        failed: { type: "boolean", description: "report: true when the run could not do what the order says." },
        error: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "ruckus_memory",
    description:
      "Your long-term memory: facts and rules people tell you to keep ('remember that Sergio handles the Dallas vendors', 'always cc Yuliana on owner emails', " +
      "'from now on don't list Indeed replies'). Every memory rides into every conversation you have as a STANDING RULE, so keep each one short — one fact or " +
      "rule per call, under 600 characters — and never store email contents, passwords, card numbers or anything a person would not want in a settings page. Actions: " +
      "remember {text, by (who told you), scope?: global | lane:sales | lane:churn | lane:cranbrook | lane:wo | lane:delinquency | lane:blog, until?: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' Houston — for day mode ('Mo is out Thursday') so it expires on its own} → stored (duplicates are merged); " +
      "forget {id, by} or forget {match (words from the memory), by} — one match forgets, several come back for you to ask which; " +
      "memories {query?} → what you remember (id, text, who, when). Confirm a memory in one line, quoting it back. " +
      "COMMUNICATION-STYLE PROFILES (Mo 2026-10-14): questionnaire {person: first name} → the 10-question text to post AS IS with ruckus_send (one message out, one message back); " +
      "profile_set {person, profile (compact plain words: what first, length, shape, on problems, on decisions, nudging, learning, tone, timing/quiet hours, pet peeves), by} → saved, replaces the old one; read it back and accept corrections with profile_set again; " +
      "profile_get {person?} → the saved profiles. Every kickoff carries them as HOW EACH PERSON WANTS IT — write to each person by theirs.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["remember", "forget", "memories", "questionnaire", "profile_set", "profile_get"] },
        person: { type: "string", description: "questionnaire / profile_*: the person's first name." },
        profile: { type: "string", description: "profile_set: the compact profile text." },
        text: { type: "string" },
        by: { type: "string" },
        scope: { type: "string" },
        until: { type: "string", description: "remember: when this memory stops applying (Houston)." },
        id: { type: "string" },
        match: { type: "string" },
        query: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

ORDER_TOOLS.push(
  {
    name: "ruckus_action",
    description:
      "Do something that needs a person's OK (Mo 2026-10-14: take action in ResMan, AppFolio, VestLaunch 'so long as it gets explicit approval'). " +
      "propose {system: resman|appfolio|vestlaunch|paige, summary (ONE line: what will change), requestedBy (who asked), and EITHER instruction (resman/appfolio: the exact step with names, unit numbers, amounts, dates — one concrete change) " +
      "OR tool + args (vestlaunch: a VestLaunch tool name such as update_feature_request, update_contact, create_task, with its exact arguments), business?: ffl|cranbrook, chatId?} " +
      "→ an approval card with a code (A12) is posted; Mo or Yuliana replies 'approve A12' and code runs it and posts the result (✅/⚠️). paige = an extra Paige AP run now (no instruction needed). " +
      "Tell the person the code and that it runs after approval; never say it's done before the result posts. list → recent requests and results. " +
      "preapprove {system: vestlaunch|paige, tool, business?, requestedBy} → asks Mo/Yuliana (its own approval card) for a STANDING OK so matching proposals run without asking each time; only routine record-keeping qualifies " +
      "(add_feature_request_note, create_task, update_task, add_note, an extra Paige run) — never ticket status/wording, tags, ResMan/AppFolio changes, money, owner records, messages or deletes. " +
      "unpreapprove {code (the A# that granted it) or tool} ends one. standing → the ones that are on.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "list", "preapprove", "unpreapprove", "standing"] },
        system: { type: "string", enum: ["resman", "appfolio", "vestlaunch", "paige"] },
        code: { type: "string" },
        summary: { type: "string" },
        instruction: { type: "string" },
        tool: { type: "string" },
        args: { type: "object", additionalProperties: true },
        business: { type: "string", enum: ["ffl", "cranbrook"] },
        requestedBy: { type: "string" },
        chatId: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "ruckus_resman",
    description:
      "Read ResMan (Cranbrook Forest's accounting system) live — read only, no approval needed. vendors {term} → matching vendors (id, default GL, 1099). " +
      "vendor_invoices {vendor, start?: 'M/D/YYYY' (default 1/1/2025), end?: default today, number?: invoice #} → every invoice for that vendor in the range, ALL statuses incl. paid " +
      "(number, dates, paid date, description, expense type, total, status). Takes about a minute; if Paige is mid-run it says to try again in ~10 minutes. " +
      "Use it before saying whether an invoice is in ResMan, paid or open. Cranbrook data: post only in chats that may hear Cranbrook.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["vendors", "vendor_invoices"] },
        term: { type: "string" },
        vendor: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        number: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "ruckus_jordan",
    description:
      "Talk to Jordan, FFL's AI sales assistant and your coworker (she texts and emails landlord leads for Sam and knows each lead's conversation, drafts, consent and waits). " +
      "ask {question, lead?: name or contact id} → her answer now (no lead → her whole pipeline: what's waiting on Sam, recent sends). " +
      "tell {lead, text, by: who on the team said it, send?: true, replyToId?} → a team note she follows in every message to that lead for 30 days; with send: true she also writes and sends that lead a message now " +
      "(consent, quiet hours, STOP and wait rules still apply; the result says sent, queued for their texting hours, or why not). A send that mentions price, fees, discounts, free, refunds, contracts or terms is refused unless okBy names who OK'd it in chat (Sam or Mo). " +
      "log {hours?} → what you and Jordan said to each other.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["ask", "tell", "log"] },
        question: { type: "string" },
        lead: { type: "string" },
        text: { type: "string" },
        by: { type: "string" },
        send: { type: "boolean" },
        replyToId: { type: "string" },
        okBy: { type: "string" },
        hours: { type: "number" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
);

function baseUrl(): string {
  return (
    (process.env.RUCKUS_SEND_BASE_URL ?? "").trim().replace(/\/+$/, "") ||
    (process.env.VESTLAUNCH_BASE_URL ?? "").trim().replace(/\/+$/, "") ||
    "https://crm.vestlaunch.com"
  );
}

export async function runOrderTool(name: OrderToolName, args: Record<string, unknown>, forwardToken?: string): Promise<unknown> {
  const token = (forwardToken ?? "").trim() || (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!token) throw new Error("Not configured: RUCKUS_SEND_TOKEN (= CRM CRON_SECRET) is missing.");
  const action = typeof args.action === "string" ? args.action : "";
  if (name === "ruckus_resman") return runResman(args);
  if (name === "ruckus_action") {
    const map: Record<string, string> = { propose: "propose_action", list: "list_actions", preapprove: "propose_standing", unpreapprove: "revoke_standing", standing: "list_standing" };
    if (!map[action]) throw new Error("ruckus_action: action must be propose, list, preapprove, unpreapprove or standing");
    args = { ...args, action: map[action] };
    return runOrderTool("ruckus_schedule", args, forwardToken);
  }
  if (name === "ruckus_jordan") {
    if (action !== "ask" && action !== "tell" && action !== "log") throw new Error("ruckus_jordan: action must be ask, tell or log");
    args = { ...args, action: `jordan_${action}` };
    return runOrderTool("ruckus_schedule", args, forwardToken);
  }
  const allowed: Record<string, string[]> = {
    ruckus_schedule: ["create", "list", "update", "pause", "resume", "cancel", "run_now", "report", "commitment", "huddle_undo", "propose_action", "list_actions", "propose_standing", "revoke_standing", "list_standing", "jordan_ask", "jordan_tell", "jordan_log"],
    ruckus_memory: ["remember", "forget", "memories", "questionnaire", "profile_set", "profile_get"],
  };
  if (!allowed[name].includes(action)) throw new Error(`${name}: action must be one of ${allowed[name].join(", ")}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), String(args.action).startsWith("jordan_") ? 120_000 : 55_000);
  try {
    const res = await fetch(`${baseUrl()}/api/ringcentral/ruckus-schedule`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "ruckus-mcp-http/0.1.0" },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: res.ok, status: res.status, raw: text.slice(0, 500) };
    }
  } finally {
    clearTimeout(timer);
  }
}


/** ResMan reads through the VPS operator (stream.vestlaunch.com/ruckus-ops). */
async function runResman(args: Record<string, unknown>): Promise<unknown> {
  const token = (process.env.RUCKUS_OPS_TOKEN ?? "").trim();
  if (!token) return { ok: false, error: "ResMan access is not configured (RUCKUS_OPS_TOKEN)." };
  const base = (process.env.RUCKUS_OPS_URL ?? "https://stream.vestlaunch.com/ruckus-ops").replace(/\/+$/, "");
  const action = String(args.action ?? "");
  const q = new URLSearchParams();
  let path: string;
  if (action === "vendors") {
    path = "/resman/vendors";
    q.set("term", String(args.term ?? ""));
  } else if (action === "vendor_invoices") {
    path = "/resman/vendor-invoices";
    if (!args.vendor) return { ok: false, error: "vendor is required" };
    for (const k of ["vendor", "start", "end", "number"]) if (args[k]) q.set(k, String(args[k]));
  } else return { ok: false, error: "action must be vendors or vendor_invoices" };
  const res = await fetch(`${base}${path}?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(190_000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, status: res.status, raw: text.slice(0, 300) }; }
}
