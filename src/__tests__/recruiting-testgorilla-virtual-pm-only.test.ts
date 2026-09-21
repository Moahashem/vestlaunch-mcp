/**
 * Mo's ruling, 2026-09-21: the automated skills-assessment (TestGorilla) stage
 * is for the Virtual PM questionnaire ONLY. Assistant Community Manager,
 * Leasing Agent, Community Manager, Sales and Executive Assistant completers
 * are his manual pipeline (he reviews the video → video call → sends the test
 * himself).
 *
 * Why: on 9/20 and 9/21 the sweep put three ACM completers under NEEDS YOU as
 * "never received the skills-assessment link" and "no address to reach them".
 * Neither was true — they were never in this stage's universe, and all three
 * had emails on their VideoAsk contact records. Two mornings of chore for Mo
 * over a non-problem.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt.js";
import {
  assertTestgorillaQuestion,
  TESTGORILLA_QUESTION_IDS,
} from "../../api/recruiting-tools.js";

const VIRTUAL_PM_QID = "0d0ab5f1-fa6c-46af-849f-2081f65d9af3";

describe("TestGorilla stage is Virtual PM only (Mo 2026-09-21)", () => {
  it("the allowlist holds exactly the Virtual PM screening question", () => {
    expect([...TESTGORILLA_QUESTION_IDS]).toEqual([VIRTUAL_PM_QID]);
  });

  it("no question_id → the Virtual PM question", () => {
    expect(assertTestgorillaQuestion(undefined)).toBe(VIRTUAL_PM_QID);
    expect(assertTestgorillaQuestion("")).toBe(VIRTUAL_PM_QID);
    expect(assertTestgorillaQuestion(`  ${VIRTUAL_PM_QID} `)).toBe(VIRTUAL_PM_QID);
  });

  it("any other question is refused with the rule spelled out", () => {
    expect(() => assertTestgorillaQuestion("some-acm-question-id")).toThrow(
      /Virtual PM questionnaire ONLY/,
    );
    expect(() => assertTestgorillaQuestion("some-acm-question-id")).toThrow(
      /never a NEEDS YOU item/,
    );
  });
});

describe("kickoff prompt teaches the 9/21 lessons", () => {
  it("names the manual-pipeline questionnaires and forbids flagging their completers", () => {
    expect(DEFAULT_PROMPT).toContain("VIRTUAL PM ONLY (Mo's ruling, 2026-09-21)");
    expect(DEFAULT_PROMPT).toContain("never pass a question_id");
    expect(DEFAULT_PROMPT).toContain("Assistant Community Manager, Leasing Agent, Community Manager,");
    expect(DEFAULT_PROMPT).toContain("MANUAL pipeline");
    expect(DEFAULT_PROMPT).toContain("NEVER a NEEDS YOU item");
  });

  it("forbids 'no address' claims without a search_videoask_contacts lookup", () => {
    expect(DEFAULT_PROMPT).toContain("NO-ADDRESS CLAIMS");
    expect(DEFAULT_PROMPT).toContain("search_videoask_contacts by their LAST NAME");
    expect(DEFAULT_PROMPT).toContain("Never reason");
  });

  it("stops yesterday's needs-you item being re-reported as new", () => {
    expect(DEFAULT_PROMPT).toContain("REPEATS:");
    expect(DEFAULT_PROMPT).toContain("still open since <date>");
  });
});
