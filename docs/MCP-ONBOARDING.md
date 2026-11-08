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
      "scopes": ["properties:read"],
      "business": "ffl",
      "workspaceIds": ["<workspace id>"],
      "mcpProfile": "onboarding"
    }
  }
}
```

- `mcpProfile` is exactly `onboarding`. Any other value, including an array or
  a near-synonym, is rejected on both routes. A missing field means the key
  stays on `/api/mcp` and is refused by `/api/mcp-onboarding`.
- `business` is exactly `ffl`, `cranbrook`, or `both`. A display name such as
  `Cranbrook Forest` is not a grant. An optional `businesses` array must agree
  (`["ffl"]`, `["cranbrook"]`, or `["ffl","cranbrook"]`).
- `workspaceIds` is a non-empty array of workspace ids. `ffl`, `cranbrook`,
  and `both` are not workspace ids.
- `scopes` is a non-empty array of scope tokens. On this route scopes do not
  add tools. The allowlist is server-owned. `?tools=` can only be ignored.

Do not set `mcpProfile` on `VESTLAUNCH_API_KEY`, the ai-ops key, or keys that
back the live OAuth grants. Those callers keep `/api/mcp`. Set it only when
creating a new bot key. Record-level isolation stays in the CRM.

## Credential rules

The onboarding route accepts the bot's own `ffl_live_` key, or an OAuth access
token that unwraps to one. The shared bearer is refused before any CRM call.
There is no secret fallback. Authorization-code issuance is unchanged.

`/api/sheets-mcp` calls the same handler as `/api/mcp` and applies the same
profile gate. The Company Numbers inspection, cutover, and supervised-test
routes also refuse a key once `mcpProfile` is present; a key that omits it
keeps those routes' existing admin-key checks. Ruckus, agent-os, and
recruiting keep their own vault tokens (`RUCKUS_SEND_TOKEN`, `CRON_SECRET`,
`RECRUITING_MCP_TOKEN`). An onboarding CRM key does not satisfy those tokens,
and those route files are unchanged.

Logs use `mcp_onboarding_class=crm_key|oauth|rejected` and do not include the
secret, a prefix, a hash, or a user id. `/api/mcp` keeps its own
`mcp_credential_class` line.

## Held work

Pull request 144 stays unmerged. Shipping it would apply the strict allowlist
to every non-shared credential, including the live OAuth grants observed on
`/api/mcp`. This route is the separation that lets those grants keep working
while a newly marked key cannot leave the onboarding allowlist.
