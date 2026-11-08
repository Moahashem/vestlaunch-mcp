# VestLaunch MCP connection

Remote MCP for VestLaunch CRM. This is the existing server (`api/mcp.ts` behind `server.ts`), not a second one.

## Endpoint

| | |
|---|---|
| Resource | `https://vestlaunch-mcp.vercel.app/api/mcp` |
| Health | `GET https://vestlaunch-mcp.vercel.app/health` |
| Protected-resource metadata | `GET https://vestlaunch-mcp.vercel.app/.well-known/oauth-protected-resource` |
| Authorization server metadata | `GET https://vestlaunch-mcp.vercel.app/.well-known/oauth-authorization-server` |
| Login | `GET /authorize` on that same host |
| Token | `POST /token` on that same host |

Checked without a credential against the deployment that was live on 2026-11-08 (the commit before this change):

- `GET /health` returned 200 and a route list. It does not return CRM records.
- `POST /api/mcp` with no `Authorization` header returned 401 and `WWW-Authenticate: Bearer resource_metadata="https://vestlaunch-mcp.vercel.app/.well-known/oauth-protected-resource"`.
- The metadata document names the resource `https://vestlaunch-mcp.vercel.app/api/mcp`, this host as the authorization server, and `bearer_methods_supported: ["header"]`.

An authenticated `initialize` / `tools/list` against production was not run. No task-scoped key was provided.

## Transport

Stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports). The handler constructs `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` and `enableJsonResponse: true`.

- Send JSON-RPC in a `POST` body.
- Send `Accept: application/json, text/event-stream`.
- Send `Authorization` on every request. There is no session cookie and no browser-token exchange.
- A client that only speaks the older SSE transport (`GET` plus a session id) is not what this server implements.

## Auth

Three ways, in this order. None of them is a shared password for every agent.

1. **Legacy shared bearer** (`MCP_BEARER_TOKEN`). Kept so existing agents keep working. Uses the deployment's `VESTLAUNCH_API_KEY`. Manifest writes stay off unless `VESTLAUNCH_ENABLE_WRITES=true`. Do not put a new agent on this token.
2. **Scoped CRM key** as `Authorization: Bearer ffl_live_...`. This is the path for a new agent, including Grok. The server calls `GET /api/v1/me` with that key only. If the identity does not match the contract below, the connection is **403** and the server does **not** retry with `VESTLAUNCH_API_KEY`. A 401 or 403 from the CRM itself is "invalid or revoked". The key text is not returned.
3. **OAuth authorization-code sign-in is disabled.** `/authorize` returns 403 and `POST /token` with `grant_type=authorization_code` returns `unauthorized_client`. Discovery advertises `refresh_token` only. This deployment has no database or KV that can consume a code once across instances, and process memory is not used. Setting `OAUTH_CODE_STORE=memory` does not turn the flow on. The supported connection is the static CRM API key Bearer in (2). A refresh token that was already issued can still be exchanged; that grant is not an authorization code. It is re-checked against the CRM and stays bound to `client_id`.

WorkOS is not the live login path. It runs only if `WORKOS_AUTHKIT_DOMAIN` is set. A failed scoped key is not sent there and is not retried as the shared token.

## What the server allows

Tools come from `GET /api/v1/me` `capabilities[]`, plus the synthetic tools registered in `api/mcp.ts`. A tool is callable only when all of these hold:

- The key's `identity.scopes` include the tool's scope. A tool whose scope is `*` requires the key to hold `*`. A key with no scopes, or only `contacts:read`, cannot call that tool.
- A write, send, or payment is not authorized by a scope that ends in `:read`. `properties:read` does not authorize `act_leasing_triage`, `set_office_closure`, `record_tour_outcome`, `close_lead_lost`, or `owner_billing` actions `dont_charge` and `undo`.
- `?tools=` on the URL can hide tools. It cannot reveal one the key lacks.
- There is no SQL tool, no remote-code tool, and no tool that reads browser cookies. A manifest entry whose name or path is one of those is not registered. A GET whose name or path is a send or payment is not registered; the POST form stays, behind its write scope.
- A **scoped** key whose identity is missing, malformed, or contradictory is refused before any tool runs. A display name or slug is not a business.
- `business`, `businessId`, `tenant`, and `tenantId` cannot select a business. `workspaceId` (any case, underscore, or hyphen) is kept only when it exactly matches one id in `identity.workspaceIds`. `ffl` is not a workspace id. With no list, that filter is denied because there is nothing authoritative to match. Nesting past depth 6 rejects the call. One declared id is pinned when omitted. Two require the caller to name exactly one of them.
- Deletes stay on `VESTLAUNCH_DELETE_ALLOWLIST` (default `delete_contact`).

### Required `data.identity` for a scoped key

```json
{
  "scopes": ["properties:read"],
  "business": "ffl",
  "workspaceIds": ["<workspace id>"]
}
```

- `scopes`: non-empty array of scope strings. `*` is the wildcard grant.
- `business`: exactly `ffl`, `cranbrook`, or `both`. Optional `businesses` may repeat the same set (`["ffl"]` or `["ffl","cranbrook"]`) and must not disagree.
- `workspaceIds`: non-empty array of workspace ids. The strings `ffl`, `cranbrook`, and `both` are not workspace ids.

`name` and `agentName` are labels. They are not read as grants. A record id in a tool path is not checked here.

