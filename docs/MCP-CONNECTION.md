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
2. **That agent's CRM key** as `Authorization: Bearer ffl_live_...`. Minted in VestLaunch under Settings → API Keys. The server calls `GET /api/v1/me` with it on every connection. A 401 or 403 from the CRM is "invalid or revoked" and the key text is not returned.
3. **OAuth access token** from this host. A client that cannot send a static header gets the 401 above, reads the metadata, and uses `/authorize` and `/token` (PKCE). The CRM key is wrapped in an encrypted token and is not returned in cleartext. Access tokens expire in 1 hour. Refresh tokens expire in 30 days and are re-checked against `/api/v1/me` before a new access token is minted. If the CRM is down, refresh fails closed.

WorkOS is not the live login path. It runs only if `WORKOS_AUTHKIT_DOMAIN` is set.

## What the server allows

Tools come from `GET /api/v1/me` `capabilities[]`, plus the synthetic tools registered in `api/mcp.ts`. A tool is callable only when all of these hold:

- The key's `identity.scopes` include the tool's scope, or `*`.
- A write, send, or payment is not authorized by a scope that ends in `:read`. `properties:read` does not authorize `act_leasing_triage`, `set_office_closure`, `record_tour_outcome`, `close_lead_lost`, or `owner_billing` actions `dont_charge` and `undo`.
- `?tools=` on the URL can hide tools. It cannot reveal one the key lacks.
- There is no SQL tool, no remote-code tool, and no tool that reads browser cookies. A manifest entry whose name or path is one of those is not registered. A GET whose name or path is a send or payment is not registered; the POST form stays, behind its write scope.
- When `identity.business` / `identity.businesses` is present, a tool tagged `ffl` is hidden from a Cranbrook-only key and the reverse. `business: "both"` (or both ids) is the explicit cross-business grant. An empty list is not that grant.
- When `identity.workspaceIds` is present, a caller-supplied workspace id outside that list is denied, including an id inside `query` next to `offset` / `limit`. Omitting the id on a key with exactly one workspace pins the call to that workspace. `*`, `all`, or an empty id cannot clear the filter.
- Deletes stay on `VESTLAUNCH_DELETE_ALLOWLIST` (default `delete_contact`).

`GET /api/v1/me` today, as this repo reads it, is `identity.scopes`, `apiKeyId`, `name`, `agentName`, `email`. Business and workspace ids are enforced when the CRM sends them (`business`, `businesses`, `business: "both"`, `workspaceId`, `workspaceIds`, `workspaces[].id`). This server does not invent them.

Sending mail or SMS, posting to RingCentral, and changing the owner-billing list stay inside the CRM routes. This MCP does not add a path around those routes, and it does not perform those actions on a read scope. Campaign sends remain the CRM's test-send and confirmation rules.

## First Grok connection (read-only)

Do this in the CRM, not in this repo. This change does not mint a key, rotate one, or edit production env.

Create a key whose name is the agent, so `ApiLog` shows who called. For the first check, grant read scopes only:

- `contacts:read`, `opportunities:read`, `tasks:read`, `pipelines:read`
- `campaigns:read`, `workflows:read`, `bookings:read`, `activities:read`
- `properties:read` (the FFL and Cranbrook summary tools use this)
- `opportunities:read` also covers `count_landlord_leads` and the FFL sales summaries

Do not grant `*`, `communications:write`, `leasing:write`, `properties:write`, or `agent:write` for that check. Those are the send, leasing-write, billing-list change, and agent-write tools. Add one of them later only for a specific job.

The CRM binds a key to one business (see `api/_ruckus-cranbrook.ts`). A key that should see both FFL and Cranbrook has to be given that binding by the CRM, and `/api/v1/me` has to say so (`business: "both"` or both workspace ids). Until then, use one key per business. Do not reuse another agent's key.

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

Jordan, Sofia, Paige, Ruckus, and any human who may approve a payment already depend on whatever CRM key they have. This change does not add or remove those keys, and it does not name a money approver. Ruckus's Cranbrook tools (`api/_ruckus-cranbrook.ts`) are unchanged.

## CRM dependency

`ffl-crm` `GET /api/v1/me` should include the key's business and workspace ids on `data.identity`:

- `business`: `"ffl"`, `"cranbrook"`, or `"both"`
- or `businesses`: `["ffl"]` / `["cranbrook"]` / both
- `workspaceIds`: the workspace ids that key may name

Until that ships, this server still scopes tools by the scopes above, denies a business slug the key is not allowed to use once `business` is present, and forwards an opaque workspace id when `workspaceIds` is absent so existing filters keep working. The CRM must keep rejecting a record or workspace that belongs to the other business (`This API key belongs to another business`). A contact id in the path is the same dependency: this server cannot tell two tenants' ids apart.

No parallel CRM change is included here.

## Deploy and rollback

Merging this repo deploys only when the Vercel project for `vestlaunch-mcp` builds `main`. This change does not set env vars, mint keys, or call the CRM with a real credential.

Rollback is the previous Vercel deployment. There is no migration. `OAUTH_JWE_SECRET` is not rotated, so tokens that were already valid stay decryptable until they expire or the CRM key is revoked.
