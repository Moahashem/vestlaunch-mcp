/**
 * record_tour_outcome (Mo, 2026-09-16): a person's loose spelling in
 * RingCentral — "Walter", "walter b", "Jameisha Rogers" — has to land on
 * exactly one unrecorded tour or the tool must ASK, never guess. Show rate is
 * a human observation; the wrong card is worse than no card.
 */
import { describe, it, expect } from "vitest";
import { matchUnrecordedTour } from "../../api/mcp.js";

const roster = [
  { conversationId: "c1", name: "Jameisha Rogers" },
  { conversationId: "c2", name: "Walter BAQUEDANO" },
  { conversationId: "c3", name: "Annia lopez" },
  { conversationId: "c4", name: "Jade Renderos" },
  { conversationId: "c5", name: "Ashanti Muriel" },
  { conversationId: "c6", name: "Aallannah Johnson" },
  { conversationId: "c7", name: null },
];

describe("matchUnrecordedTour", () => {
  it("exact full name wins regardless of case", () => {
    expect(matchUnrecordedTour("walter baquedano", roster).match?.conversationId).toBe("c2");
  });
  it("a unique first name matches", () => {
    expect(matchUnrecordedTour("Jameisha", roster).match?.conversationId).toBe("c1");
    expect(matchUnrecordedTour("Walter", roster).match?.conversationId).toBe("c2");
  });
  it("first name + surname initial matches", () => {
    expect(matchUnrecordedTour("walter b", roster).match?.conversationId).toBe("c2");
    expect(matchUnrecordedTour("Jade R.", roster).match?.conversationId).toBe("c4");
  });
  it("ambiguous prefix returns candidates and no match", () => {
    const r = matchUnrecordedTour("A", roster); // Annia, Ashanti, Aallannah
    expect(r.match).toBeUndefined();
    expect(r.candidates.map((c) => c.conversationId).sort()).toEqual(["c3", "c5", "c6"]);
  });
  it("unknown name returns no match and no candidates", () => {
    const r = matchUnrecordedTour("Belkis", roster);
    expect(r.match).toBeUndefined();
    expect(r.candidates).toEqual([]);
  });
  it("accents and punctuation do not block a match", () => {
    expect(matchUnrecordedTour("Ánnia López", roster).match?.conversationId).toBe("c3");
  });
  it("empty input matches nothing", () => {
    expect(matchUnrecordedTour("   ", roster)).toEqual({ candidates: [] });
  });
});
