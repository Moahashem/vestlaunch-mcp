// Live, read-only renewal probe. Saves rotated credentials before testing them.
// VIDEOASK_BOOTSTRAP_FILE is the private output of videoask-oauth-bootstrap.mjs.
import { readFile, stat, writeFile, rename } from 'node:fs/promises';
const file=process.env.VIDEOASK_BOOTSTRAP_FILE;
if(!file || ((await stat(file)).mode & 0o077)) throw new Error('Use a mode-0600 credential file');
const credentials=JSON.parse(await readFile(file,'utf8'));
if(!credentials.refreshToken) throw new Error('OAuth consent is not complete');
const checks=[];
try {
  for(let round=1;round<=2;round++) {
    const response=await fetch('https://auth.videoask.com/oauth/token',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'refresh_token',client_id:credentials.clientId,
        client_secret:credentials.clientSecret,refresh_token:credentials.refreshToken,
        scope:'openid profile email offline_access'}),
    });
    if(!response.ok) throw new Error(`OAuth HTTP ${response.status}`);
    const token=await response.json();
    if(!token.access_token) throw new Error('Missing access token');
    const rotated=!!token.refresh_token && token.refresh_token!==credentials.refreshToken;
    if(rotated) {
      credentials.refreshToken=token.refresh_token;
      await writeFile(file+'.tmp',JSON.stringify(credentials,null,2)+'\n',{mode:0o600});
      await rename(file+'.tmp',file);
    }
    const read=await fetch('https://api.videoask.com/forms?limit=100',{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(25000),
      headers:{authorization:`Bearer ${token.access_token}`,'organization-id':'94dc21de-9c4d-4abc-a933-d8324bd853e3'},
    });
    if(!read.ok) throw new Error(`Forms read HTTP ${read.status}`);
    const body=await read.json();
    const rows=body.results ?? body.contents;
    if(!Array.isArray(rows) || !rows.length) throw new Error('Invalid or empty forms collection');
    checks.push({round,oauthStatus:response.status,readStatus:read.status,forms:rows.length,
      accessTokenLifetimeSeconds:token.expires_in,rotatedRefreshToken:rotated});
  }
  console.log(JSON.stringify({at:new Date().toISOString(),passed:true,checks,
    caveat:'Immediate refresh grants verified; 30-day lifetime has not elapsed.',
    emailsSent:0,candidateWrites:0,productionSwitch:false},null,2));
} catch(error) {
  console.error(JSON.stringify({passed:false,checks,error:error instanceof Error?error.message:'Renewal failed',productionSwitch:false}));
  process.exitCode=1;
}
