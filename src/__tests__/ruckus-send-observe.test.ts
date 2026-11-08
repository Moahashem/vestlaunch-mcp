/**
 * Observation only. The post, the retry, and the response stay as they are.
 * The log line is class and status, never the bearer or the message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyRuckusSendBearer,
  ruckusSend,
  ruckusSendObservationLine,
} from "../../api/ruckus-mcp.js";

const PRESENTED = "ffl_live_OBSERVEPRESENTEDVALUE";
const CONFIGURED = "vault-OBSERVE-CONFIGUREDVALUE";
const CHAT = "138920845318";

function captureLogs() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

afterEach(() => {
  delete process.env.RUCKUS_SEND_TOKEN;
  delete process.env.VESTLAUNCH_BASE_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ruckus send observation line", () => {
  it("classifies match, other, and missing without echoing the bearer", () => {
    expect(classifyRuckusSendBearer(CONFIGURED, CONFIGURED)).toBe("configured_match");
    expect(classifyRuckusSendBearer(`  ${CONFIGURED}  `, CONFIGURED)).toBe("configured_match");
    expect(classifyRuckusSendBearer(PRESENTED, CONFIGURED)).toBe("other");
    expect(classifyRuckusSendBearer("", CONFIGURED)).toBe("missing");
    expect(classifyRuckusSendBearer("   ", undefined)).toBe("missing");
  });

  it("drops anything that is not a class, uuid, status, or boolean", () => {
    const line = ruckusSendObservationLine({
      authClass: PRESENTED,
      correlation: PRESENTED,
      firstStatus: Number.NaN,
      fallbackUsed: false,
      finalStatus: 200.5,
    });
    expect(line).toBe("ruckus_send_obs class=other correlation=none first_status=none fallback_used=false final_status=none\n");
    expect(line).not.toContain(PRESENTED);
    expect(line).not.toContain("ffl_live");
    expect(line).not.toContain("Bearer");
  });
});

describe("ruckus_send observation does not change the post", () => {
  it("logs one exact-match line and returns the upstream body", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const lines = captureLogs();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, posted: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await ruckusSend({ text: "hello landlord", chatId: CHAT, business: "cranbrook" }, CONFIGURED);
    expect(result).toEqual({ ok: true, posted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ruckus_send_obs class=configured_match correlation=[0-9a-f-]{36} first_status=200 fallback_used=false final_status=200\n$/);
    expect(lines[0]).not.toContain(CONFIGURED);
    expect(lines[0]).not.toContain(CHAT);
    expect(lines[0]).not.toContain("cranbrook");
    expect(lines[0]).not.toContain("landlord");
  });

  it("logs a refused bearer that the existing retry then accepts", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    process.env.VESTLAUNCH_BASE_URL = "https://crm.example.invalid";
    const lines = captureLogs();
    const bearers: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bearers.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
      const status = bearers.length === 1 ? 401 : 200;
      return new Response(JSON.stringify({ ok: status === 200 }), { status });
    }));
    const result = await ruckusSend({ text: "hello", chatId: CHAT, business: "ffl" }, PRESENTED);
    expect(result).toEqual({ ok: true });
    expect(bearers).toEqual([`Bearer ${PRESENTED}`, `Bearer ${CONFIGURED}`]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/class=other /);
    expect(lines[0]).toMatch(/first_status=401 fallback_used=true final_status=200/);
    expect(lines[0]).not.toContain(PRESENTED);
    expect(lines[0]).not.toContain(CONFIGURED);
    expect(lines[0]).not.toContain("ffl_live");
  });

  it("logs a retry that is also refused and keeps the final status on the response", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    const lines = captureLogs();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 403 })));
    const result = await ruckusSend({ text: "hello" }, PRESENTED);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(lines[0]).toMatch(/first_status=403 fallback_used=true final_status=403/);
    expect(lines[0]).not.toContain(PRESENTED);
  });

  it("logs missing when the caller presents nothing and the configured token is sent as before", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    const lines = captureLogs();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(((init?.headers ?? {}) as Record<string, string>).Authorization).toBe(`Bearer ${CONFIGURED}`);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await ruckusSend({ text: "hello" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lines[0]).toMatch(/class=missing /);
    expect(lines[0]).toMatch(/fallback_used=false final_status=200/);
    expect(lines[0]).not.toContain(CONFIGURED);
  });

  it("still returns the upstream error when the logger throws", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error(`log failed ${CONFIGURED}`);
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(ruckusSend({ text: "hello" }, CONFIGURED)).resolves.toEqual({ ok: true });
  });

  it("logs once when the upstream connection fails and does not include the bearer", async () => {
    process.env.RUCKUS_SEND_TOKEN = CONFIGURED;
    const lines = captureLogs();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`network down ${PRESENTED}`);
    }));
    const result = await ruckusSend({ text: "hello" }, PRESENTED);
    expect(result).toEqual({ ok: false, error: `network down ${PRESENTED}` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/class=other correlation=[0-9a-f-]{36} first_status=none fallback_used=false final_status=none/);
    expect(lines[0]).not.toContain(PRESENTED);
  });

  it("does not log when the text is empty", async () => {
    const lines = captureLogs();
    await expect(ruckusSend({ text: "  " }, PRESENTED)).rejects.toThrow("non-empty");
    expect(lines).toHaveLength(0);
  });

  it("logs missing and throws the same configuration error when no token exists", async () => {
    const lines = captureLogs();
    await expect(ruckusSend({ text: "hello" }, "   ")).rejects.toThrow("not configured");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/class=missing /);
    expect(lines[0]).toMatch(/first_status=none fallback_used=false final_status=none/);
  });
});
