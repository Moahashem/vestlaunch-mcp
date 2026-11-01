import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
const json = (v: unknown) => new Response(JSON.stringify(v));
const email = "fixture@example.test";

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
    {results:[{contact_name:"Fixture Candidate",contact_email:"FIXTURE@example.test",created_at:"2026-11-01T10:00:00Z",transcript:"must not reach agent"}],next:"next"},
    {results:[{contact_name:"Older Candidate",contact_email:"old@example.test",created_at:"2026-10-01T10:00:00Z"}],next:null},
  ];
  vi.stubEnv("ZAPIER_RECRUITING_MCP_URL","https://fixture.test/mcp");
  vi.stubEnv("VIDEOASK_CLIENT_ID","fixture"); vi.stubEnv("VIDEOASK_CLIENT_SECRET","fixture"); vi.stubEnv("VIDEOASK_REFRESH_TOKEN","fixture");
  const requests: string[] = [];
  vi.stubGlobal("fetch",vi.fn(async (url, options) => {
    if (String(url) === "https://auth.videoask.com/oauth/token") return json({access_token:"fixture",expires_in:86400});
    const zapier = String(url) === "https://fixture.test/mcp";
    const target = zapier ? JSON.parse(options.body).params.arguments.url : String(url);
    requests.push(target);
    const page = pages[new URL(target).searchParams.get("offset") === "25" ? 1 : 0];
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
