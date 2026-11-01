import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoaskReader, videoaskReadUrl } from "../../api/_videoask-direct.js";

const credentials = () => ({ clientId: "test-client", clientSecret: "secret-never-log", refreshToken: "refresh-never-log" });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const oauth = () => json({ access_token: "access-never-log", expires_in: 86400 });
const page = { results: [{ name: "Fixture Candidate", email: "fixture@example.test" }], next: null };
const question = "/questions/0d0ab5f1-fa6c-46af-849f-2081f65d9af3/answers?limit=25&offset=0";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("direct VideoAsk transport", () => {
  it.each(["https://evil.test/forms", "//evil.test/forms", "/respondents", "/forms?token=secret", "/forms?limit=0", "/forms?limit=101", "/forms?offset=-1", "/forms?limit=2&limit=3", "/forms#fragment", "/questions/other/answers"])("rejects %s before network access", async path => {
    const fetcher = vi.fn();
    await expect(createVideoaskReader(credentials, fetcher)(path)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("pins organization and performs only GETs after OAuth; concurrent calls share refresh", async () => {
    const fetcher = vi.fn().mockImplementation(async (_url, options) => options.method === "POST" ? oauth() : json(page));
    const read = createVideoaskReader(credentials, fetcher);
    expect(await Promise.all([read("/forms?limit=100"), read(question)])).toEqual([page, page]);
    expect(fetcher.mock.calls.filter(c => c[1].method === "POST")).toHaveLength(1);
    for (const [, options] of fetcher.mock.calls.filter(c => c[1].method === "GET")) {
      expect(options.headers["organization-id"]).toBe("94dc21de-9c4d-4abc-a933-d8324bd853e3");
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });
  it("refreshes expired access credentials", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async (_url, options) => options.method === "POST" ? oauth() : json(page));
    const read = createVideoaskReader(credentials, fetcher);
    await read("/forms");
    vi.setSystemTime(Date.now() + 86400_000);
    await read("/forms");
    expect(fetcher.mock.calls.filter(c => c[1].method === "POST")).toHaveLength(2);
  });
  it("refreshes once on 401, then stops; no Zapier fallback", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(json({},401))
      .mockResolvedValueOnce(oauth()).mockResolvedValueOnce(json({},401));
    await expect(createVideoaskReader(credentials, fetcher)("/forms")).rejects.toThrow("HTTP 401");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([403,404,429,500])("fails closed on HTTP %i without exposing body or retrying", async status => {
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(json({ secret: "private-response" },status));
    await expect(createVideoaskReader(credentials, fetcher)("/forms")).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([null, [], {}, { error: "private-response" }, { results: "invalid" }])("rejects malformed collection %j", async body => {
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(json(body));
    await expect(createVideoaskReader(credentials, fetcher)("/forms")).rejects.toThrow();
  });
  it("accepts a legitimate empty page", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(oauth()).mockResolvedValueOnce(json({results:[],next:null}));
    expect(await createVideoaskReader(credentials, fetcher)("/forms")).toEqual({results:[],next:null});
  });
  it("refuses rotated refresh tokens until durable storage is implemented", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({access_token:"a",expires_in:86400,refresh_token:"rotated"}));
    await expect(createVideoaskReader(credentials, fetcher)("/forms")).rejects.toThrow("durable credential storage");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not turn OAuth failures into empty candidate results", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({error:"private-response"},400));
    await expect(createVideoaskReader(credentials, fetcher)("/forms")).rejects.toThrow("OAuth HTTP 400");
  });
  it("allows current contact pagination", () => {
    expect(videoaskReadUrl("/forms/88fae5e3-2780-4dc9-a167-2a8f9b2bad64/contacts?limit=100&offset=200").origin).toBe("https://api.videoask.com");
  });
});
