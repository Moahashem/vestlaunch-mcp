/**
 * WHO WE ARE WILLING TO GREET BY NAME (2026-08-26).
 *
 * A candidate finished the Virtual PM video screening on 8/25 and typed their
 * email address into the VideoAsk name field. The agent would not send them
 * "Hi klau24_1198@hotmail.com," — correctly — so the skills assessment simply
 * never went out, and a real candidate stalled on a typo.
 *
 * greetableFirstName() decides that: a real first name, or null → "Hi there,".
 * It guards the ASSESSMENT send only. sendRecruitingInvite and
 * sendVideoaskReminder still refuse a bad name outright, because their dedup
 * keys off the LAST name — inventing one checks the wrong person (the "Hi C,"
 * incident, 2026-08-20). Those refusals are deliberate; do not "fix" them here.
 */
import { describe, it, expect } from "vitest";
import { greetableFirstName } from "../../api/recruiting-tools.js";

describe("greetableFirstName", () => {
  it("takes the first word of a real name", () => {
    expect(greetableFirstName("Fernanda janet Zuloaga")).toBe("Fernanda");
    expect(greetableFirstName("  Keny   Melendez ")).toBe("Keny");
  });

  it("accepts names with accents, apostrophes and hyphens", () => {
    expect(greetableFirstName("Renée Dubois")).toBe("Renée");
    expect(greetableFirstName("O'Brien")).toBe("O'Brien");
    expect(greetableFirstName("Anne-Marie Hall")).toBe("Anne-Marie");
  });

  it("refuses an email address in the name field — the 8/26 case", () => {
    expect(greetableFirstName("klau24_1198@hotmail.com")).toBeNull();
  });

  it("refuses junk that is not a name", () => {
    expect(greetableFirstName("")).toBeNull();
    expect(greetableFirstName("   ")).toBeNull();
    expect(greetableFirstName("C")).toBeNull(); // the "Hi C," incident
    expect(greetableFirstName("klau24_1198")).toBeNull(); // digits + underscore
    expect(greetableFirstName("555")).toBeNull();
    expect(greetableFirstName("---")).toBeNull();
  });
});
