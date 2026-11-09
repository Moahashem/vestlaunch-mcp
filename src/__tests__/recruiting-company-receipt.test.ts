import { afterEach, expect, it } from "vitest";
import { postDailyRecruitingReceipt } from "../../api/recruiting-company-receipt";

const ENV = ["FFL_CRM_BASE_URL", "FFL_RECRUITING_RECEIPT_KEY"] as const;

afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

it("does not call the network when the receipt env is unset", async () => {
  let called = false;
  const result = await postDailyRecruitingReceipt({
    status: "ok",
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 201 });
    },
  });
  expect(result).toEqual({ posted: false, skipped: "unconfigured" });
  expect(called).toBe(false);
});

it("posts one allowlisted daily receipt and marks an exception without sending the report", async () => {
  process.env.FFL_CRM_BASE_URL = "http://127.0.0.1:9";
  process.env.FFL_RECRUITING_RECEIPT_KEY = "syn-local-recruiting-receipt-not-a-credential";
  const seen: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  const result = await postDailyRecruitingReceipt({
    status: "partial",
    needsHuman: true,
    now: new Date("2026-11-09T18:00:00.000Z"),
    fetchImpl: async (url, init) => {
      seen.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("{}", { status: 201 });
    },
  });
  expect(result).toEqual({ posted: true, status: 201 });
  expect(seen).toHaveLength(1);
  expect(seen[0].url).toBe("http://127.0.0.1:9/api/v1/analytics/company-assurance/recruiting-receipt");
  expect(seen[0].authorization).toBe("Bearer syn-local-recruiting-receipt-not-a-credential");
  expect(seen[0].body).toEqual({
    receipt_date: "2026-11-09",
    producer_claim: "done",
    claimed_at: "2026-11-09T18:00:00.000Z",
    exception_present: true,
  });
  expect(JSON.stringify(seen[0].body)).not.toMatch(/summary|report|applicant|email/i);
});
