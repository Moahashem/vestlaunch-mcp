/**
 * The Monica Reyna incident, 2026-09-20.
 *
 * Timeline (all real):
 *   9/09  Mo hand-sends the invite: "Next step for the Assistant Property Manager role - Cranbrook Forest"
 *   9/12  Monica replies in-thread: link expired, very interested
 *   9/19  Mo replies in-thread ("Re: Next step for the…") + two more hand-written emails
 *   9/20  08:34 CT the sweep sends her the generic "Quick nudge" template.
 *
 * The old guard only counted replies newer than the NEWEST "Next step for the"
 * mail in Sent; Mo's 9/19 in-thread reply carried that marker, so it read as a
 * fresh invite and Monica's 9/12 reply "predated the invite". The rule now:
 * any reply from the candidate, or any hand-written mail from Mo, is a live
 * conversation and the tool refuses.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT } from "../../api/cron/_recruiting-sweep-prompt.js";
import { isAutomatedTemplateSubject, liveConversationReason } from "../../api/recruiting-tools.js";

const INVITE = "Next step for the Assistant Property Manager role - Cranbrook Forest";
const msg = (subject: string, receivedAt: string, snippet = "") => ({ subject, receivedAt, snippet });

describe("isAutomatedTemplateSubject", () => {
  it("recognises our three templates verbatim", () => {
    expect(isAutomatedTemplateSubject(INVITE)).toBe(true);
    expect(isAutomatedTemplateSubject("Quick nudge - your Flat Fee Landlord video questionnaire")).toBe(true);
    expect(
      isAutomatedTemplateSubject("Your Flat Fee Landlord application - next step: skills assessment"),
    ).toBe(true);
  });
  it("a Re:/Fwd: of anything is a human, even of our own invite", () => {
    expect(isAutomatedTemplateSubject(`Re: ${INVITE}`)).toBe(false);
    expect(isAutomatedTemplateSubject(`RE: ${INVITE}`)).toBe(false);
    expect(isAutomatedTemplateSubject("Fwd: resume")).toBe(false);
  });
  it("any other subject is a human", () => {
    expect(isAutomatedTemplateSubject("Re: the questionnaire link - type this one in")).toBe(false);
    expect(isAutomatedTemplateSubject("")).toBe(false);
    expect(isAutomatedTemplateSubject(undefined)).toBe(false);
  });
});

describe("liveConversationReason — Monica's timeline", () => {
  const monicaReply = msg(`Re: ${INVITE}`, "2026-09-12T19:26:37Z", "I clicked on the link but it had already expired");
  const moInvite = msg(INVITE, "2026-09-09T20:49:03Z");
  const moReplyInThread = msg(`Re: ${INVITE}`, "2026-09-19T23:24:14Z", "You were right - that link was broken");
  const moTypeThisIn = msg("Re: the questionnaire link - type this one in", "2026-09-19T23:26:17Z");

  it("9/20 morning: refuses, and it is NOT an email-reply-waiting item — Mo already answered", () => {
    const r = liveConversationReason("Monica Reyna", [monicaReply], [moInvite, moReplyInThread, moTypeThisIn]);
    expect(r).not.toBeNull();
    expect(r!.sent).toBe(false);
    expect(r!.reason).toMatch(/ALREADY ANSWERED/);
    expect(r!.reason).toMatch(/nothing for NEEDS YOU/);
  });

  it("9/16 morning (before Mo answered): refuses as WROTE BACK → needs-you reply waiting", () => {
    const r = liveConversationReason("Monica Reyna", [monicaReply], [moInvite]);
    expect(r!.reason).toMatch(/WROTE BACK/);
    expect(r!.reason).toMatch(/NEEDS YOU/);
  });

  it("the old failure mode: a reply older than Mo's in-thread reply still counts", () => {
    // Only Sent mail visible is the in-thread "Re:" — the guard must not treat it as a fresh invite.
    const r = liveConversationReason("Monica Reyna", [monicaReply], [moReplyInThread]);
    expect(r).not.toBeNull();
  });

  it("no reply, but Mo wrote by hand → refuse, log item", () => {
    const r = liveConversationReason("Someone", [], [moInvite, moTypeThisIn]);
    expect(r!.reason).toMatch(/wrote to Someone by hand/);
    expect(r!.reason).toMatch(/Nothing for NEEDS YOU/);
  });

  it("only our automated templates in Sent and no reply → nudge may proceed", () => {
    const tg = msg("Your Flat Fee Landlord application - next step: skills assessment", "2026-09-10T00:00:00Z");
    expect(liveConversationReason("Someone", [], [moInvite, tg])).toBeNull();
  });
});

describe("prompt routes the new refusals", () => {
  it("'Mo has ALREADY ANSWERED' is a log item, never needs-you", () => {
    expect(DEFAULT_PROMPT).toContain("Mo has ALREADY ANSWERED");
    expect(DEFAULT_PROMPT).toContain("NEVER a NEEDS YOU");
  });
  it("expired-link complaints are not 'the link is broken'", () => {
    expect(DEFAULT_PROMPT).toContain("the links work");
  });
});
