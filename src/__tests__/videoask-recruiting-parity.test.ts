import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
const json = (v: unknown) => new Response(JSON.stringify(v));
const email = "fixture@example.test";

it("does not persist a partial index when the pagination cap is reached", async () => {
  for(const key of ["FFL_WORKFORCE_API_KEY","VIDEOASK_CLIENT_ID","VIDEOASK_CLIENT_SECRET","VIDEOASK_REFRESH_TOKEN"]) vi.stubEnv(key,"fixture");
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT","direct");
  let writes=0;
  vi.stubGlobal("fetch",vi.fn(async (input,options)=>{
    const url=new URL(String(input));
    if(url.pathname==="/api/v1/agent/state") {
      if(options.method!=="GET") writes++;
      return json({data:null});
    }
    if(url.hostname==="auth.videoask.com") return json({access_token:"fixture",expires_in:86400});
    if(url.pathname==="/forms") return json({results:[{form_id:"88fae5e3-2780-4dc9-a167-2a8f9b2bad64",title:"Fixture"}],next:null});
    const offset=Number(url.searchParams.get("offset"));
    return json({results:[{name:`Candidate${offset}`,email:`fixture${offset}@example.test`,created_at:"2026-10-01"}],
      next:`https://api.videoask.com${url.pathname}?limit=1&offset=${offset+1}`});
  }));
  const {searchVideoaskContacts}=await import("../../api/recruiting-tools.js");
  await expect(searchVideoaskContacts("Candidate")).rejects.toThrow("refusing partial index");
  expect(writes).toBe(0);
});

it.each([["direct",20],["direct",100],["zapier",20],["zapier",100]] as const)("builds a complete %s index with %i-row pages", async (transport,pageSize) => {
  for(const key of ["FFL_WORKFORCE_API_KEY","VIDEOASK_CLIENT_ID","VIDEOASK_CLIENT_SECRET","VIDEOASK_REFRESH_TOKEN"]) vi.stubEnv(key,"fixture");
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT",transport);
  vi.stubEnv("ZAPIER_RECRUITING_MCP_URL","https://fixture.test/mcp");
  const cacheKey=transport === "direct" ? "videoask_contact_index_direct_v2" : "videoask_contact_index_v2";
  const rows=Array.from({length:205},(_,i)=>({name:`Fixture Candidate${i}`,email:`fixture${i}@example.test`,created_at:"2026-10-01T00:00:00Z"}));
  const offsets:number[]=[];let saved:any;
  vi.stubGlobal("fetch",vi.fn(async (input,options) => {
    const zapier=String(input)==="https://fixture.test/mcp";
    const args=zapier ? JSON.parse(options.body).params.arguments : null;
    // Emulate Zapier: only explicit querystring fields reach the API.
    if(zapier) {expect(args.url).not.toContain("?");expect(args.fail_on_errors).toBe(true);}
    const url=new URL(zapier ? `${args.url}?${new URLSearchParams(args.querystring)}` : String(input));
    const respond=(body:unknown)=>json(zapier?{result:{content:[{type:"text",text:JSON.stringify({results:[{status:200,body}]})}]}}:body);
    if(url.pathname === "/api/v1/agent/state") {
      if(options.method === "GET") {expect(url.searchParams.get("key")).toBe(cacheKey);return json({data:null});}
      saved=JSON.parse(options.body);expect(saved.key).toBe(cacheKey);return json({data:{}});
    }
    if(url.hostname === "auth.videoask.com") return json({access_token:"fixture",expires_in:86400});
    expect(options.method).toBe(zapier?"POST":"GET");
    if(url.pathname === "/forms") return respond({results:[{form_id:"88fae5e3-2780-4dc9-a167-2a8f9b2bad64",title:"Fixture form"}],next:null});
    if(url.pathname.endsWith("/contacts")) {const offset=Number(url.searchParams.get("offset"));offsets.push(offset);return respond({results:rows.slice(offset,offset+pageSize),next:offset+pageSize<rows.length?`https://api.videoask.com${url.pathname}?limit=${pageSize}&offset=${offset+pageSize}`:null});}
    throw new Error("Unexpected route");
  }));
  const {searchVideoaskContacts}=await import("../../api/recruiting-tools.js");
  const result=await searchVideoaskContacts("Candidate204");
  expect(result.hits).toHaveLength(1);
  expect(offsets).toEqual(Array.from({length:Math.ceil(205/pageSize)},(_,i)=>i*pageSize));
  expect(saved.value.contacts).toHaveLength(205);
});

