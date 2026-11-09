/**
 * One daily company receipt for the recruiting sweep.
 * The body is only the accepted receipt allowlist. No applicant, report, or summary text.
 * Unconfigured env does not call the network.
 */

export interface DailyReceiptResult {
  posted: boolean;
  status?: number;
  skipped?: "unconfigured" | "failed";
}

export async function postDailyRecruitingReceipt(input: {
  status: string;
  needsHuman?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<DailyReceiptResult> {
  const base = (process.env.FFL_CRM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const key = (process.env.FFL_RECRUITING_RECEIPT_KEY ?? "").trim();
  if (!base || !key) return { posted: false, skipped: "unconfigured" };
  const now = input.now ?? new Date();
  const status = ["ok", "failed", "partial"].includes(input.status) ? input.status : "ok";
  const receiptDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const body = {
    receipt_date: receiptDate,
    producer_claim: "done" as const,
    claimed_at: now.toISOString(),
    exception_present: status !== "ok" || input.needsHuman === true,
  };
  const response = await (input.fetchImpl ?? fetch)(
    `${base}/api/v1/analytics/company-assurance/recruiting-receipt`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { posted: response.ok, status: response.status };
}