### Legacy shared token

`authority: "legacy-shared"` is only the `MCP_BEARER_TOKEN` match, and the local stdio process unless `VESTLAUNCH_AUTH_MODE=scoped`. It does not fail closed when `business` is absent, and it still lists both companies' synthetic tools when the scopes allow them. It rejects business and tenant selectors. A workspace id is kept only when it exactly matches `workspaceIds` on that token's identity. Audit lines include `authority` so this is not the same as a scoped key. Do not move a new agent onto this token to avoid the 403.

### Migration risks

- A per-user key or OAuth session whose `/api/v1/me` lacks the shape above gets 403 after this deploy. Agents that use those keys stop until the CRM sends the shape. The shared bearer is not a fallback.
- `businessId` and `tenant` are denied everywhere. A `workspaceId` that exactly matches a declared workspace id is kept for legacy and stdio as well as scoped keys. Until `/api/v1/me` sends `workspaceIds`, those clients have no id to match, so a workspace filter is denied and the call works only if the filter is omitted. The event-type tools in `src/manifest.ts` document an optional `workspaceId`; omitting it is the path that still runs. No test or doc in this repo shows a production client that must send one.
- A manifest tool published with scope `*` is visible only to keys that hold `*`.
- Refresh requests must send the same `client_id` the code was minted for. A client that omitted `client_id` must reconnect.
- Stdio stays `legacy-shared` until `VESTLAUNCH_AUTH_MODE=scoped`. Setting that before the CRM shape exists makes the local process refuse to start.

Sending mail or SMS, posting to RingCentral, and changing the owner-billing list stay inside the CRM routes. This MCP does not add a path around those routes, and it does not perform those actions on a read scope. Campaign sends remain the CRM's test-send and confirmation rules.

## First Grok connection (read-only)

Do this in the CRM, not in this repo. This change does not mint a key, rotate one, or edit production env.

Create a key whose name is the agent, so `ApiLog` shows who called. For the first check, grant read scopes only:

- `contacts:read`, `opportunities:read`, `tasks:read`, `pipelines:read`
- `campaigns:read`, `workflows:read`, `bookings:read`, `activities:read`
- `properties:read` (the FFL and Cranbrook summary tools use this)
- `opportunities:read` also covers `count_landlord_leads` and the FFL sales summaries

Do not grant `*`, `communications:write`, `leasing:write`, `properties:write`, or `agent:write` for that check. Those are the send, leasing-write, billing-list change, and agent-write tools. Add one of them later only for a specific job.

A scoped key cannot connect until `/api/v1/me` returns the shape above. `business: "both"` with both workspace ids is the cross-business grant. Do not reuse another agent's key, and do not point the connector at `MCP_BEARER_TOKEN`.

Connector config, with the secret supplied by the approved connector tool and not written into git:

```json
{
  "mcpServers": {
    "vestlaunch": {
      "url": "https://vestlaunch-mcp.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer <CRM key minted for this agent>"
      }
    }
  }
}
```

## Not decided here

Jordan, Sofia, Paige, Ruckus, and any human who may approve a payment already depend on whatever CRM key they have. This change does not add or remove those keys, and it does not name a money approver.

`/api/ruckus-mcp`, `/api/ruckus-execute`, and `api/_ruckus-cranbrook.ts` are unchanged. They are not behind this gate. Ruckus's Cranbrook tools use `RUCKUS_CRANBROOK_API_KEY` and strip `workspaceId` themselves. `ruckus-execute` runs an approved tool with an env key after a separate CRM approval check. A refused scoped call on `/api/mcp` is not retried through those routes. Risk: those routes can still act with their own env keys, and this PR does not re-check their business contract.

## CRM dependency

Scoped connections stay closed until `ffl-crm` `GET /api/v1/me` returns `data.identity` in the shape in the section above. This repo does not change the CRM and does not invent a business from a name.

Path record ids (a contact id, a conversation id) are not decided here. The CRM has to guarantee that a key cannot read or write another business's record by id. That enforcement is separate CRM work. This server will not grow a second copy of it.

Authorization-code sign-in stays off until a durable nonce store exists. This repo does not add one. Do not set `OAUTH_CODE_STORE=memory`.

## Rollout

1. CRM returns the identity shape below and enforces record ids against that key's business. This MCP does not deploy that.
2. Review this MCP. The supported client path is `Authorization: Bearer` with the agent's own CRM key. Do not turn on authorization-code sign-in in the same release.
3. Deploy this MCP only after that review. Scoped keys 403 until step 1 is live. Legacy bearer and default stdio keep running, and a workspace filter works only as an exact match once step 1 includes `workspaceIds`.
4. A later change may enable authorization codes only together with an atomic consume on a store this deployment already has. That is not this commit.

Real clients not exercised here: Claude Desktop Connect (it will get 403 on `/authorize`), any hosted per-user key, any stdio process that sends `workspaceId`, and the live Ruckus routes. No production credential was used.

## Deploy and rollback

Merging this repo deploys only when the Vercel project for `vestlaunch-mcp` builds `main`. This change does not set env vars, mint keys, or call the CRM with a real credential.

Rollback is the previous Vercel deployment. There is no migration. `OAUTH_JWE_SECRET` is not rotated, so tokens that were already valid stay decryptable until they expire or the CRM key is revoked.
