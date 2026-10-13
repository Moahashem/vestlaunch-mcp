/** Ruckus's email + calendar tools (Mo, 2026-10-13). */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ASSISTANT_TOOLS, isAssistantTool, runAssistantTool } from "../../api/_ruckus-assistant";

describe("ruckus assistant tools", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("exposes the six tools, each requiring a mailbox except the list", () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual(["assistant_mailboxes", "assistant_mail", "assistant_calendar", "assistant_drive", "assistant_contacts", "assistant_tasks"]);
    expect(isAssistantTool("assistant_mail")).toBe(true);
    expect(isAssistantTool("cranbrook_get_contact")).toBe(false);
    for (const t of ASSISTANT_TOOLS.slice(1)) expect((t.inputSchema as { required?: string[] }).required).toEqual(["mailbox", "action"]);
  });
  it("tells the agent to act only when the owner asks, and that trash is recoverable", () => {
    const mail = ASSISTANT_TOOLS.find((t) => t.name === "assistant_mail")!;
    expect(mail.description).toMatch(/ONLY when its owner/);
    expect(mail.description).toMatch(/recoverable for 30 days/);
    expect(mail.description).toMatch(/DRAFT unless send: true/);
  });
  it("relays to the CRM with the forwarded bearer and the right tool", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await runAssistantTool("assistant_mail", { mailbox: "yuli@flatfeelandlord.com", action: "search" }, "tok");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/ringcentral\/ruckus-assistant$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toMatchObject({ tool: "mail", mailbox: "yuli@flatfeelandlord.com", action: "search" });
  });

  it("routes drive / contacts / tasks to the right CRM tool", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const [n, t] of [["assistant_drive", "drive"], ["assistant_contacts", "contacts"], ["assistant_tasks", "tasks"]] as const) {
      await runAssistantTool(n, { mailbox: "mo@flatfeelandlord.com", action: "search" }, "tok");
      const init = (fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1];
      expect(JSON.parse(init.body as string).tool).toBe(t);
    }
  });
  it("drive sharing outside the company is opt-in", () => {
    const drive = ASSISTANT_TOOLS.find((t) => t.name === "assistant_drive")!;
    expect(drive.description).toMatch(/company domains only unless the owner explicitly asked/);
  });
});
