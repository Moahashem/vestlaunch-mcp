# Recruiting Sweep (cloud half) — Managed Agent setup

The email half of the recruiting invite sweep, moved off Mo's Mac onto Anthropic Managed Agents. Modeled on the FFL Sales Daily Lead Counter (D12/D13). The browser half (LinkedIn + Indeed) stays on the Mac; the two halves coordinate through Workforce Hub state (`agentKey: recruiting-sweep`), and this cloud half watchdogs the browser half.

**Code:** `api/recruiting-mcp.ts` (8 smart tools, Bearer-gated) + `api/recruiting-tools.ts` (logic) + `api/cron/recruiting-sweep.ts` (daily trigger, 11:50 UTC = 6:50 AM CDT + 12:10 UTC retry).

## Vercel env vars (Mo places all of these — vestlaunch-mcp project)

| Var | What | Status |
|---|---|---|
| `RECRUITING_MCP_TOKEN` | New random string ≥32 chars. Gates `/api/recruiting-mcp`; the SAME value goes in the vault credential. Endpoint fails closed until set. | NEW |
| `GOOGLE_SA_KEY_JSON` | Full JSON key of the Google service account (setup below). Direct Gmail API as mo@flatfeelandlord.com. | NEW |
| `GMAIL_IMPERSONATE` | Optional; defaults to `mo@flatfeelandlord.com`. | optional |
| `ZAPIER_RECRUITING_MCP_URL` | URL of the **dedicated** recruiting Zapier MCP server (setup below). VideoAsk only. | NEW |
| `ZAPIER_RECRUITING_MCP_TOKEN` | Only if that server uses a separate Bearer (most Zapier MCP URLs are self-authing). | optional |
| `VIDEOASK_ORG_ID` | Defaults to the FFL org `94dc21de-…853e3`. | optional |
| `RECRUITING_SEND_CAP` | Max invites/day, default 15. | optional |
| `RECRUITING_AGENT_ID` | The Managed Agent's `agent_…` id, once created in the Console. | NEW |
| `RECRUITING_DAILY_PROMPT` | Optional kickoff-prompt override. | optional |
| `ANTHROPIC_API_KEY`, `FFL_ENVIRONMENT_ID`, `FFL_VAULT_ID`, `CRON_SECRET`, `FFL_WORKFORCE_API_KEY`, `VESTLAUNCH_BASE_URL` | Already set (shared with the other crons). `FFL_WORKFORCE_API_KEY` must carry `agent:read` + `agent:write` (state + run-status). | existing |

## One-time setup A — Google service account (direct Gmail API)

Why: Managed Agents can't hold secrets (D8) and Zapier's Gmail app has no raw-API action and can't enumerate a search window — so the Vercel functions call the Gmail API directly, authenticating as a service account that's allowed to act as mo@flatfeelandlord.com.

1. console.cloud.google.com (logged in as mo@flatfeelandlord.com) → create/select a project → **APIs & Services → Enable APIs** → enable **Gmail API**.
2. **IAM & Admin → Service Accounts → Create** (name e.g. `recruiting-sweep`). No roles needed.
3. Open the account → **Keys → Add key → JSON**. The downloaded file's entire contents = `GOOGLE_SA_KEY_JSON`.
4. Copy the account's **Unique ID (Client ID)** → admin.google.com → **Security → Access and data control → API controls → Domain-wide delegation → Add new**: that Client ID with scopes
   `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send`
   (exactly these two — read + send, nothing else).

## One-time setup B — dedicated Zapier MCP server (VideoAsk only)

Why: VideoAsk's direct API is OAuth-only with 24h tokens; Zapier already holds and refreshes that OAuth (connection verified 2026-08-17). This is a NEW server — Gmail stays OFF the shared agent Zapier server (D11) and off this one too.

1. mcp.zapier.com → create a new MCP server, e.g. **ffl-recruiting**.
2. Add ONE action: VideoAsk → **API Request (GET)** (the raw-request action; tool name should come out as `videoask_make_api_get_request` — if Zapier names it differently, set `ZAPIER_VIDEOASK_GET_TOOL`), bound to the mo@flatfeelandlord.com VideoAsk connection (`02808c45-…`).
3. Copy the server URL → `ZAPIER_RECRUITING_MCP_URL`.

## Vault + agent (Console)

