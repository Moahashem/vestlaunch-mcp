/**
 * INDEED CANDIDATE REPLIES ARE NOT INVITE TARGETS (2026-09-04).
 *
 * Found live: "New Message from <Name> - <Job>" emails are candidates answering
 * inside their Indeed thread. The sweep treated them as fresh applicants,
 * emailed the relay address, and Indeed bounced every send ("[Attention
 * required] Your response wasn't added to the conversation", 1-5 a day since
 * 2026-08-31). The indeed channel now splits replies into `candidate_replies`
 * and sendRecruitingInvite refuses a relay that has ever written to us.
 *
 * Also pins the role mapping for the 2026-09-04 ACM posts: the Indeed and
 * LinkedIn titles are "Assistant Property Manager" and must land on the ACM
 * questionnaire (fu546koux), not Community Manager.
 */
import { describe, it, expect } from "vitest";
import { parseIndeedReply, normalizeRole } from "../../api/recruiting-tools.js";

describe("parseIndeedReply", () => {
  it("splits name and role out of the subject and keeps the relay", () => {
    const r = parseIndeedReply({
      from: "SHINECE LAGRONE-HURD <conversation-yi779s2@indeedemail.com>",
      subject: "New Message from SHINECE LAGRONE-HURD - Assistant Property Manager - Apartment Community (North Houston)",
      snippet: "I haven&#39;t heard back. ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏ ͏",
      receivedAt: "2026-09-02T19:57:17Z",
      id: "1a063b28376e490c",
    });
    expect(r.name).toBe("SHINECE LAGRONE-HURD");
    expect(r.role).toBe("Assistant Property Manager - Apartment Community (North Houston)");
    expect(r.relay_email).toBe("conversation-yi779s2@indeedemail.com");
    expect(r.snippet).toBe("I haven't heard back.");
  });

  it("does not blow up on a subject without the ' - Role' tail", () => {
    const r = parseIndeedReply({
      from: "conversation-abc@indeedemail.com",
      subject: "New Message from Aaron Centeno",
      snippet: "All videos have been completed",
      receivedAt: "",
      id: "x",
    });
    expect(r.name).toBe("Aaron Centeno");
    expect(r.role).toBe("");
  });
});

describe("normalizeRole — 2026-09-04 ACM postings", () => {
  it("maps the Indeed/LinkedIn 'Assistant Property Manager' titles to the ACM questionnaire", () => {
    expect(normalizeRole("Assistant Property Manager - Apartment Community (North Houston)")).toBe(
      "assistant_community_manager",
    );
    expect(normalizeRole("Assistant Property Manager")).toBe("assistant_community_manager");
    expect(normalizeRole("Assistant Community Manager - Apartment Community (North Houston)")).toBe(
      "assistant_community_manager",
    );
  });
  it("keeps the remote rule ahead of everything", () => {
    expect(normalizeRole("Virtual Sales Executive (U.S. Real Estate | Remote)")).toBe("virtual_sales");
    expect(normalizeRole("Maintenance Coordinator (U.S. Real Estate | Remote)")).toBe("maintenance_coordinator");
  });
});
