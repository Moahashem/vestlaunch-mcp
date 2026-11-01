import { videoaskReadUrl } from "./_videoask-direct.js";

/** Zapier's raw-request action takes query parameters separately from URL. */
export function videoaskZapierReadArgs(path: string) {
  const url = videoaskReadUrl(path);
  return { url: url.origin + url.pathname,
    querystring: Object.fromEntries(url.searchParams), fail_on_errors: true };
}

/** Follow the server's continuation, not the requested page size. */
export function nextVideoaskPage(current: string, next: unknown): string | null {
  if (next === null || next === undefined || next === "") return null;
  if (typeof next !== "string") throw new Error("Invalid VideoAsk continuation");
  const base = new URL(current, "https://api.videoask.com");
  const target = new URL(next, base);
  if (target.origin !== "https://api.videoask.com" || target.pathname !== base.pathname ||
      target.username || target.password || target.hash) throw new Error("Unsafe VideoAsk continuation");
  for (const [key,value] of target.searchParams) {
    if (!["limit","offset"].includes(key) || !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) || target.searchParams.getAll(key).length !== 1) {
      throw new Error("Invalid VideoAsk continuation parameters");
    }
  }
  const offset = Number(target.searchParams.get("offset"));
  const limit = Number(target.searchParams.get("limit"));
  if (!target.searchParams.has("offset") || offset <= Number(base.searchParams.get("offset") ?? 0) ||
      limit < 1 || limit > 100) throw new Error("VideoAsk continuation did not advance");
  return target.pathname + target.search;
}

export function videoaskPageRows(page: Record<string,unknown>): Record<string,unknown>[] {
  const rows = page.results ?? page.contents ?? page.answers;
  if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== "object" || Array.isArray(r))) {
    throw new Error("Invalid VideoAsk collection page");
  }
  if (!rows.length && page.next) throw new Error("Empty VideoAsk page with continuation");
  return rows;
}
