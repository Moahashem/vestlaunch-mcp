/**
 * /authorize — the login screen of VestLaunch's self-hosted OAuth 2.1
 * authorization server.
 *
 * FLOW:
 *   GET  /authorize?client_id=…&redirect_uri=…&code_challenge=…&state=…
 *        → renders an HTML form asking the user to paste their VestLaunch CRM
 *          key (ffl_live_…). All the OAuth request params are carried forward as
 *          hidden fields so the POST has everything it needs.
 *   POST /authorize  (form-encoded: the hidden fields + the pasted crm_key)
 *        → validates the key against the CRM (/api/v1/me). On success we mint a
 *          short-lived encrypted authorization code (JWE) that wraps the CRM key
 *          plus the PKCE challenge + redirect_uri, then 302-redirect back to the
 *          client's redirect_uri with ?code=…&state=…. On failure we re-render
 *          the form with an error.
 *
 * The CRM key is the user's proof of identity: pasting a key that /api/v1/me
 * accepts IS the login. The key is never returned to the client in cleartext —
 * it lives only inside the encrypted code (and later the encrypted access token).
 *
 * Served at /authorize via a rewrite in vercel.json.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { CRM_KEY_PREFIX, mintAuthCode, validateCrmKey } from "./_oauth";

export const config = { maxDuration: 30 };

// ───────────────────────── helpers ─────────────────────────

/** HTML-escape a value before interpolating into markup or an attribute. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface AuthParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
}

/** Pull the OAuth params from a URLSearchParams (query string or form body). */
function readParams(p: URLSearchParams): AuthParams {
  return {
    clientId: p.get("client_id") ?? "",
    redirectUri: p.get("redirect_uri") ?? "",
    responseType: p.get("response_type") ?? "code",
    scope: p.get("scope") ?? "",
    state: p.get("state") ?? "",
    codeChallenge: p.get("code_challenge") ?? "",
    codeChallengeMethod: p.get("code_challenge_method") ?? "S256",
    resource: p.get("resource") ?? "",
  };
}

/** Read a form-urlencoded POST body. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** The login page. `error` shows a red banner; `values` re-fills hidden fields. */
function loginPage(pr: AuthParams, error?: string): string {
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;

  const errorHtml = error
    ? `<div class="error">${esc(error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to VestLaunch</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; background: #0f172a; color: #e2e8f0; padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: #1e293b; border-radius: 16px;
    padding: 32px; box-shadow: 0 20px 60px rgba(0,0,0,.4);
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 24px; color: #94a3b8; font-size: 14px; line-height: 1.5; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  input[type=password], input[type=text] {
    width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #334155;
    background: #0f172a; color: #e2e8f0; font-size: 15px; font-family: ui-monospace, monospace;
  }
  input:focus { outline: none; border-color: #6366f1; }
  button {
    width: 100%; margin-top: 20px; padding: 13px; border: none; border-radius: 10px;
    background: #6366f1; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #4f46e5; }
  .error {
    background: #7f1d1d; color: #fecaca; padding: 12px 14px; border-radius: 10px;
    font-size: 14px; margin-bottom: 20px;
  }
  .hint { margin-top: 16px; font-size: 12px; color: #64748b; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>Connect to VestLaunch</h1>
    <p class="sub">Paste your VestLaunch API key to link this app to your CRM. Your key is used to sign you in and is never shared with the app.</p>
    ${errorHtml}
    <form method="POST" action="/authorize">
      ${hidden("client_id", pr.clientId)}
      ${hidden("redirect_uri", pr.redirectUri)}
      ${hidden("response_type", pr.responseType)}
      ${hidden("scope", pr.scope)}
      ${hidden("state", pr.state)}
      ${hidden("code_challenge", pr.codeChallenge)}
      ${hidden("code_challenge_method", pr.codeChallengeMethod)}
      ${hidden("resource", pr.resource)}
      <label for="crm_key">VestLaunch API key</label>
      <input id="crm_key" name="crm_key" type="password" autocomplete="off"
             placeholder="${esc(CRM_KEY_PREFIX)}…" spellcheck="false" autofocus required>
      <button type="submit">Sign in &amp; connect</button>
    </form>
    <p class="hint">Find or create a key in VestLaunch under Settings → API Keys.</p>
  </div>
</body>
</html>`;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(html);
}

// ───────────────────────── handler ─────────────────────────

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── GET: render the login form ──
  if (req.method === "GET") {
    const pr = readParams(url.searchParams);
    if (!pr.redirectUri || pr.responseType !== "code") {
      sendHtml(
        res,
        400,
        loginPage(pr, "This connection request is missing required information (redirect_uri / response_type)."),
      );
      return;
    }
    sendHtml(res, 200, loginPage(pr));
    return;
  }

  // ── POST: validate the key, mint a code, redirect ──
  if (req.method === "POST") {
    const form = await readForm(req);
    const pr = readParams(form);
    const crmKey = (form.get("crm_key") ?? "").trim();

    if (!pr.redirectUri) {
      sendHtml(res, 400, loginPage(pr, "Missing redirect_uri."));
      return;
    }
    if (!pr.codeChallenge) {
      sendHtml(res, 400, loginPage(pr, "Missing PKCE code_challenge — the app didn't start the login correctly."));
      return;
    }
    if (!crmKey.startsWith(CRM_KEY_PREFIX)) {
      sendHtml(res, 400, loginPage(pr, `That doesn't look like a VestLaunch key — it should start with "${CRM_KEY_PREFIX}".`));
      return;
    }

    const check = await validateCrmKey(crmKey);
    if (!check.ok) {
      sendHtml(res, 401, loginPage(pr, "That key was not accepted. Check that it's active in Settings → API Keys and try again."));
      return;
    }

    // Mint the encrypted authorization code carrying everything /token needs.
    const code = await mintAuthCode(
      {
        crmKey,
        clientId: pr.clientId,
        redirectUri: pr.redirectUri,
        codeChallenge: pr.codeChallenge,
        codeChallengeMethod: pr.codeChallengeMethod,
        scope: pr.scope || undefined,
        resource: pr.resource || undefined,
      },
      req,
    );

    // Redirect back to the client with the code (and state, echoed verbatim).
    const redirect = new URL(pr.redirectUri);
    redirect.searchParams.set("code", code);
    if (pr.state) redirect.searchParams.set("state", pr.state);

    res.statusCode = 302;
    res.setHeader("location", redirect.toString());
    res.setHeader("cache-control", "no-store");
    res.end();
    return;
  }

  res.statusCode = 405;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}
