# vestlaunch-mcp

> Model Context Protocol server for the **VestLaunch CRM** (Flat Fee Landlord). Manifest-driven and multi-agent — any number of Claude sessions, Claude Code instances, or other MCP-compatible agents can connect with their own per-agent API key.

The CRM (`moahashem/ffl-crm`) already exposes a 58-endpoint REST surface at `/api/v1/*` plus a machine-readable tool manifest at `/api/v1/me`. This MCP server is a thin wrapper that:

- Fetches the manifest at startup
- Registers each capability as an MCP tool (prefixed `vestlaunch_`)
- Routes tool calls back to the CRM with the agent's API key as `Authorization: Bearer ...`
- Logs every call to the CRM's `ApiLog` table, attributed to the calling agent

New endpoints in the CRM surface as new MCP tools automatically — no code changes here.

## Why a separate repo (the multi-agent story)

Each agent that connects to the CRM has its own `ApiKey` row with its own scopes, rate-limit, and audit trail. Setting up the MCP as a standalone npm package means:

- Any agent on any machine can `npx vestlaunch-mcp` after exporting two env vars
- Each agent sees only the tools its scopes allow (a read-only key registers fewer tools than a read+write key)
- The CRM's `ApiLog` shows exactly which agent did what, automatically
- One repo, one bug-fix point, ships to every agent simultaneously

## Quick start (per agent)

### 1. Generate an API key in the CRM

In `crm.vestlaunch.com`, go to **Settings → API Keys** and create a new key:

- **Name:** identify the agent (e.g. `claude-cowork-lando`, `claude-code-mac`, `clawbot-vps`)
- **Scopes:** start with read-only — `contacts:read`, `opportunities:read`, `tasks:read`, `pipelines:read`, `campaigns:read`, `workflows:read`, `bookings:read`, `activities:read`, `*` for `/me`
- **Rate limit:** match the agent's expected call volume

Copy the key once. It won't be shown again.

### 2. Configure your agent

#### Claude Desktop / Cowork

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "vestlaunch": {
      "command": "npx",
      "args": ["-y", "vestlaunch-mcp"],
      "env": {
        "VESTLAUNCH_BASE_URL": "https://crm.vestlaunch.com",
        "VESTLAUNCH_API_KEY": "ffl_live_..."
      }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add vestlaunch -- env VESTLAUNCH_BASE_URL=https://crm.vestlaunch.com VESTLAUNCH_API_KEY=ffl_live_... npx -y vestlaunch-mcp
```

#### ClawBot or any other MCP client

Spawn `npx -y vestlaunch-mcp` with `VESTLAUNCH_BASE_URL` and `VESTLAUNCH_API_KEY` in the environment. Stdio in, stdio out.

#### Hosted (no install) — connect over HTTP with your own key

The Vercel deployment exposes the same tools at `https://<your-app>.vercel.app/api/mcp` (Streamable HTTP). Connect with **your own CRM API key as the Bearer token** — no local install, no env vars:

```
URL:    https://<your-app>.vercel.app/api/mcp
Auth:   Bearer ffl_live_...   (your key from Settings → API Keys)
```

You only see the tools your key's scopes allow; writes are governed by those scopes (DELETE is never exposed, and campaign blasts always require a test send + confirmation code, enforced by the CRM). Revoking the key in the CRM cuts off access instantly. A legacy shared `MCP_BEARER_TOKEN` is still accepted for previously configured agents and behaves as before (env `VESTLAUNCH_API_KEY`, writes off unless `VESTLAUNCH_ENABLE_WRITES=true`).

### 3. Try it

In your agent, ask:

> *"Use vestlaunch to summarize my pipeline by stage and source over the last 30 days."*

The agent will call `vestlaunch_list_opportunities`, `vestlaunch_get_pipelines`, and any other tools it needs.

## Configuration

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `VESTLAUNCH_BASE_URL` | ✅ | — | CRM API base URL, no trailing slash. |
| `VESTLAUNCH_API_KEY` | ✅ | — | Per-agent API key from the CRM. |
| `VESTLAUNCH_ENABLE_WRITES` | ❌ | `false` | Set to `true` to register write tools (POST/PATCH/DELETE). Tools are still gated by the key's scopes — both must allow the write. |
| `VESTLAUNCH_LOG_LEVEL` | ❌ | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug`. Goes to stderr. |
| `VESTLAUNCH_TIMEOUT_MS` | ❌ | `30000` | Per-request timeout. |

## Available tools

Tools are discovered at runtime from the CRM's `/api/v1/me` manifest. As of CRM v1, the read-only surface includes:

- `vestlaunch_list_contacts`, `vestlaunch_get_contact`
- `vestlaunch_list_opportunities`, `vestlaunch_get_opportunity`
- `vestlaunch_list_tasks`, `vestlaunch_get_task`
- `vestlaunch_list_companies`, `vestlaunch_get_company`
- `vestlaunch_list_properties`, `vestlaunch_get_property`
- `vestlaunch_search`
- `vestlaunch_get_activities`
- `vestlaunch_get_pipelines`
- `vestlaunch_list_tags`, `vestlaunch_get_custom_fields`
- `vestlaunch_list_campaigns`, `vestlaunch_get_campaign`
- `vestlaunch_list_workflows`, `vestlaunch_get_workflow`
- `vestlaunch_list_bookings`
- `vestlaunch_get_me`
- `vestlaunch_get_agent_notes`, `vestlaunch_recall_memory`, `vestlaunch_query_knowledge`

Enabling writes (`VESTLAUNCH_ENABLE_WRITES=true`) plus the appropriate scopes adds create/update/delete variants, plus `vestlaunch_send_email`, `vestlaunch_send_sms`, `vestlaunch_log_call`, `vestlaunch_enroll_in_campaign`, `vestlaunch_trigger_workflow`, `vestlaunch_store_memory`, `vestlaunch_store_knowledge`, and the rest of the write surface.

## Tool shape

Every tool follows the same convention:

- **Path parameters** (`:id`, `:stepId`, …) → required string args
- **GET tools** → optional `query: { ... }` object (passed as `?key=value`)
- **Non-GET tools** → optional `body: { ... }` object (sent as JSON)

Returned content is the raw CRM response JSON: `{ success: true, data: ..., total?, limit?, offset? }`.

## Development

```bash
npm install
npm run typecheck
npm run build

# Run locally against the CRM
VESTLAUNCH_BASE_URL=https://crm.vestlaunch.com \
VESTLAUNCH_API_KEY=ffl_live_... \
npm run dev
```

## License

MIT — see [LICENSE](./LICENSE).
