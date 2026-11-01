/** Temporary selected-admin supervised test; no arbitrary prompts or agents. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { COMPANY_NUMBER_AGENTS, configFingerprint } from './company-numbers-agent-migration';
import { directSheetsAddendum } from './company-numbers-sheets-rollout';
const titlePrefix = 'Supervised native Sheets ';
const fleetPrompt = (date: string, key: string) => `Mo explicitly authorizes a full supervised refresh by ${key} on today's EXISTING Company Numbers tab (${date}, America/Chicago), overriding the two-morning rollout wait. This test must perform fresh source reads and native Sheets writes even if today's status already says done; ignore completed flags only for this supervised run. Attempt EVERY source/item in your normal scope, preserving all source definitions, gates, formulas, optional/null rules, exact labels, and owned cell boundaries in your system prompt. Before starting mark each required source flag not-done in YOUR OWN status cell so a failed refresh cannot retain an old done flag. Read your owned cells first, use each required source tool once, write healthy outputs, apply D16 empty-string clear-on-error ONLY to failed owned outputs and write YOUR existing alerts. Do not preserve stale data on any failed source. Read back every written range and compare with source. Preserve normal snapshots and only report_run_complete when all required scope is freshly verified. No Zapier calls in this test. Never write another agent's ledger, manual cells or unrelated cells. ${key === 'sales-lead-count' ? 'Sales: first verify today already exists with sheets_read. Call sheets_create_day_tab for today to exercise its idempotent existing-tab behavior; it must NOT duplicate or clear an existing tab. Complete ALL leads, calls, signups, huddle items and normal housekeeping. Never write row 28.' : 'Writer-only: never create, duplicate, rename, clear or delete any tab.'} Report source diagnostics/as_of, cells written, read-back comparison and any failures. This is a manual test, not a scheduled morning.\n\n${directSheetsAddendum(key)}`;
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(body)); }
export const testPrompt = (date: string) => `Mo explicitly authorizes this supervised test on today's existing Company Numbers tab (${date}, America/Chicago). Run the full ShowMojo Homes update now, even if A104 already says homes=done: this one test must perform fresh native Sheets writes, not an idempotency-only skip. Call get_ffl_homes once and apply every normal source/plausibility gate. Read existing owned cells first. On valid data write ONLY A20:B20, D20:E20, A40/A41/A43/A44 and A104/A105/A106 using sheets_batch_update; NEVER C20, any unrelated cells, or any other tab. Preserve exact labels, block strings, status format and alert behavior from your system prompt. On source error apply D16 clear-on-error to your owned outputs, do not mark done, set your existing alerts. No Zapier calls at all in this test. Do not create a tab. Read back all owned outputs and C20, compare to source, and report counts, diagnostics, source as_of, ranges written and read-back match. Preserve normal best-effort snapshot behavior and report_run_complete only on fully verified success. This is a manual test, not a scheduled-morning receipt.\n\n${directSheetsAddendum('showmojo')}`;
export default async function handler(req: IncomingMessage,res: ServerResponse) {
 const key=new URL(req.url||'/', 'http://localhost').searchParams.get('agent_key')||'showmojo';
 if(!Object.hasOwn(COMPANY_NUMBER_AGENTS,key))return json(res,400,{error:'Unknown Company Numbers agent'});
 const selected=process.env.COMPANY_NUMBERS_MIGRATION_API_KEY_ID;
 if(!selected || !(process.env.COMPANY_NUMBERS_MIGRATION_APPLY_AGENTS||'').split(',').includes(key)) return json(res,404,{error:'Test disabled'});
 if(req.method!=='GET' && req.method!=='POST') return json(res,405,{error:'GET or POST required'});
 const token=req.headers.authorization||'';
 if(!token.startsWith('Bearer ffl_live_'))return json(res,401,{error:'CRM API key required'});
 const base=process.env.VESTLAUNCH_BASE_URL?.replace(/\/+$/,'');const secret=process.env.ANTHROPIC_API_KEY;
 if(!base||!secret)return json(res,503,{error:'Not configured'});
 let sessionId: string|undefined;
 try {
 const a=await fetch(`${base}/api/v1/me`,{headers:{Authorization:token},signal:AbortSignal.timeout(15000)});
 if(!a.ok)return json(res,401,{error:'CRM authentication failed'});
 const me=await a.json() as any;
 if(me.data?.identity?.apiKeyId!==selected||!me.data?.identity?.scopes?.includes('*'))return json(res,403,{error:'Selected admin required'});
 const headers={'x-api-key':secret,'anthropic-version':'2023-06-01','anthropic-beta':'managed-agents-2026-04-01','content-type':'application/json'};
 const sign=(id:string)=>createHmac('sha256',secret).update(`showmojo-test:${id}:${selected}${key === 'showmojo' ? '' : ':'+key}`).digest('hex');
 const read=async(path:string)=>{const r=await fetch(`https://api.anthropic.com/v1/${path}`,{headers,signal:AbortSignal.timeout(20000),cache:'no-store'});if(!r.ok)throw new Error('Upstream read failed');return await r.json() as any;};
 if(req.method==='GET'){
 const q=new URL(req.url||'/', 'http://localhost').searchParams;const id=q.get('session_id')||'';const proof=q.get('proof')||'';const cursor=q.get('after_id');
 if(!/^sesn_[a-zA-Z0-9]+$/.test(id)||!/^[a-f0-9]{64}$/.test(proof)||!timingSafeEqual(Buffer.from(sign(id)),Buffer.from(proof)))return json(res,403,{error:'Signed test session required'});
 if(cursor&&!/^[a-zA-Z0-9_-]{1,200}$/.test(cursor))return json(res,400,{error:'Invalid cursor'});
 const s=await read(`sessions/${id}`);if(s.agent?.id!==COMPANY_NUMBER_AGENTS[key]||!String(s.title).startsWith(titlePrefix))return json(res,403,{error:'Not a supervised test'});
 const events=await read(`sessions/${id}/events?limit=100${cursor?'&after_id='+encodeURIComponent(cursor):''}`);
 return json(res,200,{session:{id:s.id,status:s.status,stop_reason:s.stop_reason,agent:s.agent?.id,agent_version:s.agent?.version,title:s.title},events});
 }
 let raw='';for await(const chunk of req){raw+=chunk.toString();if(Buffer.byteLength(raw)>512)return json(res,413,{error:'Body too large'});}
 let input:any;try{input=JSON.parse(raw)}catch{return json(res,400,{error:'Invalid JSON'})}
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(!input||Object.keys(input).sort().join(',')!=='date,expected_fingerprint'||input.date!==today||!/^[a-f0-9]{64}$/.test(input.expected_fingerprint||''))return json(res,400,{error:'Today and reviewed fingerprint required'});
 if(!(process.env.COMPANY_NUMBERS_DIRECT_SHEETS_AGENTS||'').split(',').includes(key))return json(res,409,{error:'Native agent not selected'});
 const agent=await read(`agents/${COMPANY_NUMBER_AGENTS[key]}`);if(configFingerprint(agent)!==input.expected_fingerprint)return json(res,409,{error:'Agent drift'});
 if(!process.env.FFL_ENVIRONMENT_ID||!process.env.FFL_VAULT_ID)return json(res,503,{error:'Shared runtime missing'});
 const r=await fetch('https://api.anthropic.com/v1/sessions',{method:'POST',headers,signal:AbortSignal.timeout(20000),body:JSON.stringify({agent:COMPANY_NUMBER_AGENTS[key],environment_id:process.env.FFL_ENVIRONMENT_ID,vault_ids:[process.env.FFL_VAULT_ID],title:titlePrefix+(key==='showmojo'?'ShowMojo':key)+' test '+today,initial_events:[{type:'user.message',content:[{type:'text',text:key==='showmojo'?testPrompt(today):fleetPrompt(today,key)}]}]})});
 if(!r.ok)return json(res,502,{error:`Session create failed HTTP ${r.status}; inspect before retry`});
 const s=await r.json() as any;sessionId=s.id;if(!sessionId)throw new Error('No session');
 return json(res,200,{session_id:sessionId,proof:sign(sessionId),date:today,agent_version:agent.version});
 }catch{return json(res,502,{error:'Test request failed; inspect before retry',session_id:sessionId});}
}
