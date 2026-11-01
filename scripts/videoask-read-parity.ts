/** Run with tsx and VIDEOASK_PARITY_CONFIG pointing to a private JSON file.
 * Only GETs to VideoAsk and the existing Zapier GET tool. No recruiting tool
 * invocation, email API, CRM state access, or live cache mutation is possible.
 * Output contains counts/digests only, never candidates, credentials or bodies.
 */
import { nextVideoaskPage, videoaskPageRows, videoaskZapierReadArgs } from "../api/_videoask-pagination.js";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createVideoaskReader, videoaskReadUrl } from "../api/_videoask-direct.js";

async function main() {
  const file = process.env.VIDEOASK_PARITY_CONFIG;
  if (!file || ((await stat(file)).mode & 0o077)) throw new Error("Use a private mode-0600 config file");
  const config = JSON.parse(await readFile(file,"utf8"));
  if (!config.zapierUrl || new URL(config.zapierUrl).hostname !== "mcp.zapier.com") throw new Error("Expected existing Zapier MCP URL");
  if (config.zapierTool && config.zapierTool !== "videoask_make_api_get_request") throw new Error("Only the VideoAsk GET tool is allowed");
  const direct = createVideoaskReader(() => config);
  let directCalls=0, zapierCalls=0;
  const readDirect = async (path:string) => { directCalls++; return direct(path); };
  async function legacy(path:string): Promise<Record<string,unknown>> {
    const url=videoaskReadUrl(path).href;
    if (zapierCalls >= 85) throw new Error("Comparison task budget reached");
    zapierCalls++;
    const response=await fetch(config.zapierUrl,{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(60_000),
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream",
        ...(config.zapierToken ? {authorization:`Bearer ${config.zapierToken}`} : {})},
      body:JSON.stringify({jsonrpc:"2.0",id:zapierCalls,method:"tools/call",params:{
        name:"videoask_make_api_get_request",arguments:videoaskZapierReadArgs(url)}}),
    });
    if (!response.ok) throw new Error(`Zapier HTTP ${response.status}`);
    let text=await response.text();
    if (text.trim().startsWith("event:") || text.trim().startsWith("data:")) {
      text=text.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).at(-1) || "";
    }
    const rpc=JSON.parse(text);
    if (rpc.error || rpc.result?.isError) throw new Error("Zapier tool error");
    const raw=JSON.parse(rpc.result.content.find((c:{type:string})=>c.type==="text").text);
    const envelope=raw.results?.[0];
    if (!envelope || envelope.status !== 200 || !envelope.body) throw new Error("Unexpected Zapier envelope");
    const body=typeof envelope.body === "string" ? JSON.parse(envelope.body) : envelope.body;
    if (!Array.isArray(body.results ?? body.contents)) throw new Error("Invalid legacy collection");
    return body;
  }
  type Reader=(path:string)=>Promise<Record<string,unknown>>;
  async function collect(read:Reader,path:string,limit:number,cap:number,cutoff?:number) {
    const rows:Record<string,unknown>[]=[];
    let current=`${path}?limit=${limit}&offset=0`;
    for(let page=0;page<cap;page++) {
      const data=await read(current);
      const items=videoaskPageRows(data);
      if (!Array.isArray(items)) throw new Error("Missing collection");
      for (const item of items) {
        if (cutoff && Date.parse(String(item.created_at)) < cutoff) return rows;
        rows.push(item);
      }
      const next=nextVideoaskPage(current,data.next);
      if (!next) return rows;
      current=next;
    }
    throw new Error("Pagination cap reached; comparison incomplete (do not switch)");
  }
  const digest=(rows:unknown[])=>createHash("sha256").update(JSON.stringify(rows.map(r=>JSON.stringify(r)).sort())).digest("hex");
  const checks:{scope:string;direct:number;legacy:number;match:boolean}[]=[];
  function compare(scope:string,a:unknown[],b:unknown[]) {
    const check={scope,direct:a.length,legacy:b.length,match:digest(a)===digest(b)};
    checks.push(check);
    console.log(JSON.stringify({progress:check,directCalls,zapierCalls}));
  }
  const formsA=await collect(readDirect,"/forms",100,100);
  const formsB=await collect(legacy,"/forms",100,100);
  const formIdentity=(r:Record<string,unknown>)=>[r.form_id ?? r.id,r.title];
  compare("forms",formsA.map(formIdentity),formsB.map(formIdentity));
  if (!checks[0]!.match) throw new Error("Form inventory differs; stop before contact comparison");
  for (const form of formsA) {
    const path=`/forms/${form.form_id ?? form.id}/contacts`;
    const a=await collect(readDirect,path,100,250);
    const b=await collect(legacy,path,100,250);
    const identity=(r:Record<string,unknown>)=>[String(r.name ?? r.contact_name ?? "").trim().toLowerCase(),
      String(r.email ?? r.contact_email ?? "").trim().toLowerCase(),r.created_at ?? ""];
    compare(`contacts:${checks.length}`,a.map(identity),b.map(identity));
  }
  // Bound answers to at most 8 requests total, below documented 10/hour.
  // Run only once in a quiet hour; shared-account quota may already be consumed.
  const answers="/questions/0d0ab5f1-fa6c-46af-849f-2081f65d9af3/answers";
  const cutoff=Date.now()-2*86400_000;
  const a=await collect(readDirect,answers,25,4,cutoff);
  const b=await collect(legacy,answers,25,4,cutoff);
  const completion=(r:Record<string,unknown>)=>[String(r.contact_name ?? r.name ?? "").trim(),
    String(r.contact_email ?? r.email ?? "").trim().toLowerCase(),r.created_at ?? r.createdAt ?? ""];
  compare("recent-virtual-pm-completions",a.map(completion),b.map(completion));
  const passed=checks.every(c=>c.match);
  const receipt={at:new Date().toISOString(),passed,checks,directCalls,zapierCalls,
    candidateWrites:0,emailSends:0,productionSwitch:false};
  if(process.env.VIDEOASK_PARITY_RECEIPT) await writeFile(process.env.VIDEOASK_PARITY_RECEIPT,JSON.stringify(receipt,null,2)+"\n");
  console.log(JSON.stringify(receipt,null,2));
  if(!passed) process.exitCode=1;
}
main().catch(()=>{console.error("Read-only comparison failed or incomplete. No recruiting switch. Upstream bodies suppressed.");process.exitCode=1;});
