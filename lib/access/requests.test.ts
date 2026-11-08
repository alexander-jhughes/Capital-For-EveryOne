// Real requests through the same decision the Dial session makes (components/dial/session.tsx), with the real
// on-device model: ask if contradictory or vague (clarify), else the situation model and the precise rules, the
// situation winning only as session.tsx allows (offeredAdaptation). Typed and spoken requests share this path: voice
// arrives as text from the voice engine, so voice-style transcripts are tested here too.
import { beforeAll, describe, expect, it } from "vitest";
import { nodeEmbed } from "../../scripts/access/embed-node";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { plan } from "../dial/plan";
import { EMPTY_CONTEXT, type DialStep } from "../dial/types";
import { paymentReply } from "../payments/dial";
import type { TextSize, UiAction } from "../preferences/schema";
import { spendPauseReply } from "../spend-pause/dial";
import { splitCorrection } from "../voice/correction";
import type { SituationId } from "./catalogue";
import { clarify } from "./clarify";
import { adaptationFor, offeredAdaptation } from "./pipeline";
import { buildIndex, changesFor, type Embed, type ExampleIndex } from "./understand";

let brain: { embed: Embed; index: ExampleIndex };
beforeAll(async () => {
  const embed = nodeEmbed();
  brain = { embed, index: await buildIndex(embed) };
}, 120_000);

type Outcome =
  | { kind: "clarify"; question: string }
  | { kind: "adapt"; situations: SituationId[]; tentative: boolean; actions: UiAction[] }
  | { kind: "steps"; steps: DialStep[]; actions: UiAction[] };

async function route(text: string, textSize: TextSize = 100): Promise<Outcome> {
  const question = splitCorrection(text) ? null : clarify(text);
  if (question) return { kind: "clarify", question };
  const found = await adaptationFor(text, brain);
  const { steps } = plan(
    { text },
    {
      context: EMPTY_CONTEXT,
      textSize,
      merchants: [...new Set(SEED_TRANSACTIONS.map((t) => t.merchant))],
      transactionIds: SEED_TRANSACTIONS.map((t) => t.id),
      months: ["2026-09", "2026-10", "2026-11"],
      today: "2026-11-08",
      localReply: (q) => {
        const sp = spendPauseReply(q, { enabled: true, singlePurchaseThreshold: null, monthlyBudget: 50000, quietHours: null }, { activatedAt: null, deactivatedAt: null });
        if (sp) return { text: sp.text };
        const paid = paymentReply(q, { account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS, payments: [] });
        return paid ? { text: paid } : null;
      },
    },
  );
  const gaveUp = steps.length > 0 && steps.every((s) => s.type === "unsupported");
  const a = offeredAdaptation(found, gaveUp);
  if (a) return { kind: "adapt", situations: a.situations, tentative: a.tentative, actions: changesFor(a.situations).map((c) => c.action) };
  return { kind: "steps", steps, actions: steps.flatMap((s) => (s.type === "preferences" ? s.actions : [])) };
}

const has = (o: Outcome, action: Partial<UiAction>) => o.kind !== "clarify" && o.actions.some((a) => Object.entries(action).every(([k, v]) => (a as Record<string, unknown>)[k] === v));
const changesNothing = (o: Outcome) => o.kind === "steps" && o.actions.length === 0 && !o.steps.some((s) => s.type === "setMode");

