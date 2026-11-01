import { describe, expect, it } from "vitest";
import { nextVideoaskPage, videoaskPageRows, videoaskZapierReadArgs } from "../../api/_videoask-pagination.js";
const path="/forms/88fae5e3-2780-4dc9-a167-2a8f9b2bad64/contacts";
describe("VideoAsk continuation",()=>{
  it("passes explicit querystring parameters to Zapier's raw request action",()=>{
    expect(videoaskZapierReadArgs(`${path}?limit=100&offset=200`)).toEqual({
      url:`https://api.videoask.com${path}`,querystring:{limit:"100",offset:"200"},fail_on_errors:true,
    });
  });
  it("follows the actual 20-row continuation after asking for 100",()=>{
    expect(nextVideoaskPage(`${path}?limit=100&offset=0`,`https://api.videoask.com${path}?limit=20&offset=20`))
      .toBe(`${path}?limit=20&offset=20`);
  });
  it.each([null,undefined,""])("ends only without a continuation (%s)",next=>{
    expect(nextVideoaskPage(`${path}?limit=100&offset=0`,next)).toBeNull();
  });
  it.each([
    `https://evil.example${path}?limit=20&offset=20`,
    "/forms?limit=20&offset=20",
    `${path}?limit=20&offset=0`,
    `${path}?limit=20&offset=20&offset=40`,
    `${path}?limit=0&offset=20`,
    `${path}?limit=20&offset=20&token=secret`,
    `${path}?limit=20&offset=-1`,
  ])("rejects unsafe or stalled continuation %s",next=>{
    expect(()=>nextVideoaskPage(`${path}?limit=100&offset=0`,next)).toThrow();
  });
  it("refuses an empty intermediate page",()=>{
    expect(()=>videoaskPageRows({results:[],next:`${path}?limit=20&offset=20`})).toThrow();
    expect(videoaskPageRows({results:[],next:null})).toEqual([]);
  });
  it.each([{}, {results:"bad"},{results:[null]}])("rejects malformed page",page=>{
    expect(()=>videoaskPageRows(page)).toThrow();
  });
});
