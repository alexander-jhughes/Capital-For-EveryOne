import { beforeAll, describe, expect, it } from "vitest";
import { ITEM_IDS } from "../catalog";
import type { RecommenderInput } from "../types";
import { SIMILAR_PEOPLE_TEXT } from "./explain";
import type { RecommenderModel } from "./model";
import { recommend, scoreItems } from "./recommend";
import { fixtureModel, fixtureSplits, MINIMAL_GUIDED_VOICE } from "./test-world";

let model: RecommenderModel;
beforeAll(() => {
  model = fixtureModel();
}, 60_000);

const NOW = Date.UTC(2026, 9, 1);
const SENSITIVE = /\b(age|aged|old|older|elderly|young|disab\w*|health\w*|income|salary|debt\w*|poor|blind|deaf|impair\w*|condition\w*|vulnerab\w*|ill|illness|medical|dementia|screen reader|benefits?)\b/i;

function allTexts(input: RecommenderInput, m: RecommenderModel = model): string[] {
  const r = recommend(m, input, { now: NOW });
  return [
    r.explanation.summary,
    ...r.explanation.reasons,
    ...r.scores.flatMap((s) => s.reasons.map((x) => x.text)),
    ...[r.configuration, ...r.alternatives].flatMap((c) => (c ? [c.title, c.offer] : [])),
    ...r.warnings.map((w) => w.text),
  ];
}

describe("explanations", () => {
  it("quote the person's own answers back to them", () => {
    const r = recommend(model, MINIMAL_GUIDED_VOICE, { now: NOW });
    expect(r.status).toBe("ok");
    expect(r.explanation.reasons.length).toBeGreaterThan(0);
    expect(r.explanation.reasons.some((t) => t.startsWith('You said "'))).toBe(true);
    expect(r.explanation.summary).toMatch(/may make Dial easier for you/);
  });

  it("only use allowed phrasing: about the person's own choices, never who they are, never sensitive words", () => {
    const people = fixtureSplits().test.people.slice(0, 150);
    for (const p of people) {
      const sensitive = { ...p.first, answers: { ...p.first.answers, screenReader: "yes" as const } };
      for (const t of allTexts(sensitive)) expect(t).not.toMatch(SENSITIVE);
      for (const s of scoreItems(model, sensitive))
        for (const reason of s.reasons) {
          if (reason.kind === "similar_people") expect(reason.text).toBe(SIMILAR_PEOPLE_TEXT.synthetic);
          else expect(reason.text).toMatch(/^You/);
          expect(reason.text).not.toMatch(/\byou are\b|\byou're (a|an|old|young)\b/i);
        }
    }
  });

  it("say clearly that synthetic practice data is made up, and use the real wording only for a model trained with real data", () => {
    const synthetic = scoreItems(model, MINIMAL_GUIDED_VOICE).flatMap((s) => s.reasons).filter((r) => r.kind === "similar_people");
    expect(synthetic.length).toBeGreaterThan(0);
    for (const r of synthetic) expect(r.text).toBe("In Dial's practice data (made-up examples, not real people), most profiles with answers like yours kept this");
    expect(recommend(model, MINIMAL_GUIDED_VOICE, { now: NOW }).explanation.summary).toMatch(/practice data/);

    const real = { ...model, trainedOn: "synthetic+real" as const };
    const lines = scoreItems(real, MINIMAL_GUIDED_VOICE).flatMap((s) => s.reasons).filter((r) => r.kind === "similar_people");
    expect(lines.length).toBeGreaterThan(0);
    for (const r of lines) expect(r.text).toBe("Most people with similar answers who tried this kept it");
    for (const t of allTexts(MINIMAL_GUIDED_VOICE, real)) expect(t).not.toMatch(/made-up|practice data/);
  });

  it("never mention similar people without at least 20 of them, and never print a count of other people", () => {
    const m = JSON.parse(JSON.stringify(model)) as RecommenderModel;
    m.collaborative.count = m.collaborative.count.map((row) => row.map((n) => n / 100));
    for (const s of scoreItems(m, MINIMAL_GUIDED_VOICE)) {
      expect(s.support).toBeLessThan(20);
      expect(s.reasons.some((r) => r.kind === "similar_people")).toBe(false);
    }
    for (const s of scoreItems(model, MINIMAL_GUIDED_VOICE)) for (const r of s.reasons) if (r.kind === "similar_people") expect(r.text).not.toMatch(/\d/);
  });

  it("give at most 3 personal reasons per item, strongest first, each a positive contribution", () => {
    for (const s of scoreItems(model, MINIMAL_GUIDED_VOICE)) {
      const personal = s.reasons.filter((r) => r.kind !== "similar_people");
      expect(personal.length).toBeLessThanOrEqual(3);
      for (let i = 1; i < personal.length; i++) expect(personal[i - 1].weight).toBeGreaterThanOrEqual(personal[i].weight);
      for (const r of personal) expect(r.weight).toBeGreaterThan(0);
    }
    expect(ITEM_IDS.length).toBe(16);
  });
});