describe("the brief's requests (real model)", () => {
  const cases: [string, Partial<UiAction>][] = [
    ["Make everything bigger.", { type: "textSize", value: 125 }],
    ["Everything is too small.", { type: "textSize", value: 125 }],
    ["Make the app easier to read.", { type: "textSize", value: 125 }],
    ["I can't see the text.", { type: "contrast", value: "high" }],
    ["I can't read this dashboard properly.", { type: "textSize", value: 125 }],
    ["This screen is overwhelming.", { type: "density", value: "calm" }],
    ["There's too much going on here.", { type: "density", value: "calm" }],
    ["Everything feels overwhelming. Simplify the dashboard.", { type: "density", value: "calm" }],
    ["Make the dashboard simpler.", { type: "density", value: "calm" }],
    ["I want fewer things on the screen.", { type: "density", value: "calm" }],
    ["Make the app less complicated.", { type: "density", value: "calm" }],
    ["Use a layout that is easier to understand.", { type: "density", value: "calm" }],
    ["I struggle with small buttons.", { type: "targets", value: "large" }],
    ["I have difficulty tapping small buttons. Make the controls larger.", { type: "targets", value: "large" }],
    ["Make the buttons easier to press.", { type: "targets", value: "large" }],
    ["I don't want animations.", { type: "motion", value: "reduced" }],
    ["I want to use voice instead.", { type: "voiceFirst", value: true }],
    ["Give me a voice-first experience.", { type: "voiceFirst", value: true }],
    ["Make the important information stand out.", { type: "emphasize", widget: "bill" }],
    ["Can you make it easier to navigate?", { type: "focusRing", value: "strong" }],
    ["Make this application easier to navigate without using a mouse.", { type: "focusRing", value: "strong" }],
    ["I can't use a mouse", { type: "focusRing", value: "strong" }],
  ];
  for (const [text, action] of cases)
    it(text, async () => {
      const o = await route(text);
      expect(has(o, action), JSON.stringify(o)).toBe(true);
    });

  it("I changed my mind. -> undo (a preview showing is withdrawn, see runner.test.ts)", async () => {
    const o = await route("I changed my mind.");
    expect(o).toMatchObject({ kind: "steps", steps: [{ type: "control", command: "undo" }] });
  });

  it("Switch to Simple Mode / Read this explanation aloud use the existing controls", async () => {
    expect(await route("Switch to Simple Mode.")).toMatchObject({ steps: [{ type: "setMode", mode: "simple" }] });
    expect(await route("Read this explanation aloud.")).toMatchObject({ steps: [{ type: "control", command: "readPage" }] });
  });

  it("a voice-first request doesn't also switch on everything a screen reader user would want", async () => {
    const o = await route("I want to use voice instead.");
    expect(has(o, { type: "autoRead", value: true })).toBe(false);
  });
});

describe("several changes, voice transcripts and corrections", () => {
  it("does several changes in one request, and asks once", async () => {
    const o = await route("make the text bigger and turn off animations and give everything more space");
    expect(o.kind).toBe("steps");
    if (o.kind !== "steps") return;
    expect(o.steps.filter((s) => s.type === "preferences")).toHaveLength(1);
    for (const a of [{ type: "textSize", value: 125 }, { type: "motion", value: "reduced" }, { type: "spacing", value: "roomy" }] as const) expect(has(o, a)).toBe(true);
  });

  it("understands spoken-style transcripts: no punctuation, fillers, lower case", async () => {
    expect(has(await route("um make the text bigger please"), { type: "textSize", value: 125 })).toBe(true);
    expect(has(await route("i cant see the text"), { type: "contrast", value: "high" })).toBe(true);
    expect(has(await route("uh this screen is overwhelming"), { type: "density", value: "calm" })).toBe(true);
    expect(has(await route("my hands shake so i keep pressing the wrong button"), { type: "targets", value: "large" })).toBe(true);
  });

  it("an interrupted, self-corrected request keeps only the correction", async () => {
    for (const t of ["make the text bigger, no I meant smaller", "make the text bigger um actually smaller"]) {
      const o = await route(t, 150);
      expect(has(o, { type: "textSize", value: 125 }), t).toBe(true);
      expect(has(o, { type: "textSize", value: 200 }), t).toBe(false);
    }
    // Without a pause or filler the shared correction splitter (lib/voice/correction.ts) can't see the correction,
    // so both directions are heard: Dial asks rather than guessing.
    expect(await route("make the text bigger no I meant smaller", 150)).toEqual({ kind: "clarify", question: "Do you want it bigger or smaller?" });
  });
});

describe("ambiguous, conflicting, unsupported and rejected requests", () => {
  it("asks instead of guessing", async () => {
    for (const t of ["make it better", "change it", "make the text bigger and smaller"]) expect((await route(t)).kind, t).toBe("clarify");
  });

  it("a look the app doesn't offer changes nothing (and is never mistaken for colour blindness)", async () => {
    for (const t of ["make the background purple", "use comic sans everywhere", "change the colours to pink"]) expect(changesNothing(await route(t)), t).toBe(true);
  });

  it("never runs CSS or code, and never acts on money from a display request", async () => {
    for (const t of ["run this css: body{display:none}", "<script>alert(1)</script>", "inject javascript into the page"]) expect(changesNothing(await route(t)), t).toBe(true);
    const off = await route("turn off Spend Pause");
    expect(changesNothing(off)).toBe(true);
    expect(off).toMatchObject({ steps: [{ type: "local" }] });
  });

  it("money questions stay money questions, even with display words in them", async () => {
    for (const t of ["how much did I spend at night?", "I can't see my refund", "why is my bill so big?"]) {
      const o = await route(t);
      expect(o.kind, t).toBe("steps");
      expect(changesNothing(o), t).toBe(true);
    }
  });
});
