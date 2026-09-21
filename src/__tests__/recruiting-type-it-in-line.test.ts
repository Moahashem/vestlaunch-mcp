/**
 * Mo, 2026-09-21: "the links work fine. either people aren't copying and
 * pasting it into their browser or they aren't copying the full url
 * correctly." So every outbound template spells the address out in words
 * under the link. This guards the helper that builds that line.
 */
import { describe, it, expect } from "vitest";
import { typeItInLine } from "../../api/recruiting-tools.js";

describe("typeItInLine", () => {
  it("strips the scheme and www so the address is short enough to type", () => {
    expect(typeItInLine("https://www.videoask.com/fu546koux")).toBe(
      "If the link doesn't open, type videoask.com/fu546koux directly into your browser's address bar.",
    );
  });
  it("keeps a non-www host intact", () => {
    expect(typeItInLine("https://app.testgorilla.com/s/74janjj0")).toContain("app.testgorilla.com/s/74janjj0");
  });
  it("drops a trailing slash", () => {
    expect(typeItInLine("https://www.videoask.com/f4k09mehb/")).toContain("videoask.com/f4k09mehb directly");
  });
});