it("refuses an invitation when direct VideoAsk authentication fails, without sending email or writing state", async () => {
  for (const key of ["FFL_WORKFORCE_API_KEY","GMAIL_OAUTH_CLIENT_ID","GMAIL_OAUTH_CLIENT_SECRET","GMAIL_REFRESH_TOKEN",
    "VIDEOASK_CLIENT_ID","VIDEOASK_CLIENT_SECRET","VIDEOASK_REFRESH_TOKEN"]) vi.stubEnv(key,"fixture");
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT","direct");
  const fetcher=vi.fn(async (url,options) => {
    const target=String(url);
    if(target.includes("/api/v1/agent/state")) { expect(options.method).toBe("GET"); return json({data:null}); }
    if(target === "https://oauth2.googleapis.com/token") return json({access_token:"fixture",expires_in:3600});
    if(target.startsWith("https://gmail.googleapis.com/") && (options.method ?? "GET") === "GET") return json({messages:[]});
    if(target === "https://auth.videoask.com/oauth/token") return new Response("private error",{status:401});
    throw new Error("Unexpected side-effect route");
  });
  vi.stubGlobal("fetch",fetcher);
  const {sendRecruitingInvite}=await import("../../api/recruiting-tools.js");
  const result=await sendRecruitingInvite({email,first_name:"Fixture",last_name:"Candidate",role:"Leasing Agent"});
  expect(result.sent).toBe(false);
  expect(result.reason).toContain("Refusing to send without it");
  expect(fetcher.mock.calls.some(([url])=>String(url).includes("/send"))).toBe(false);
});

it.each(["invite", "assessment", "reminder"])("retains same-day duplicate refusal for %s without any email API call", async kind => {
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT", "direct");
  vi.stubEnv("FFL_WORKFORCE_API_KEY", "fixture");
  const fetcher = vi.fn(async (url, options) => {
    expect(String(url)).toContain("/api/v1/agent/state");
    expect(options.method).toBe("GET");
    return json({data:{value:[{email}]}});
  });
  vi.stubGlobal("fetch",fetcher);
  const tools = await import("../../api/recruiting-tools.js");
  const result = kind === "invite" ? await tools.sendRecruitingInvite({email,first_name:"Fixture",last_name:"Candidate",role:"Leasing Agent"})
    : kind === "assessment" ? await tools.sendTestgorillaInvite({email,name:"Fixture Candidate"})
    : await tools.sendVideoaskReminder({email,first_name:"Fixture",last_name:"Candidate"});
  expect(result.sent).toBe(false);
  expect(result.reason).toMatch(/Already/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps paginated completion results identical through direct and Zapier transports, stripping transcripts", async () => {
  const pages = [
    {results:[{contact_name:"Fixture Candidate",contact_email:"FIXTURE@example.test",created_at:"2026-11-01T10:00:00Z",transcript:"must not reach agent"}],next:"https://api.videoask.com/questions/0d0ab5f1-fa6c-46af-849f-2081f65d9af3/answers?limit=20&offset=20"},
    {results:[{contact_name:"Older Candidate",contact_email:"old@example.test",created_at:"2026-10-01T10:00:00Z"}],next:null},
  ];
  vi.stubEnv("ZAPIER_RECRUITING_MCP_URL","https://fixture.test/mcp");
  vi.stubEnv("VIDEOASK_CLIENT_ID","fixture"); vi.stubEnv("VIDEOASK_CLIENT_SECRET","fixture"); vi.stubEnv("VIDEOASK_REFRESH_TOKEN","fixture");
  const requests: string[] = [];
  vi.stubGlobal("fetch",vi.fn(async (url, options) => {
    if (String(url) === "https://auth.videoask.com/oauth/token") return json({access_token:"fixture",expires_in:86400});
    const zapier = String(url) === "https://fixture.test/mcp";
    const args = zapier ? JSON.parse(options.body).params.arguments : null;
    const target = zapier ? `${args.url}?${new URLSearchParams(args.querystring)}` : String(url);
    requests.push(target);
    const page = pages[new URL(target).searchParams.get("offset") === "20" ? 1 : 0];
    if (!zapier) { expect(options.method).toBe("GET"); return json(page); }
    return json({result:{content:[{type:"text",text:JSON.stringify({results:[{status:200,body:page}]})}]}});
  }));
  const {getVideoaskCompleters} = await import("../../api/recruiting-tools.js");
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT","");
  const legacy = await getVideoaskCompleters(undefined,"2026-10-31T00:00:00Z");
  vi.stubEnv("RECRUITING_VIDEOASK_TRANSPORT","direct");
  const direct = await getVideoaskCompleters(undefined,"2026-10-31T00:00:00Z");
  expect(direct).toEqual(legacy);
  expect(direct).toEqual({completers:[{name:"Fixture Candidate",email,completed_at:"2026-11-01T10:00:00Z"}],pages_fetched:2,truncated:false});
  expect(requests.slice(0,2)).toEqual(requests.slice(2));
});


it("summarizes all contact index versions without exposing contact rows in agent state", async () => {
  vi.stubEnv("FFL_WORKFORCE_API_KEY", "fixture");
  const keys = ["videoask_contact_index", "videoask_contact_index_v2", "videoask_contact_index_direct_v2"];
  vi.stubGlobal("fetch", vi.fn(async () => json({data: [
    ...keys.map(key => ({key, value: {updated_at: "2026-11-01", total: 7486, forms: 14, contacts: [{email}]}})),
    {key: "testgorilla_boundary", value: "2026-11-01"},
  ]})));
  const {getRecruitingState} = await import("../../api/recruiting-tools.js");
  const result = await getRecruitingState();
  const state = result.state as Record<string, any>;
  for (const key of keys) {
    expect(state[key].total).toBe(7486);
    expect(state[key].contacts).toBeUndefined();
  }
  expect(JSON.stringify(result)).not.toContain(email);
  expect(state.testgorilla_boundary).toBe("2026-11-01");
});
