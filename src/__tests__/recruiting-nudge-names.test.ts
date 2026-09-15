/**
 * 2026-09-15 — regression guard for the "first name only" nudge escalations.
 *
 * The 9/15 sweep reported four candidates five days past their invite with no
 * nudge sent: "their invite records only have a first name, so the system
 * can't complete the confirmation check." Root cause was on OUR side, twice:
 *   1. send_recruiting_invite put a bare address in the To header, so the
 *      nudge pass could never recover a surname from our own Sent mail (the
 *      body greeting is only "Hi First,");
 *   2. send_videoask_reminder hard-required last_name, so those candidates
 *      were un-nudgeable and got escalated to Mo as a chore.
 * These tests pin the fixes: full name in the To header, surname resolution
 * from send receipts, and a tool schema/prompt that no longer treats a missing
 * surname as a human problem.
 */
import { describe, it, expect } from "vitest";
import { formatToHeader, splitFullName } from "../../api/recruiting-tools.js";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mcpSource = readFileSync(join(here, "../../api/recruiting-mcp.ts"), "utf8");

describe("formatToHeader — invites carry the full name", () => {
  it("puts First Last as the display name", () => {
    expect(formatToHeader("Chelsie", "Blake", "cblake822@gmail.com")).toBe(
      '"Chelsie Blake" <cblake822@gmail.com>',
    );
  });

  it("falls back to the bare address when there is no name", () => {
    expect(formatToHeader("", undefined, "a@b.c")).toBe("a@b.c");
  });

  it("uses first name alone when the surname is missing", () => {
    expect(formatToHeader("Josué", undefined, "j@x.io")).toMatch(/<j@x\.io>$/);
  });

  it("strips header-breaking characters instead of sending them", () => {
    const h = formatToHeader('Eve "X"', "<Smith>\r\n", "e@x.io");
    expect(h).toBe('"Eve X Smith" <e@x.io>');
    expect(h.split(" <")[0]).not.toMatch(/[\r\n<>]/);
  });

  it("RFC 2047-encodes non-ASCII names so they render correctly", () => {
    expect(formatToHeader("José", "Núñez", "j@x.io")).toMatch(/^=\?UTF-8\?B\?.+\?= <j@x\.io>$/);
  });
});

describe("splitFullName — never invents a surname", () => {
  it("splits a two-part name", () => {
    expect(splitFullName("Chelsie Blake")).toEqual({ first: "Chelsie", last: "Blake" });
  });
  it("takes the last token as the surname for longer names", () => {
    expect(splitFullName("Mary Ann Ortiz")).toEqual({ first: "Mary", last: "Ortiz" });
  });
  it("returns first only for a single token", () => {
    expect(splitFullName("Josué")).toEqual({ first: "Josué" });
  });
  it("returns nothing for blank input", () => {
    expect(splitFullName("")).toEqual({});
    expect(splitFullName(undefined)).toEqual({});
  });
});

describe("send_videoask_reminder no longer requires a surname", () => {
  it("tool schema requires only email + first_name", () => {
    const block = mcpSource.slice(
      mcpSource.indexOf('name: "send_videoask_reminder"'),
      mcpSource.indexOf('name: "send_watchdog_alert"'),
    );
    expect(block).toContain('required: ["email", "first_name"]');
    expect(block).not.toContain('required: ["email", "first_name", "last_name"]');
  });

  it("dispatcher passes an absent last_name as undefined, not an empty string", () => {
    expect(mcpSource).toContain('last_name: str(args, "last_name") || undefined');
  });

  it("kickoff prompt tells the agent a missing surname is not a needs-you item", () => {
    expect(DEFAULT_PROMPT).toContain("If last_name is missing, call send_videoask_reminder WITHOUT it");
    expect(DEFAULT_PROMPT).toContain("never a NEEDS YOU item");
    expect(DEFAULT_PROMPT).toContain("Never invent a last name");
  });
});
