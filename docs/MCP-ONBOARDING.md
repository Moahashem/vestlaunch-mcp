# Onboarding MCP

`/api/mcp` is unchanged for every key whose CRM identity omits `mcpProfile`.
`/api/mcp-onboarding` is the only surface for a key the CRM has marked
`mcpProfile: "onboarding"`. A client cannot opt into that profile, and a key
that has it cannot fall back to `/api/mcp` or to `VESTLAUNCH_API_KEY`.

This route is not a release of data access. Its allowlist is one metadata
tool, `connection_status` (`GET mcp://connection-status`). `dataRoutesCleared`
is empty. Analytics, owner billing, leasing, voice, sheets, and catalogs stay
off this profile until a later change names a specific method and path.

## What the CRM must return

`GET /api/v1/me` for a new bot key, and only that key:

```json
{
  "data": {
    "identity": {
      "scopes": ["mcp:onboarding"],
      "business": "ffl",
      "workspaceIds": ["<workspace id>"],
      "mcpProfile": "onboarding"
    }
  }
}
```

The marker is read only from `data.identity`. A marker anywhere else leaves
`/api/mcp` on today's manifest.

- `mcpProfile` is exactly `onboarding`. Any other value, including an array or
  a near-synonym, is rejected on both routes. A missing field on a JSON object
  means the key stays on `/api/mcp` and is refused by `/api/mcp-onboarding`.
  `identity` itself must be that object. `null`, a missing identity, a string,
  an array, a number, or a boolean is malformed. It does not register data
  tools and it does not pass onboarding.
- `business` is exactly `ffl`, `cranbrook`, or `both`. A display name such as
  `Cranbrook Forest` is not a grant. An optional `businesses` array must agree
  (`["ffl"]`, `["cranbrook"]`, or `["ffl","cranbrook"]`).
- `workspaceIds` is a non-empty array of workspace ids. `ffl`, `cranbrook`,
  and `both` are not workspace ids.
- `scopes` must be `["mcp:onboarding"]` and nothing else. This MCP does not
  treat that token as a data grant. The CRM must also refuse it on every
  `/api/v1/*` data route. Do not issue `*`, `properties:read`, or any other
  scope that already authorizes CRM REST. A data scope on this key bypasses
  the MCP allowlist by calling the CRM directly. This repository cannot close
  that path.

Do not set `mcpProfile` on `VESTLAUNCH_API_KEY`, the ai-ops key, or keys that
back the live OAuth grants. Those callers keep `/api/mcp`. Set it only when
creating a new bot key. Record-level isolation stays in the CRM.

## Credential rules

The onboarding route accepts the bot's own `ffl_live_` key, or an OAuth access
token that unwraps to one. The shared bearer is refused before any CRM call.
There is no secret fallback. Authorization-code issuance is unchanged.

`/api/sheets-mcp` calls the same handler as `/api/mcp` and applies the same
profile gate. The stdio entry (`npx vestlaunch-mcp`) applies it after
`GET /api/v1/me` and exits without registering tools. The Company Numbers
inspection, cutover, and supervised-test routes also refuse a key once
`mcpProfile` is present or the identity is not an object. A key that omits
the field keeps those routes' existing admin-key checks.

`ruckus_send` posts only when the presented bearer is exactly
`RUCKUS_SEND_TOKEN`. A refused post is not retried. Case changes, a leading
invisible character, a second `Bearer` scheme, a refresh token, a CRM key,
and any other string are not replaced with the vault token. The 2026-11-06
recovery accepted a previous cron secret that no longer matched. That caller
cannot be identified with the auth this server already has. No new secret or
identity bridge is added. Those posts stay refused until the vault bearer is
the current token, and this release stays held. Recruiting and agent-os
files are unchanged.

The CRM does not yet store `mcpProfile` or the reserved scope
`mcp:onboarding`. Do not issue a new bot key until that contract is live.
This repository does not mint keys.

## Shared bearer and OAuth discovery

`/api/mcp` matches `MCP_BEARER_TOKEN` before the `ffl_live_` prefix. When
those two values are the same string, the request uses `VESTLAUNCH_API_KEY`
and the profile gate sees that key's identity. Confirm they are different
before any release of this gate. That check is an operational prerequisite.
This change does not read either value and does not alter the match order.

OAuth discovery still advertises `authorization_code` and `refresh_token`.
Changing that document would break clients that already connect. A token
that wraps a marked key is confined when `/api/mcp` or
`/api/mcp-onboarding` reads `/api/v1/me` again. Discovery itself grants no
tools.

Logs use `mcp_onboarding_class=crm_key|oauth|rejected` and do not include the
secret, a prefix, a hash, or a user id. `/api/mcp` keeps its own
`mcp_credential_class` line.

## Held work

Pull request 144 stays unmerged. Shipping it would apply the strict allowlist
to every non-shared credential, including the live OAuth grants observed on
`/api/mcp`. This route is the separation that lets those grants keep working
while a newly marked key cannot leave the onboarding allowlist.