1. Vault `ffl-mcp`: add a Bearer credential for URL `https://<vestlaunch-mcp deployment>/api/recruiting-mcp` with token = `RECRUITING_MCP_TOKEN`.
2. Create the agent (env `ffl-agents`, thin — all logic lives in the tools), MCP server = the URL above, toolset `always_allow` (safe because the server is this curated). Suggested system prompt: see below.
3. Put its `agent_…` id in Vercel as `RECRUITING_AGENT_ID`.

### Suggested agent system prompt (v1)

> You are the FFL Recruiting Sweep agent — the CLOUD half of the recruiting invite sweep. Your job, every morning: find new applicants for the 5 invite roles (Regional Manager, Community/Apartment Manager, Assistant Community Manager, Leasing Agent, BD/Sales Manager) in the email channels, and send each qualified NEW applicant the VideoAsk invite via `send_recruiting_invite`.
>
> Procedure: (1) `get_recruiting_state` → read `last_run_cloud`, `last_run_browser`, `carry_forward`. Window = since `last_run_cloud`, minimum 2 days. (2) `get_new_applicants` for website, wix, wizehire, true_analysis. hazelequity always returns unswept — report it as UNSWEPT, never as "no applicants". (3) Relevance (Mo's rule): property management / leasing / community-management experience; Leasing Agent is lenient (customer service / sales / front desk / hospitality transferable); BD/Sales bar = sales/BD/real estate; Wizehire self-selection counts as the proxy. Never invite Maintenance, VLS-remote, Executive Assistant, or other out-of-scope roles. Wix hits are often property-owner sales leads, not applicants — judge each. (4) Send via `send_recruiting_invite` only. Dedup, the do-not-contact list, and the daily cap run INSIDE the tool — if it refuses, accept the refusal, never retry with altered spellings, and report why. (5) Watchdog: if `last_run_browser` > 3 days old, `send_watchdog_alert`. (6) `update_recruiting_state` (`last_run_cloud` = now, `carry_forward`), then `report_recruiting_run` with a one-line summary: sent / skipped / refused / unswept channels.
>
> Hard rules: you have exactly the 8 tools you see — never attempt other email, other links, or other templates. An empty channel result is only trustworthy because the tool verifies the mailbox; if a tool errors, report the channel as UNSWEPT. Candidates who say the link is broken get ignored (Mo's ruling). This kickoff may be a retry — the send tool's per-day log makes duplicates impossible; just continue.

## Verify before calling it done (the 4-day trap)

1. Deploy → `curl https://<deployment>/health` → both `/api/recruiting-mcp` and `/api/cron/recruiting-sweep` must be listed.
2. `tools/list` against `/api/recruiting-mcp` with the Bearer → 8 tools.
3. Live tool spot-checks (supervised): `get_new_applicants(website, 7d ago)` → `mailbox_verified: mo@flatfeelandlord.com`; `search_videoask_contacts("Kostelecky")` → ≥1 hit (known contact); `get_videoask_completers` since yesterday → small clean list. **Verify the VideoAsk contacts endpoint path on this first call** — it's the one piece built from docs, not verified live; override `VIDEOASK_CONTACTS_PATH` if needed.
4. First send supervised: pick one real pending invite, watch `send_recruiting_invite` run its dedup and send; confirm in Gmail Sent (from mo@flatfeelandlord.com).
5. Fire `/api/cron/recruiting-sweep` manually with the CRON_SECRET; watch the session in the Console.
6. Register the agent in company-hq `operations/ai-operating-system/AI-RUN-REGISTRY.md`.

## Migration + cleanup (after first good run)

- Seed state once: `last_run_cloud`, `last_run_browser`, `carry_forward`, `testgorilla_boundary` (= `2026-07-19T18:58` Alfredo Enciso) from the Drive `RECRUITING-STATE.md`, then retire the Drive file (SOP pointer update).
- Edit the browser half's local task prompt to read/write the same Workforce state (its local vestlaunch MCP already has `vestlaunch_get/set_agent_state`) instead of the Drive file — otherwise the >3-day watchdog reads a stale date.
- Remove `recruiting-sweep-cloud` from the Mac's local scheduler once the cron has produced 2–3 good unattended runs.

## Never

- Never add Gmail to any shared Zapier MCP server (D11).
- Never run `testgorilla-virtualpm-batch` as a test — it sends ~40 real emails.
- Never treat an empty inbox result as "nothing new" without `mailbox_verified`.
