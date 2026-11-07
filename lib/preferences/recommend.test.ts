import { describe, expect, it } from "vitest";
import { CHOICES, recommend, STYLES, WEIGHTS, type ChoiceId } from "./recommend";
import { applyActions, DEFAULT_PREFS, sanitize } from "./schema";

describe("recommend: transparent rules", () => {
  it("nothing ticked means no suggestion", () => expect(recommend([])).toBeNull());

  it("single choices lead to the expected style", () => {
    const cases: [ChoiceId, string][] = [
      ["lessInfo", "calm"],
      ["moreVisual", "visual"],
      ["moreDetail", "detailed"],
      ["voiceFirst", "voice"],
      ["stepByStep", "calm"],
    ];
    for (const [c, style] of cases) expect(recommend([c])?.style, c).toBe(style);
  });

  it("scores add up exactly as the published table says", () => {
    const r = recommend(["largerText", "voiceFirst", "stepByStep"])!;
    expect(r.scores).toEqual({ calm: 3, visual: 0, detailed: 0, voice: 5 });
    expect(r.style).toBe("voice");
    expect(r.reasons).toEqual([
      { label: "Larger text", points: 1 },
      { label: "Step-by-step explanations", points: 1 },
      { label: "Talking to Dial instead of tapping", points: 3 },
    ]);
  });

  it("ties go to the calmest style, deterministically", () => {
    const r = recommend(["paymentsProminent"])!; // calm 1, detailed 1
    expect(r.style).toBe("calm");
    expect(recommend(["paymentsProminent"])).toEqual(r);
  });

  it("choices with no style points still apply directly and do not appear as reasons", () => {
    const r = recommend(["highContrast", "lessInfo"])!;
    expect(r.style).toBe("calm");
    expect(r.reasons.map((x) => x.label)).toEqual(["Less information on screen"]);
    expect(r.direct).toContain("Stronger contrast");
    expect(applyActions(DEFAULT_PREFS, r.actions).contrast).toBe("high");
  });

  it("only produces allowlisted actions, and marks onboarding done", () => {
    const all = CHOICES.map((c) => c.id);
    const r = recommend(all)!;
    const p = applyActions(DEFAULT_PREFS, r.actions);
    expect(sanitize(p)).toEqual(p);
    expect(p.onboarding).toBe("done");
  });

  it("direct settings win over the style preset", () => {
    const r = recommend(["moreDetail", "lessInfo"])!; // detailed 3 vs calm 3 -> calm (tie, calmest)
    expect(r.style).toBe("calm");
    const r2 = recommend(["moreDetail", "moreVisual", "lessInfo"])!; // visual 4 wins, but lessInfo still asks for calm density
    expect(r2.style).toBe("visual");
    expect(applyActions(DEFAULT_PREFS, r2.actions).layout.density).toBe("calm");
  });
});

describe("recommend: privacy and wording", () => {
  const text = JSON.stringify({ CHOICES, STYLES, WEIGHTS });
  it("never uses diagnostic, condition, age or vulnerability language", () => {
    expect(text).not.toMatch(/disab|impair|condition|dyslex|autis|adhd|neuro|dementia|anxiety|mental|vulnerab|elderly|older|senior|age\b|blind|deaf/i);
  });
  it("takes only the ticked choices as input (no account or transaction data)", () => {
    expect(recommend.length).toBe(1);
  });
});
