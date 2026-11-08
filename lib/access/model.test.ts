// Runs the real on-device model (from public/models, no network) over both evaluation sets. A guard against a catalogue
// or threshold change quietly making Dial worse. Full report: npm run access:eval (docs/ACCESS-EVALUATION.md).
import { beforeAll, describe, expect, it } from "vitest";
import { nodeEmbed } from "../../scripts/access/embed-node";
import { EVAL_SET, TEST_SET, type EvalCase } from "./eval-set";
import { adaptationFor, offeredAdaptation } from "./pipeline";
import { buildIndex, type Embed, type ExampleIndex } from "./understand";
import { interpret } from "../voice/interpret";

let brain: { embed: Embed; index: ExampleIndex };
beforeAll(async () => {
  const embed = nodeEmbed();
  brain = { embed, index: await buildIndex(embed) };
}, 120_000);

async function offered(c: EvalCase) {
  const a = await adaptationFor(c.text, brain);
  return offeredAdaptation(a, interpret(c.text).kind === "unknown")?.situations ?? [];
}

describe("on-device understanding (real model)", () => {
  it("never turns a money question, command, denial or small talk into a display change", async () => {
    for (const c of [...EVAL_SET, ...TEST_SET].filter((x) => x.expect.length === 0)) expect(await offered(c), c.text).toEqual([]);
  }, 60_000);

  it("recognises at least 80% of described situations exactly, on both sets", async () => {
    for (const set of [EVAL_SET, TEST_SET]) {
      const pos = set.filter((x) => x.expect.length > 0);
      let exact = 0;
      for (const c of pos) {
        const got = await offered(c);
        if (got.length === c.expect.length && c.expect.every((e) => got.includes(e))) exact++;
      }
      expect(exact / pos.length).toBeGreaterThanOrEqual(0.8);
    }
  }, 60_000);

  it("the figures the app shows (lib/access/accuracy.json) are the ones this model actually scores", async () => {
    const shown = (await import("./accuracy.json")).default;
    const pos = TEST_SET.filter((x) => x.expect.length > 0);
    let exact = 0;
    for (const c of pos) {
      const got = await offered(c);
      if (got.length === c.expect.length && c.expect.every((e) => got.includes(e))) exact++;
    }
    expect(shown.recognised).toBe(Math.round((100 * exact) / pos.length));
    expect(shown.sentences).toBe(TEST_SET.length);
    expect(shown.hijacked).toBe(0);
  }, 60_000);

  it("gets the headline demo sentence right, with the night scope", async () => {
    const a = await adaptationFor("I have trouble seeing at night", brain);
    expect(a).toEqual({ situations: ["night_vision"], scope: "night", tentative: false });
  });
});
