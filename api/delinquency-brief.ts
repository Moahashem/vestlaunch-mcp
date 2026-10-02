/**
 * Delinquency morning brief — the FFL Delinquency Agent, Phase 1 (read-only).
 *
 * company-hq: projects/tech/ffl-2026-delinquency-agent. Phase 1 is a SUMMARY, not a
 * judgement call, so there is deliberately no model in the loop: the cron reads the
 * smart tool (ffl-crm /api/v1/analytics/ffl-delinquency-worklist), formats the brief
 * from the numbers, and posts it to Ruckus's RingCentral channel. Every figure in the
 * post is arithmetic over the tool's rows — nothing is narrated. The Managed Agent
 * arrives in Phase 2, when there is drafting and task-routing to do.
 *
 * This module is pure apart from fetchWorklist(); formatBrief() is unit-tested.
 */

export interface WorklistRow {
  unit_id: string;
  portfolio: "appfolio" | "resman";
  property: string;
  unit: string | null;
  state: string | null;
  jurisdiction: string;
  balance: number;
  current_period_balance: number;
  prior_balance: number;
  days_past_due: number;
  stage: string;
  late_day: number;
  steps_due_today: { type: string; template_id: string; owner: "agent" | "human" }[];
  notice: { preconditions_met: boolean; blocked_reason: string | null; required_type: string } | null;
  flags: string[];
}

export interface WorklistPayload {
  as_of: string;
  summary: {
    total_delinquent_units: number;
    total_balance: number;
    by_state: Record<string, { units: number; balance: number }>;
    by_stage: Record<string, number>;
    agent_steps_today: number;
    human_steps_today: number;
    needs_human: number;
    blocked_notices: number;
    cares_unknown: number;
  };
  rows: WorklistRow[];
  sources: { appfolio: string; resman: string };
  rules_version?: { attorney_reviewed?: boolean };
}

const LATE_STAGES = new Set(["late_rent", "notice_pending", "notice_served", "eviction_ready", "frozen"]);

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "notice_pending": return "notice pending";
    case "notice_served": return "notice served, clock running";
    case "eviction_ready": return "clock elapsed — decision";
    case "late_rent": return "late";
    case "frozen": return "FROZEN — paid after notice";
    case "needs_human": return "needs a person";
    case "carried_balance": return "old balance only";
    default: return stage;
  }
}

function dateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(dt);
}

/** Build the RingCentral post. Pure. */
export function formatBrief(p: WorklistPayload, opts: { top?: number } = {}): string {
  const top = opts.top ?? 8;
  const rows = p.rows ?? [];
  const late = rows.filter((r) => LATE_STAGES.has(r.stage));
  const grace = rows.filter((r) => r.stage === "grace");
  const eviction = rows.filter((r) => r.stage === "needs_human" && r.flags.some((f) => /eviction/i.test(f)));
  const otherHuman = rows.filter((r) => r.stage === "needs_human").length - eviction.length;
  const carried = rows.filter((r) => r.stage === "carried_balance");
  const sum = (xs: WorklistRow[]) => xs.reduce((s, r) => s + r.balance, 0);

  const byState = new Map<string, { n: number; bal: number }>();
  for (const r of late) {
    const k = r.state ?? "??";
    const e = byState.get(k) ?? { n: 0, bal: 0 };
    e.n += 1; e.bal += r.balance; byState.set(k, e);
  }
  const stateLine = Array.from(byState.entries()).sort((a, b) => b[1].bal - a[1].bal).map(([s, v]) => `${s} ${v.n} (${money(v.bal)})`).join(" · ");

  const humanSteps = late.flatMap((r) => r.steps_due_today.filter((a) => a.owner === "human"));
  const count = (t: string) => humanSteps.filter((a) => a.type === t).length;
  const blocked = late.filter((r) => r.notice && !r.notice.preconditions_met);
  const frozen = late.filter((r) => r.stage === "frozen");
  const carryovers = late.filter((r) => r.prior_balance > 0);

  const lines: string[] = [];
  lines.push(`🧾 Delinquency brief — ${dateLabel(p.as_of)} (Phase 1, read-only)`);
  lines.push(`Past grace: ${late.length} units · ${money(sum(late))}   |   In grace: ${grace.length} · ${money(sum(grace))}   |   Under eviction: ${eviction.length}${otherHuman > 0 ? ` · other needs-a-person: ${otherHuman}` : ""}${carried.length ? ` · old-balance-only: ${carried.length}` : ""}`);
  if (late.length) lines.push(`Past grace by state: ${stateLine}`);
  lines.push(`Zulema today: ${count("notice")} notice(s) to prepare · ${count("call")} tenant call(s) · ${count("owner_call")} owner call(s) · ${count("decision")} decision(s)`);
  if (carryovers.length) lines.push(`Still owe from a prior month: ${carryovers.length} units · ${money(carryovers.reduce((s, r) => s + r.prior_balance, 0))} carried`);
  if (blocked.length) lines.push(`Blocked: ${blocked.map((r) => `${shortProp(r)} — ${r.notice?.blocked_reason ?? "blocked"}`).join("; ")}`);
  if (frozen.length) lines.push(`⚠️ FROZEN (payment after notice — Zulema must clear): ${frozen.map(shortProp).join(", ")}`);

  if (late.length) {
    lines.push(`Largest past-grace balances:`);
    for (const r of [...late].sort((a, b) => b.balance - a.balance).slice(0, top)) {
      const juris = r.jurisdiction && r.jurisdiction !== r.state ? r.jurisdiction.replace(/^.. — /, "") : (r.state ?? "");
      lines.push(` • ${shortProp(r)} (${juris}) — ${money(r.balance)}, ~${r.days_past_due}d past due, ${stageLabel(r.stage)}${r.prior_balance > 0 ? `, ${money(r.prior_balance)} from prior month(s)` : ""}`);
    }
    if (late.length > top) lines.push(` …and ${late.length - top} more. Full list: get_delinquency_worklist.`);
  } else {
    lines.push(`Nobody is past grace today.`);
  }

  const src = `Sources: AppFolio ${p.sources.appfolio.startsWith("ok") ? "ok" : "FAILED"} · ResMan ${p.sources.resman.startsWith("ok") ? "ok" : "FAILED"}`;
  const legal = p.rules_version?.attorney_reviewed ? "" : " · state rules DRAFT (not attorney-reviewed)";
  lines.push(`${src}${legal}. Nothing was sent to any tenant.`);
  return lines.join("\n");
}

function shortProp(r: WorklistRow): string {
  const base = r.portfolio === "resman" ? `Cranbrook #${r.unit ?? "?"}` : r.property.replace(/^[+zR(PM) ]+/, "").split(",")[0]?.trim() || r.property;
  return base;
}

/** One-line failure post so a silent morning is impossible. */
export function formatFailure(dateYmd: string, reason: string): string {
  return `🧾 Delinquency brief — ${dateLabel(dateYmd)}: could not run (${reason}). No numbers today; check /api/cron/daily-delinquency.`;
}

/** Fetch the worklist from ffl-crm. Throws on any failure. */
export async function fetchWorklist(baseUrl: string, apiKey: string, date?: string): Promise<WorklistPayload> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/analytics/ffl-delinquency-worklist${date ? `?date=${encodeURIComponent(date)}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`worklist HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { success?: boolean; data?: WorklistPayload } & Partial<WorklistPayload>;
  const data = (parsed.data ?? parsed) as WorklistPayload;
  if (!data || !data.summary || !Array.isArray(data.rows)) throw new Error("worklist: unexpected shape (no summary/rows)");
  return data;
}
