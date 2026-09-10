/**
 * 2026-09-09 — five resumes reached Mo in one afternoon by being emailed to the
 * property (cranbrookmgr@hazelmanagement.com) and forwarded on, sometimes twice
 * (manager → Yuliana → Mo). The daily sweep saw every one of them in the
 * `true_analysis` catch-all and could invite none, because that channel returns
 * a 300-character snippet and these bodies open with the property's own
 * signature block — the candidate's address never fits in the window.
 *
 * These fixtures are the real bodies. The parser has to reach past our own
 * addresses to the deepest From: line, and recover a name when the display name
 * is unusable ("kimm 💓.").
 */
import { describe, it, expect } from "vitest";
import {
  parseForwardedApplicant,
  nameFromResumeSubject,
} from "../../api/recruiting-property-inbox.js";

const SIG = `Sincerely,

*Cranbrook Forest*
13875 Ella Blvd
Houston, TX 77014
*Main:* 281-872-4869
*Email:* Cranbrookmgr@hazelmanagement.com
[image: HOME | Hazel]
`;

const singleForward = (from: string, subject: string, tail = "") => `${SIG}
---------- Forwarded message ---------
From: ${from}
Date: Sat, Aug 29, 2026 at 4:31 PM
Subject: ${subject}
To: <Cranbrookmgr@hazelmanagement.com>

${tail}`;

const doubleForward = (from: string, subject: string) => `---------- Forwarded message ---------
From: CommunityManager <cranbrookmgr@hazelmanagement.com>
Date: Sat, Sep 5, 2026 at 10:19 AM
Subject: Fwd: ${subject}
To: Yuliana Gonzalez <yuliana@hazelmanagement.com>

${SIG}
---------- Forwarded message ---------
From: ${from}
Date: Fri, Sep 4, 2026 at 9:02 PM
Subject: ${subject}
To: <Cranbrookmgr@hazelmanagement.com>

Sent from my iPhone`;

describe("parseForwardedApplicant", () => {
  it("takes the candidate out of a single forward", () => {
    const b = singleForward(
      "Selica Gutierrez <selicagutierrez0@gmail.com>",
      "Selica Gutierrez Resume",
      "Please see attached.",
    );
    expect(parseForwardedApplicant(b, "Fwd: Selica Gutierrez Resume")).toEqual({
      name: "Selica Gutierrez",
      email: "selicagutierrez0@gmail.com",
    });
  });

  it("reaches the DEEPEST sender through a double forward, not Yuliana or the manager", () => {
    const b = doubleForward("Fabian Olarte <gtzcaro8989@gmail.com>", "Daisy Gutierrez Resume");
    const got = parseForwardedApplicant(b, "Fwd: Daisy Gutierrez Resume");
    expect(got?.email).toBe("gtzcaro8989@gmail.com");
    expect(got?.email).not.toContain("hazelmanagement.com");
    expect(got?.email).not.toContain("flatfeelandlord.com");
  });

  it("falls back to the subject when the display name is emoji junk", () => {
    const b = singleForward('"kimm 💓." <kimcoutino23@icloud.com>', "Resume - Kimberly Coutino Asst Manager");
    expect(parseForwardedApplicant(b, "Fwd: Resume - Kimberly Coutino Asst Manager")).toEqual({
      name: "Kimberly Coutino",
      email: "kimcoutino23@icloud.com",
    });
  });

  it("still returns the address when neither the name nor the subject helps", () => {
    const b = singleForward("Adam Garcia <garcia02adam@gmail.com>", "Resume", "Sent from my iPhone");
    const got = parseForwardedApplicant(b, "Fwd: Resume");
    expect(got?.email).toBe("garcia02adam@gmail.com");
    expect(got?.name).toBe("Adam Garcia");
  });

  it("returns null when there is no non-internal sender to find", () => {
    expect(parseForwardedApplicant(SIG, "Fwd: staffing")).toBeNull();
    expect(
      parseForwardedApplicant(
        singleForward("Yuliana Gonzalez <yuli@flatfeelandlord.com>", "Fwd: notes"),
        "Fwd: notes",
      ),
    ).toBeNull();
  });

  it("is not fooled by an address merely mentioned in the body", () => {
    const b = `${SIG}\nReach me at someone@example.com if needed.`;
    expect(parseForwardedApplicant(b, "Fwd: hello")).toBeNull();
  });
});

describe("nameFromResumeSubject", () => {
  it("strips Fwd, the word resume, and role words", () => {
    expect(nameFromResumeSubject("Fwd: Selica Gutierrez Resume")).toBe("Selica Gutierrez");
    expect(nameFromResumeSubject("Resume - Kimberly Coutino Asst Manager")).toBe("Kimberly Coutino");
    expect(nameFromResumeSubject("Fwd: Monica résumé")).toBe("Monica");
  });

  it("gives nothing back for a bare subject", () => {
    expect(nameFromResumeSubject("Fwd: Resume")).toBe("");
    expect(nameFromResumeSubject("")).toBe("");
  });
});
