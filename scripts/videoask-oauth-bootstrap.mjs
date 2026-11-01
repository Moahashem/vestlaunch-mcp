// One-time local OAuth bootstrap. No candidate reads, CRM writes, or emails.
// Input/output path must be outside the repository and mode 0600.
// Input JSON: {clientId, clientSecret}. Never pass credentials on the command line.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const file = resolve(process.env.VIDEOASK_BOOTSTRAP_FILE || '');
if (!process.env.VIDEOASK_BOOTSTRAP_FILE || !relative(process.cwd(), file).startsWith('..')) {
  throw new Error('Set VIDEOASK_BOOTSTRAP_FILE to a private file outside the checkout');
}
if ((await stat(file)).mode & 0o077) throw new Error('Credential file must have mode 0600');
const credentials = JSON.parse(await readFile(file, 'utf8'));
if (!credentials.clientId || !credentials.clientSecret) throw new Error('Missing client credentials');
const callback = 'http://localhost:8766/videoask/callback';
const state = randomBytes(32).toString('hex');
const authorize = new URL('https://auth.videoask.com/authorize');
for (const [key, value] of Object.entries({response_type:'code',audience:'https://api.videoask.com/',
  client_id:credentials.clientId,scope:'openid profile email offline_access',redirect_uri:callback,state})) authorize.searchParams.set(key,value);
let used = false;
const server = createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  const url = new URL(req.url || '/',callback);
  const returned = Buffer.from(url.searchParams.get('state') || '');
  const expected = Buffer.from(state);
  if (req.method !== 'GET' || url.pathname !== '/videoask/callback' || used ||
      returned.length !== expected.length || !timingSafeEqual(returned,expected) || !url.searchParams.get('code')) {
    res.writeHead(400); res.end('Invalid OAuth callback. No credentials saved.'); return;
  }
  used = true;
  try {
    const response = await fetch('https://auth.videoask.com/oauth/token',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),
        client_id:credentials.clientId,client_secret:credentials.clientSecret,redirect_uri:callback}),
    });
    if (!response.ok) throw new Error(`OAuth HTTP ${response.status}`);
    const token = await response.json();
    if (!token.refresh_token || !token.access_token) throw new Error('OAuth did not return offline credentials');
    await writeFile(file,JSON.stringify({...credentials,refreshToken:token.refresh_token,
      authorizedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
    res.end('VideoAsk connection authorized. Credentials saved privately. Recruiting remains on Zapier. You may close this tab.');
    console.log('OAuth complete; private credentials saved. No recruiting changes.');
  } catch {
    res.writeHead(502); res.end('OAuth setup failed. No recruiting changes.');
    console.error('OAuth setup failed; inspect configuration without logging credentials.');
    process.exitCode=1;
  } finally { clearTimeout(deadline); server.close(); }
});
const deadline=setTimeout(()=>{console.error('OAuth setup timed out.');server.close();process.exitCode=1;},15*60*1000);
server.listen(8766,'localhost',()=>console.log(authorize.href));
