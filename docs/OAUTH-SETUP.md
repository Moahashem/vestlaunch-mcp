# VestLaunch MCP — Sign-In (OAuth) Setup

**Plain-language guide for Mo. Last updated 2026-07-14.**

## The problem we're fixing

When you add VestLaunch as a custom connector in Claude Desktop and click **Connect**, you get "an error, couldn't connect." That's because Claude's connector dialog has nowhere to paste a secret key — the modern connector standard expects a real **sign-in flow** ("Connect" → a login page opens → you approve → Claude gets its access automatically). Our server doesn't offer that login flow yet, so the handshake fails before it starts.

## The decision (locked)

You chose the **managed auth provider** path — the right long-term option, no shortcuts.

In plain terms: we do **not** hand-build a login system (that's the risky, security-sensitive part that companies get wrong). Instead we plug in a specialist whose entire job is secure sign-in: **WorkOS AuthKit**. It's free at our scale.

Two pieces, clean division of labor:

| Piece | Who | Job |
|---|---|---|
| **WorkOS AuthKit** | the specialist | Runs the login page, "Allow VestLaunch?" consent screen, and issues the secure access token. |
| **vestlaunch-mcp** (our server) | us | Checks that WorkOS-issued token is real, then talks to the CRM on the user's behalf. |

Think of WorkOS as the bouncer who checks IDs at the door, and our MCP server as the room that only lets in people the bouncer already cleared.

## What only YOU can do (owner-only steps)

I can write all the code, but four things require your login and I must not do them for you. Do these in any order — they can happen in parallel with me writing the code.

### 1. Create the WorkOS account
- Go to **workos.com**, sign up (free), create a project. Name it something like `VestLaunch`.

### 2. Turn on AuthKit as an MCP auth server
- In the WorkOS dashboard, open **AuthKit** and enable it.
- Enable **Dynamic Client Registration (DCR)** — this is the setting that lets Claude Desktop connect without you pre-registering it. (WorkOS → AuthKit → Configuration.)
- Add a redirect/callback for AuthKit's hosted UI if it asks — the default AuthKit domain is fine.

### 3. Capture these values (you'll only see the API key once)
From the WorkOS dashboard, copy down:
- **AuthKit domain** — looks like `https://your-project.authkit.app`
- **WorkOS Client ID** — starts with `client_...`
- **WorkOS API Key** — starts with `sk_live_...` (⚠️ shown once — copy it immediately)

### 4. Add them to Vercel
In the Vercel project for `vestlaunch-mcp` → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `WORKOS_AUTHKIT_DOMAIN` | the AuthKit domain from step 3 |
| `WORKOS_CLIENT_ID` | `client_...` |
| `WORKOS_API_KEY` | `sk_live_...` |
| `MCP_USER_KEY_MAP` | see below |

**`MCP_USER_KEY_MAP`** is how the server knows which CRM key belongs to which signed-in person. It's a small JSON object mapping each person's login email to their CRM `ffl_live_` key. Example:

```json
{"mo@flatfeelandlord.com":"ffl_live_XXXX","sam@flatfeelandlord.com":"ffl_live_YYYY"}
```

Paste it as one line. When a new teammate needs access, you mint their CRM key in VestLaunch (Settings → API Keys) and add one line here — no code change needed.

## The one GitHub blocker

The access token I have for GitHub is **read-only** — I can write the code into your project folder, but I cannot push it or open a pull request. So either:
- **You push it** (I'll tell you exactly what changed), or
- You give me a **write-scoped** GitHub token and I'll open a PR (authored as you, never self-merged).

## How it'll work once live (what you and Sam will see)

1. Add VestLaunch as a custom connector in Claude Desktop, click **Connect**.
2. A WorkOS login page opens. Sign in with your work email.
3. A consent screen: "Allow VestLaunch to access your CRM?" → Allow.
4. Done. Claude is connected — no keys, no copy-paste, ever.

## What I'm building on the code side (for reference)

- A discovery endpoint (`/.well-known/oauth-protected-resource`) that tells Claude "go to WorkOS to log in."
- Token checking: every request's token is verified against WorkOS before we do anything.
- Identity → CRM key mapping using `MCP_USER_KEY_MAP`, so each person acts as themselves in the CRM.
- The old direct-key method keeps working, so nothing breaks during the switch.

Nothing here touches the CRM itself, and no security-sensitive login code is hand-written by us — WorkOS handles that.
