/**
 * Ruckus's standing orders and memory (Mo, 2026-10-13): "i need ruckus … to
 * create new recurring tasks or a memory if i ask it directly in ringcentral
 * … rather than come to claude to build it for me."
 *
 * Thin relay to ffl-crm POST /api/ringcentral/ruckus-schedule, which stores
 * the orders and fires them from cron/ruckus-standing-orders every 5 minutes.
 * Same auth as ruckus_send: the agent's forwarded bearer (= CRM CRON_SECRET).
 */

export const ORDER_TOOL_NAMES = ["ruckus_schedule", "ruckus_memory"] as const;
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
      "A shared chat (people beyond Mo and Yuliana) refuses orders that touch email, calendar, money or people matters — relay the reason and offer the main chat. " +
      "A scheduled run may do what you may do live in chat; it must not send email, delete, or message a renter or owner unless its instruction says so.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "update", "pause", "resume", "cancel", "run_now", "report", "commitment"] },
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
  const allowed: Record<OrderToolName, string[]> = {
    ruckus_schedule: ["create", "list", "update", "pause", "resume", "cancel", "run_now", "report", "commitment"],
    ruckus_memory: ["remember", "forget", "memories", "questionnaire", "profile_set", "profile_get"],
  };
  if (!allowed[name].includes(action)) throw new Error(`${name}: action must be one of ${allowed[name].join(", ")}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
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
