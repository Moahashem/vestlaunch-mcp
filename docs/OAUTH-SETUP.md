# VestLaunch MCP: connecting Claude with sign in

**Last updated 2026-11-27.** Replaces the July WorkOS plan, which was dropped.

## How it works

The hosted server at `https://vestlaunch-mcp.vercel.app/api/mcp` runs its own
OAuth 2.1 sign in (files `api/authorize.ts`, `api/token.ts`,
`api/oauth-register.ts`, `api/_oauth.ts`). No third party is involved.

1. You add the URL as a custom connector in Claude and press **Connect**.
2. Claude registers itself and opens the VestLaunch sign in page.
3. You paste a VestLaunch API key (`ffl_live_...`). The server checks it with
   the CRM (`/api/v1/me`) and sends Claude back an encrypted code.
4. Claude trades the code for an access token (1 hour) and a refresh token
   (30 days, rotated on each use). Both are encrypted and carry the key inside;
   the key itself never goes back to Claude.
5. Every tool call uses that key, so Claude sees exactly the tools and data the
   key allows. Revoke the key in VestLaunch and access stops at once.

Only `OAUTH_JWE_SECRET` and `VESTLAUNCH_BASE_URL` are needed in Vercel. Both
are set.

## One connector per workspace

A VestLaunch key belongs to one workspace, and the CRM refuses any request that
names another workspace or business. So FFL and Cranbrook stay apart by using
one key and one connector for each:

| Connector name in Claude | Key created in workspace |
|---|---|
| VestLaunch FFL Sales | landlord-prospecting |
| VestLaunch FFL Ops | ffl-ops |
| VestLaunch Cranbrook | cranbrook-leasing |

Give each connector its own name so its tools stay labeled by workspace. If
Claude won't take a second connector at the same URL, add a label to the URL,
for example `https://vestlaunch-mcp.vercel.app/api/mcp?workspace=cranbrook`.
The server ignores that parameter; the key alone decides the workspace.

## Making a key for Claude

In VestLaunch, switch to the workspace, open **Settings > API Keys**, and
create a key:

- **Name:** `claude-main-chat-<workspace>`
- **Type:** agent
- **Access:** Full API access (everything in that workspace)
- **Expires in:** 1 year

The key is shown once. Paste it straight into the Claude sign in page; it does
not need to be saved anywhere else.

## What stays guarded on the server

- Delete tools are off except the names in `VESTLAUNCH_DELETE_ALLOWLIST`
  (default: `delete_contact`).
- Campaign blasts still need a test send and confirmation code (CRM side).
- The sign in page only returns codes to approved apps: Claude's callbacks on
  `claude.ai` and `claude.com`, and loopback addresses for local clients. Add
  any other app's redirect URI or https origin to `OAUTH_REDIRECT_ALLOWLIST`
  (comma separated). Existing connections refresh without going through this
  page, so they are not affected.

## Other ways to connect

Agents that can send a header can skip sign in and use their own key as
`Authorization: Bearer ffl_live_...` on the same URL. The legacy shared
`MCP_BEARER_TOKEN` still works for older agents.
