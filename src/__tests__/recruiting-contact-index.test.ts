// The incremental contact-index refresh (2026-08-27, Mo's Zapier-task
// directive): pure helpers only — the network paths are exercised live by the
// daily sweep, and every incremental failure mode falls back to the proven
// full rebuild, so what MUST be pinned here is the reasoning the fallback
// cannot save: row identity and page-order detection.
import { describe, expect, it } from "vitest";
import { contactKey, detectPageOrder } from "../../api/recruiting-tools.js";

const row = (n: string, c: string) => ({ n, e: `${n}@x.com`, c, f: "Leasing Agent" });

describe("contactKey", () => {
  it("distinguishes same-name rows by email/created/form and is stable", () => {
    const a = { n: "rocky garza", e: "a@x.com", c: "2026-08-01", f: "Leasing Agent" };
    const b = { ...a, e: "b@x.com" };
    expect(contactKey(a)).not.toEqual(contactKey(b));
    expect(contactKey(a)).toEqual(contactKey({ ...a }));
  });
});

describe("detectPageOrder", () => {
  it("detects newest-first", () => {
    expect(detectPageOrder([row("b", "2026-08-27T10:00:00Z"), row("a", "2026-08-01T10:00:00Z")])).toBe(
      "newest_first",
    );
  });
  it("detects oldest-first", () => {
    expect(detectPageOrder([row("a", "2026-08-01T10:00:00Z"), row("b", "2026-08-27T10:00:00Z")])).toBe(
      "oldest_first",
    );
  });
  it("refuses to guess on a single row, equal stamps, or garbage dates", () => {
    expect(detectPageOrder([row("a", "2026-08-01T10:00:00Z")])).toBe("unknown");
    expect(
      detectPageOrder([row("a", "2026-08-01T10:00:00Z"), row("b", "2026-08-01T10:00:00Z")]),
    ).toBe("unknown");
    expect(detectPageOrder([row("a", "not a date"), row("b", "2026-08-01T10:00:00Z")])).toBe("unknown");
  });
});
