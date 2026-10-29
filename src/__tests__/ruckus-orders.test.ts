/** Ruckus's standing orders + memory tools (Mo, 2026-10-13). */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ORDER_TOOLS, isOrderTool, runOrderTool } from "../../api/_ruckus-orders";

describe("ruckus order tools", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("exposes the tools, action required", () => {
    expect(ORDER_TOOLS.map((t) => t.name)).toEqual(["ruckus_schedule", "ruckus_memory", "ruckus_action", "ruckus_resman", "ruckus_jordan", "ruckus_booking"]);
    expect(isOrderTool("ruckus_schedule")).toBe(true);
    expect(isOrderTool("assistant_mail")).toBe(false);
    for (const t of ORDER_TOOLS) expect((t.inputSchema as { required?: string[] }).required).toEqual(["action"]);
  });
  it("tells the agent to set orders itself and to report at the end of a run", () => {
    const s = ORDER_TOOLS[0].description;
    expect(s).toMatch(/never say a developer must build it/);
    expect(s).toMatch(/call this at the END of every scheduled run/);
    expect(s).toMatch(/must not send email, delete, or message a renter/);
    expect(ORDER_TOOLS[1].description).toMatch(/never store email contents, passwords, card numbers/);
  });
  it("relays to the CRM schedule endpoint with the forwarded bearer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, orders: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await runOrderTool("ruckus_schedule", { action: "list" }, "tok");
    expect(r).toEqual({ ok: true, orders: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/ringcentral\/ruckus-schedule$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ action: "list" });
  });
  it("refuses an action the tool does not own", async () => {
    await expect(runOrderTool("ruckus_memory", { action: "create" }, "tok")).rejects.toThrow(/action must be one of remember, forget, memories, questionnaire, profile_set, profile_get/);
    await expect(runOrderTool("ruckus_schedule", { action: "remember" }, "tok")).rejects.toThrow(/action must be one of/);
  });
});

describe("ruckus tools v2 (10/13 build it all)", () => {
  it("schedule tool knows watches and commitments", () => {
    const s = ORDER_TOOLS[0];
    expect((s.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum).toContain("commitment");
    expect((s.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind.enum).toContain("watch");
    expect(s.description).toMatch(/ONE order with two times/);
    expect(s.description).toMatch(/wakes you only on a NEW hit/);
    expect(ORDER_TOOLS[1].description).toMatch(/until\?/);
  });
});


describe("approved actions + ResMan reads (Mo 2026-10-14)", () => {
  it("ruckus_action says it runs only after approval", () => {
    const t = ORDER_TOOLS.find((x) => x.name === "ruckus_action")!;
    expect(t.description).toMatch(/approve A12/);
    expect(t.description).toMatch(/never say it's done before the result posts/);
  });
  it("ruckus_resman is read only", () => {
    expect(ORDER_TOOLS.find((x) => x.name === "ruckus_resman")!.description).toMatch(/read only, no approval needed/);
  });
});

describe("Ruckus ↔ Jordan (Mo 2026-10-14)", () => {
  it("ruckus_jordan asks, tells and logs, and keeps Jordan's sending rules", () => {
    const t = ORDER_TOOLS.find((x) => x.name === "ruckus_jordan")!;
    expect((t.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum).toEqual(["ask", "tell", "log"]);
    expect(t.description).toMatch(/consent, quiet hours, STOP and wait rules still apply/);
  });
});

describe("booking hours (Mo 2026-10-29)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("relays every action to the CRM booking endpoint with the forwarded bearer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, ran: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const args = { action: "block_dates", person: "Sam", date: "2026-10-30", requestedBy: "Sam Hashem", chatId: "123", quote: "block off friday" };
    expect(await runOrderTool("ruckus_booking", args, "tok")).toEqual({ ok: true, ran: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/ringcentral\/ruckus-booking$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual(args);
  });
  it("tells the agent code decides who may, and never to move bookings", () => {
    const d = ORDER_TOOLS.find((x) => x.name === "ruckus_booking")!.description;
    expect(d).toMatch(/Code decides/);
    expect(d).toMatch(/never move or cancel one/);
    expect(d).toMatch(/never send anyone to Settings/);
  });
});
