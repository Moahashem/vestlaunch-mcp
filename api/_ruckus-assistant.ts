/**
 * Ruckus's email + calendar tools (Mo, 2026-10-13): "i want ruckus to be able
 * to manage her emails and calendar for yuli@flatfeelandlord.com and
 * yuliana@hazelmanagement.com".
 *
 * Thin relay to ffl-crm POST /api/ringcentral/ruckus-assistant, which holds
 * the Google tokens and does the work live against Gmail / Google Calendar.
 * Same auth as ruckus_send: the agent's forwarded bearer (= CRM CRON_SECRET).
 */

export const ASSISTANT_TOOL_NAMES = ["assistant_mailboxes", "assistant_mail", "assistant_calendar", "assistant_drive", "assistant_contacts", "assistant_tasks"] as const;
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
      "List the Google accounts you can work in: whose they are, which business (ffl / cranbrook / other), whether each is connected, and what it allows " +
      "(can / missing among email, calendar, drive, contacts, tasks). Call this before saying you can or can't access someone's email, files, contacts or tasks. " +
      "An account not connected — or missing a capability — can't be used for it: give its owner the reconnect link from the result.",
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
      "compose {to?, cc?, subject?, body, replyToId?, send?} — saves a DRAFT unless send: true; replyToId threads a reply to that message; " +
      "save_attachment {id (message id), filename?, folderId?} — saves the email's attachment(s) into Drive; " +
      "send_draft {draftId} — sends a draft you saved earlier, only after the owner approved it ('send 1 and 3'). " +
      "Triage ('stay on my inbox'): archive the noise, draft a reply for each one that needs the owner (compose without send), post them numbered with each draftId, ask 'send 1, 2, 3?'. " +
      "Example — 'unsubscribe me from advertising and delete it': action unsubscribe, query 'category:promotions', trash true; repeat while more is true.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string", description: "The mailbox email, e.g. yuli@flatfeelandlord.com." },
        action: { type: "string", enum: ["search", "read", "modify", "unsubscribe", "compose", "save_attachment", "send_draft"] },
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
        filename: { type: "string", description: "save_attachment: which attachment (default all)." },
        folderId: { type: "string", description: "save_attachment: Drive folder to save into." },
        draftId: { type: "string", description: "send_draft: the draft to send (from compose)." },
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
      "free_busy {from?, to?}; " +
      "find_time {mailboxes?: [other connected accounts that must also be free], durationMinutes (default 30), from?, to? (default next 7 days), dayStart?/dayEnd? (Houston hours, default 9–17), includeWeekends?} → common free slots; offer two or three, then create with attendees + notifyAttendees true. " +
      "Reads cover every calendar the person has turned on; a bare date as 'to' means that whole day. Guests are only emailed when notifyAttendees is true.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        action: { type: "string", enum: ["list", "create", "update", "delete", "respond", "free_busy", "find_time"] },
        mailboxes: { type: "array", items: { type: "string" }, description: "find_time: the other connected accounts whose calendars must be free." },
        durationMinutes: { type: "integer", minimum: 15, maximum: 480 },
        dayStart: { type: "number" },
        dayEnd: { type: "number" },
        includeWeekends: { type: "boolean" },
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
  {
    name: "assistant_drive",
    description:
      "Work in a connected account's Google Drive — Docs, Sheets, Slides and files." +
      OWNER_RULE +
      " Actions: search {query (plain words, or Drive syntax like \"name contains 'Lease'\"), type?: doc|sheet|slides|folder, folderId?, max?} → files with id, name, type, link; " +
      "read {fileId, range? (sheets, e.g. 'Rent Roll!A1:H200')} → a Doc/Slides as text, a Sheet as rows (first tab unless range), a text file as text; " +
      "create {type: doc|sheet|folder, name, folderId?, text? (doc), rows? (sheet: list of rows)}; " +
      "append_doc {fileId, text} → adds to the end of a Doc; " +
      "write_sheet {fileId, range, rows, mode?: overwrite|append}; " +
      "move {fileId, name? (rename), folderId? (move)}; " +
      "share {fileId, emails[], role?: reader|commenter|writer, notify?, message?, allowExternal?} — company domains only unless the owner explicitly asked to share outside (allowExternal: true); " +
      "trash {fileId} — Drive's Trash, recoverable 30 days.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        action: { type: "string", enum: ["search", "read", "create", "append_doc", "write_sheet", "move", "share", "trash"] },
        query: { type: "string" },
        type: { type: "string", enum: ["doc", "sheet", "slides", "folder"] },
        folderId: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 100 },
        fileId: { type: "string" },
        range: { type: "string" },
        name: { type: "string" },
        text: { type: "string" },
        rows: { type: "array", items: { type: "array", items: {} } },
        mode: { type: "string", enum: ["overwrite", "append"] },
        emails: { type: "array", items: { type: "string" } },
        role: { type: "string", enum: ["reader", "commenter", "writer"] },
        notify: { type: "boolean" },
        message: { type: "string" },
        allowExternal: { type: "boolean", description: "Only when the owner explicitly asked to share outside the company." },
      },
      required: ["mailbox", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "assistant_contacts",
    description:
      "A connected account's Google Contacts." +
      OWNER_RULE +
      " Actions: search {query (name, email or phone), max?} → people from their contacts, the company directory and people they've emailed; " +
      "create {name, email?, phone?, company?, title?, notes?}; update {contactId (people/… from a search, own contacts only), + fields to change}. No deletes.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        action: { type: "string", enum: ["search", "create", "update"] },
        query: { type: "string" },
        max: { type: "integer", minimum: 1, maximum: 30 },
        contactId: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
      },
      required: ["mailbox", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "assistant_tasks",
    description:
      "A connected account's Google Tasks (their to-do list)." +
      OWNER_RULE +
      " Actions: list {list?, includeDone?}; add {title, notes?, due? (YYYY-MM-DD — Google Tasks has dates, not times), list?}; " +
      "update {taskId, title?, notes?, due?, done? (true = complete), list?}; delete {taskId, list?} — prefer done: true unless told to delete.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox: { type: "string" },
        action: { type: "string", enum: ["list", "add", "update", "delete"] },
        list: { type: "string", description: "Task list name; default is the first list." },
        includeDone: { type: "boolean" },
        max: { type: "integer", minimum: 1, maximum: 100 },
        taskId: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        due: { type: "string" },
        done: { type: "boolean" },
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
  const TOOL: Record<AssistantToolName, string> = {
    assistant_mailboxes: "mailboxes",
    assistant_mail: "mail",
    assistant_calendar: "calendar",
    assistant_drive: "drive",
    assistant_contacts: "contacts",
    assistant_tasks: "tasks",
  };
  const body = name === "assistant_mailboxes" ? { tool: "mailboxes" } : { ...args, tool: TOOL[name] };
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
