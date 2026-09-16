/**
 * Mo's rule, 2026-09-16: a candidate who writes back "thanks" / "done" /
 * "videos completed" is NOT a needs-you item. He screens every finisher
 * himself and reaches out only if interested, so a courtesy reply is a
 * headline count, not a conversation for him to answer. Only replies that
 * ask something (question / request / problem — an expired link above all)
 * still land under NEEDS YOU.
 *
 * Before this rule, three courtesy replies in a row (9/14–9/16) each put a
 * "needs you" row on Mission Control that no one could act on.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt.js";

describe("recruiting sweep — courtesy replies are not needs-you (Mo 2026-09-16)", () => {
  it("tells the agent to SORT Indeed replies and keep courtesy ones out of NEEDS YOU", () => {
    expect(DEFAULT_PROMPT).toContain("SORT each reply");
    expect(DEFAULT_PROMPT).toContain("COURTESY reply");
    expect(DEFAULT_PROMPT).toContain("NEVER put them under NEEDS YOU");
    expect(DEFAULT_PROMPT).toContain("courtesy replies, no action");
  });

  it("still routes real questions, requests and problems to Mo", () => {
    expect(DEFAULT_PROMPT).toContain("real question, request or problem");
    expect(DEFAULT_PROMPT).toContain("'the link expired'");
    expect(DEFAULT_PROMPT).toContain("When in doubt, it is a question");
  });

  it("applies the same sort to email WROTE BACK refusals in the nudge pass", () => {
    expect(DEFAULT_PROMPT).toContain("same COURTESY sort as the Indeed replies");
    expect(DEFAULT_PROMPT).toContain("expired or broken link above all");
  });

  it("states why: Mo screens finishers himself and reaches out only if interested", () => {
    expect(DEFAULT_PROMPT).toContain("reaches out only if interested");
  });

  it("the needs-you list no longer names bare Indeed replies as an item", () => {
    expect(DEFAULT_PROMPT).not.toContain("Indeed candidate replies waiting (names + roles, see above),");
    expect(DEFAULT_PROMPT).toContain("courtesy\nreplies are NOT needs-you".replace("\n", " "));
  });
});
