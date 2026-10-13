/**
 * Ruckus's email + calendar tools (Mo, 2026-10-13): "i want ruckus to be able
 * to manage her emails and calendar for yuli@flatfeelandlord.com and
 * yuliana@hazelmanagement.com".
 *
 * Thin relay to ffl-crm POST /api/ringcentral/ruckus-assistant, which holds
 * the Google tokens and does the work live against Gmail / Google Calendar.
 * Same auth as ruckus_send: the agent's forwarded bearer (= CRM CRON_SECRET).
 */

export const ASSISTANT_TOOL_NAMES = ["assistant_mailboxes", "assistant_mail", "assistant_calendar"] as const;
export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

export function isAssistantTool(name: string): name is AssistantToolName {
  return (ASSISTANT_TOOL_NAMES as readonly string[]).includes(name);
}

const OWNER_RULE =
  " Act on a mailbox ONLY when its owner (or Mo) asked you to in the chat. Hazel (hazelmanagement.com) mailboxes are Cranbrook business: post about them in the main chat only, never Sam's.";

export const ASSISTANT_TOOLS = [
  {
    name: "assistant_mailboxes",
    description:
      "List the email + calendar accounts you can manage, whose they are, which business (ffl / cranbrook) and whether each is connected. " +
      "Call this before saying you can or can't access someone's email. A mailbox not listed as connected cannot be read — give its owner the connect link from the result.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "assistant_mail",
    description:
      "Manage a connected mailbox's email, live in Gmail." +
      OWNER_RULE +
      " Actions: " +
      "search {query (Gmail search syntax, e.g. 'is:unread', 'category:promotions', 'from:amazon.com older_than:30d'), max ≤50} → messages with id, from, subject, date, snippet; " +
      "read {id} → full text; " +
      "modify {change: archive|unarchive|trash|untrash|mark_read|mark_unread|star|unstar|add_label|remove_label, ids[] OR query, label?} — trash is recoverable for 30 days, never permanent; max 500 per call; " +
      "unsubscribe {ids[] OR query, trash?: true} — uses each sender's own unsubscribe (one-click or unsubscribe email), once per sender; senders that only offer a web page come back in needsAPerson with the link; " +
      "compose {to?, cc?, subject?, body, replyToId?, send?} — saves a DRAFT unless send: true; replyToId threads a reply to that message. " +
      "Example — 'unsubscribe me from advertising and delete it': action unsubscribe, query 'category:promotions', trash true; repeat while more is true.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string", description: "The mailbox email, e.g. yuli@flatfeelandlord.com." },
        action: { type: "string", enum: ["search", "read", "modify", "unsubscribe", "compose"] },
        query: { type: "string", description: "Gmail search, for search / modify / unsubscribe." },
        max: { type: "integer", minimum: 1, maximum: 50 },
        id: { type: "string", description: "Message id, for read." },
        ids: { type: "array", items: { type: "string" }, description: "Message ids, for modify / unsubscribe." },
        change: {
          type: "string",
          enum: ["archive", "unarchive", "trash", "untrash", "mark_read", "mark_unread", "star", "unstar", "add_label", "remove_label"],
        },
        label: { type: "string" },
        trash: { type: "boolean", description: "unsubscribe: also move those messages to Trash." },
        to: { type: "string" },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text; blank lines start new paragraphs." },
        replyToId: { type: "string" },
        send: { type: "boolean", description: "true = send now. Default saves a draft." },
      },
      required: ["mailbox", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "assistant_calendar",
    description:
      "Manage a connected mailbox's Google Calendar, live." +
      OWNER_RULE +
      " Times: 'YYYY-MM-DD' (all day) or 'YYYY-MM-DDTHH:MM' (Houston time). Actions: " +
      "list {from?, to?, query?} (default next 7 days); " +
      "create {title, start, end, description?, location?, attendees?[], addMeet?, notifyAttendees?}; " +
      "update {eventId, + fields to change, notifyAttendees?}; " +
      "delete {eventId, notifyAttendees?}; " +
      "respond {eventId, response: accepted|declined|tentative}; " +
      "free_busy {from?, to?}. Guests are only emailed when notifyAttendees is true.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        action: { type: "string", enum: ["list", "create", "update", "delete", "respond", "free_busy"] },
        from: { type: "string" },
        to: { type: "string" },
        query: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 250 },
        eventId: { type: "string" },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        addMeet: { type: "boolean" },
        notifyAttendees: { type: "boolean" },
        response: { type: "string", enum: ["accepted", "declined", "tentative"] },
        calendarId: { type: "string", description: "Rarely needed; default is the main calendar." },
      },
      required: ["mailbox", "action"],
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

export async function runAssistantTool(name: AssistantToolName, args: Record<string, unknown>, forwardToken?: string): Promise<unknown> {
  const token = (forwardToken ?? "").trim() || (process.env.RUCKUS_SEND_TOKEN ?? "").trim();
  if (!token) throw new Error("Not configured: RUCKUS_SEND_TOKEN (= CRM CRON_SECRET) is missing.");
  const body = name === "assistant_mailboxes" ? { tool: "mailboxes" } : { ...args, tool: name === "assistant_mail" ? "mail" : "calendar" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110_000);
  try {
    const res = await fetch(`${baseUrl()}/api/ringcentral/ruckus-assistant`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "ruckus-mcp-http/0.1.0" },
      body: JSON.stringify(body),
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
