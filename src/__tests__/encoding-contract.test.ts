/**
 * THE ENCODING CONTRACT (s31, s31b) — the bug that cost the most.
 *
 * `update_event_type` returned 400 "Invalid JSON" on every call for weeks, and
 * it was never the payload: the client set `Content-Type: application/json` on
 * every request while sending no body when the caller had none, so the CRM's
 * `await req.json()` threw before reading a single field. One shared client
 * across ~130 manifest-driven tools meant EVERY write tool was affected.
 *
 * These tests exist because that fix was previously held in place by nothing
 * but a comment. They assert the observable contract at the fetch boundary —
 * what actually goes over the wire — not the implementation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ApiClient } from "../api-client.js";
import type { Config } from "../config.js";

const config: Config = {
  baseUrl: "https://crm.example.invalid",
  apiKey: "ffl_live_test",
  timeoutMs: 5000,
  enableWrites: true,
  logLevel: "silent",
} as Config;

let fetchMock: ReturnType<typeof vi.fn>;
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: (init.headers ?? {}) as Record<string, string> };
};

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("a write always carries a JSON body", () => {
  it("PATCH with no body sends {} — never a bodiless request", async () => {
    await new ApiClient(config).request({ method: "PATCH", path: "/api/v1/event-types/abc" });
    const { init, headers } = lastCall();
    // The whole bug in one assertion: this used to be undefined.
    expect(init.body).toBe("{}");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("POST with no body sends {}", async () => {
    await new ApiClient(config).request({ method: "POST", path: "/api/v1/contacts" });
    expect(lastCall().init.body).toBe("{}");
  });

  it("DELETE with no body sends {}", async () => {
    await new ApiClient(config).request({ method: "DELETE", path: "/api/v1/tags/abc" });
    expect(lastCall().init.body).toBe("{}");
  });

  it("a real body is passed through untouched", async () => {
    await new ApiClient(config).request({ method: "PATCH", path: "/p", body: { duration: 20 } });
    expect(lastCall().init.body).toBe(JSON.stringify({ duration: 20 }));
  });
});

describe("the body and its Content-Type travel together", () => {
  it("GET sends no body AND no Content-Type — the header never lies", async () => {
    await new ApiClient(config).request({ method: "GET", path: "/api/v1/contacts" });
    const { init, headers } = lastCall();
    expect(init.body).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("every request is authenticated", async () => {
    await new ApiClient(config).request({ method: "GET", path: "/x" });
    expect(lastCall().headers.Authorization).toBe("Bearer ffl_live_test");
  });
});

describe("query strings", () => {
  it("GET query params reach the URL; empty values are dropped", async () => {
    await new ApiClient(config).request({
      method: "GET",
      path: "/api/v1/contacts",
      query: { search: "smith", limit: 2, skip: undefined, blank: "" },
    });
    const url = new URL(lastCall().url);
    expect(url.searchParams.get("search")).toBe("smith");
    expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.has("skip")).toBe(false);
    expect(url.searchParams.has("blank")).toBe(false);
  });
});

describe("failures are reported honestly", () => {
  it("a 400 surfaces the CRM's own message, not a generic one", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "No updatable fields provided" }), { status: 400 })
    );
    const res = await new ApiClient(config).request({ method: "PATCH", path: "/p", body: {} });
    expect(res).toMatchObject({ success: false, statusCode: 400, error: "No updatable fields provided" });
  });

  it("a non-JSON error body does not crash the client", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>502</html>", { status: 502 }));
    const res = await new ApiClient(config).request({ method: "GET", path: "/p" });
    expect(res.success).toBe(false);
  });

  it("the {data, meta} envelope is flattened for callers", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [1, 2], meta: { total: 2, limit: 50 } }), { status: 200 })
    );
    const res = await new ApiClient(config).request({ method: "GET", path: "/p" });
    expect(res).toMatchObject({ success: true, data: [1, 2], total: 2, limit: 50 });
  });
});
