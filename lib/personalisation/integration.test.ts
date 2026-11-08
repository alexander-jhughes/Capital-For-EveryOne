// Integration tests for Dial personalisation v2 in the browser: the real preferences schema and events,
// the real catalog, the controller rules, the API response parsing, and the privacy boundaries of the app.
// The server side (database, API, engine) has its own tests in lib/server and lib/recommender.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveState } from "../assistant/live-state";
import { SEED_TRANSACTIONS } from "../data/seed";
import { emit, type ChangeSource, type PrefsEvent } from "../preferences/events";
import { recommend } from "../preferences/recommend";
import { applyActions, DEFAULT_PREFS, type Preferences, sanitize, type UiAction } from "../preferences/schema";
import { CATALOG, configurationActions, conflicts, isActive, isCompatible, ITEM_IDS, type ItemId, nonDefaultDimensions } from "../recommender/catalog";
import { isValidAnswers, QUESTIONS, sanitizeAnswers, sanitizeResearch } from "../recommender/profile";
import { parseStatus, parseSuggestion } from "./client";
import {
  explicitForEvent,
  LEGACY_KEY,
  loadWatch,
  revertedItems,
  revertVia,
  sanitizeWatch,
  saveWatch,
  shouldShowCard,
  signalForViewChange,
  signalsForEvent,
  takeLegacy,
  viewWasChosen,
  WATCH_KEY,
  withoutReverted,
} from "./controller";

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const source = (rel: string) => readFileSync(root(rel), "utf8");

const P: Preferences = { ...DEFAULT_PREFS, onboarding: "done" };
const kept = (actions: UiAction[], src: ChangeSource, before = P): PrefsEvent => ({ kind: "kept", actions, before, after: applyActions(before, actions), source: src });

describe("signals (only kept Settings and Voice changes, and opening Voice Mode)", () => {
  it("counts kept Settings and Voice display changes per the published rules", () => {
    expect(signalsForEvent(kept([{ type: "textSize", value: 150 }], "settings"))).toEqual([{ id: "textLarger", source: "settings" }]);
    expect(signalsForEvent(kept([{ type: "textSize", value: 100 }], "voice", { ...P, textSize: 150 }))).toEqual([{ id: "textSmaller", source: "voice" }]);
    expect(signalsForEvent(kept([{ type: "density", value: "calm" }], "settings"))).toEqual([{ id: "lessOnScreen", source: "settings" }]);
    expect(signalsForEvent(kept([{ type: "hide", widget: "recent" }], "settings"))).toEqual([{ id: "lessOnScreen", source: "settings" }]);
    expect(signalsForEvent(kept([{ type: "show", widget: "chart" }, { type: "moveToTop", widget: "chart" }], "voice")).map((s) => s.id)).toEqual(["moreVisual", "moreVisual"]);
    expect(signalsForEvent(kept([{ type: "show", widget: "recent" }], "settings"))).toEqual([{ id: "moreDetail", source: "settings" }]);
  });

  it("never counts Make it yours styles, Dial's own suggestions, onboarding, untagged changes, no-op changes or resets", () => {
    for (const src of ["style", "ml", "other"] as const) expect(signalsForEvent(kept([{ type: "textSize", value: 150 }], src))).toEqual([]);
    expect(signalsForEvent(kept([{ type: "onboarding", value: "done" }], "settings"))).toEqual([]);
    expect(signalsForEvent(kept([{ type: "textSize", value: 100 }], "settings"))).toEqual([]);
    expect(signalsForEvent(kept([{ type: "theme", value: "dark" }], "settings"))).toEqual([]);
    expect(signalsForEvent({ kind: "reset", before: P })).toEqual([]);
  });

  it("an undone Settings or Voice change counts once; undoing a kept suggestion does not (it is reported as feedback)", () => {
    expect(signalsForEvent({ kind: "undo", before: P, after: P, undoneSource: "settings" })).toEqual([{ id: "undoneChanges", source: "settings" }]);
    expect(signalsForEvent({ kind: "undo", before: P, after: P, undoneSource: "ml" })).toEqual([]);
    expect(signalsForEvent({ kind: "undo", before: P, after: P, undoneSource: "style" })).toEqual([]);
  });

  it("switching view with the Dial switch maps to more detail or less on screen", () => {
    expect(signalForViewChange("complex")).toBe("moreDetail");
    expect(signalForViewChange("simple")).toBe("lessOnScreen");
  });

  it("listener failures never break preferences", () => {
    const seen: PrefsEvent[] = [];
    const boom = () => {
      throw new Error("boom");
    };
    emit([boom, (e) => seen.push(e)], kept([{ type: "contrast", value: "high" }], "settings"));
    expect(seen).toHaveLength(1);
  });
});

describe("explicit settings always win", () => {
  it("Settings, Voice and Make it yours changes are explicit; a style also chooses the view; Dial's suggestions and resets are not", () => {
    expect(explicitForEvent(kept([{ type: "textSize", value: 125 }, { type: "moveToTop", widget: "bill" }], "settings")).sort()).toEqual(["homeFocus", "textSize"]);
    expect(explicitForEvent(kept([{ type: "voiceFirst", value: true }], "voice"))).toEqual(["voiceFirst"]);
    expect(explicitForEvent(kept([{ type: "density", value: "calm" }], "style")).sort()).toEqual(["density", "view"]);
    expect(explicitForEvent(kept([{ type: "contrast", value: "high" }], "ml"))).toEqual([]);
    expect(explicitForEvent(kept([{ type: "contrast", value: "high" }], "other"))).toEqual([]);
    expect(explicitForEvent({ kind: "reset", before: P })).toEqual([]);
  });

  it("a view chosen with the Dial switch, even before consent, counts as explicit", () => {
    expect(viewWasChosen("cfe-prefs=x; cfe-mode=simple")).toBe(true);
    expect(viewWasChosen("cfe-mode=complex")).toBe(true);
    expect(viewWasChosen("cfe-prefs=x; not-cfe-mode=1")).toBe(false);
    expect(viewWasChosen("")).toBe(false);
  });

  it("any non-default setting counts as explicit, so the server never suggests over it", () => {
    expect(nonDefaultDimensions(DEFAULT_PREFS)).toEqual([]);
    const p = applyActions(DEFAULT_PREFS, [{ type: "textSize", value: 150 }, { type: "contrast", value: "high" }, { type: "emphasize", widget: "bill" }]);
    expect(nonDefaultDimensions(p).sort()).toEqual(["contrast", "homeFocus", "textSize"]);
  });
});

describe("catalog: every suggestion is a real, previewable setting", () => {
  it("each item's actions apply cleanly and put the item in effect, in either view", () => {
    for (const id of ITEM_IDS) {
      for (const view of ["simple", "complex"] as const) {
        const { actions, mode } = configurationActions([id]);
        const after = applyActions(P, actions);
        expect(sanitize(after), id).toEqual(after);
        expect(isActive(id, after, mode ?? view), `${id} in ${view}`).toBe(true);
      }
    }
  });

  it("never suggests lowering an accessibility setting or changing the theme", () => {
    const all = ITEM_IDS.flatMap((id) => CATALOG[id].actions);
    expect(all.some((a) => a.type === "textSize" && a.value === 100)).toBe(false);
    expect(all.some((a) => a.type === "contrast" && a.value === "standard")).toBe(false);
    expect(all.some((a) => a.type === "motion" && a.value === "system")).toBe(false);
    expect(all.some((a) => a.type === "theme" || a.type === "reset" || a.type === "hide")).toBe(false);
  });

  it("compatibility: one value per dimension, no listed conflicts, at most four changes", () => {
    expect(conflicts("textSize.125", "textSize.150")).toBe(true);
    expect(conflicts("view.detailed", "density.calm")).toBe(conflicts("density.calm", "view.detailed"));
    expect(isCompatible(["view.detailed", "density.calm"])).toBe(false);
    expect(isCompatible(["textSize.125", "density.calm", "motion.reduced", "targets.large"])).toBe(true);
    expect(isCompatible(["textSize.125", "density.calm", "motion.reduced", "targets.large", "contrast.high"])).toBe(false);
  });
});

describe("kept suggestions: undoing one later counts as a no, once", () => {
  const after = applyActions(P, configurationActions(["textSize.125", "density.calm"]).actions);
  const watch = [{ id: "r1", items: ["textSize.125", "density.calm"] as ItemId[] }];

  it("nothing is reported while the kept items are in effect", () => {
    expect(revertedItems(watch, after, "simple")).toEqual([]);
  });

  it("an item changed back is reported with how it was undone, then forgotten", () => {
    const back = applyActions(after, [{ type: "density", value: "standard" }]);
    const gone = revertedItems(watch, back, "simple");
    expect(gone).toEqual([{ id: "r1", items: ["density.calm"] }]);
    expect(withoutReverted(watch, gone)).toEqual([{ id: "r1", items: ["textSize.125"] }]);
    expect(revertVia({ kind: "undo", before: after, after: back, undoneSource: "ml" })).toBe("undo");
    expect(revertVia({ kind: "reset", before: after })).toBe("reset");
    expect(revertVia(null)).toBe("settings");
  });

  it("stored watch lists are rebuilt from untrusted data", () => {
    expect(sanitizeWatch([{ id: "a", items: ["textSize.125", "nope", "textSize.125"] }, { id: 3 }, "x", { id: "b", items: [] }])).toEqual([{ id: "a", items: ["textSize.125"] }]);
    expect(sanitizeWatch("not a list")).toEqual([]);
  });
});

describe("the Home card", () => {
  it("shows only with consent, a suggestion, after the first-run choice, outside any preview, and not once answered", () => {
    const ok = { consented: true, suggestionId: "s1", onboarding: "done" as const, previewActive: false, answered: new Set<string>() };
    expect(shouldShowCard(ok)).toBe(true);
    expect(shouldShowCard({ ...ok, consented: false })).toBe(false);
    expect(shouldShowCard({ ...ok, suggestionId: null })).toBe(false);
    expect(shouldShowCard({ ...ok, onboarding: "unset" })).toBe(false);
    expect(shouldShowCard({ ...ok, onboarding: "skipped" })).toBe(true);
    expect(shouldShowCard({ ...ok, previewActive: true })).toBe(false);
    expect(shouldShowCard({ ...ok, answered: new Set(["s1"]) })).toBe(false);
  });
});

describe("API responses are parsed defensively", () => {
  const good = {
    id: "rec-1",
    modelVersion: "hybrid-2.0.0",
    trainedOn: "synthetic",
    configuration: {
      items: ["textSize.125", "density.calm"],
      title: "Larger text and less on the home screen",
      offer: "Would you like…?",
      confidence: 0.81,
      evidence: "strong",
      actions: [{ type: "reset" }],
    },
    alternatives: [{ items: ["textSize.125"], confidence: 0.9, evidence: "moderate" }, { items: ["bogus"] }],
    explanation: { summary: "Because of your answers", reasons: ["You said: Just the key facts"] },
    warnings: [
      { code: "synthetic_only", text: "Practice data" },
      { code: "evil", text: "x" },
    ],
  };

  it("preview actions are rebuilt from the catalog, whatever the server sent", () => {
    const s = parseSuggestion(good)!;
    expect(s.configuration.actions).toEqual(configurationActions(["textSize.125", "density.calm"]).actions);
    expect(s.configuration.actions.some((a) => a.type === "reset")).toBe(false);
    expect(s.alternatives.map((a) => a.items)).toEqual([["textSize.125"]]);
    expect(s.warnings.map((w) => w.code)).toEqual(["synthetic_only"]);
  });

  it("unknown items, empty configurations and malformed bodies give no suggestion", () => {
    expect(parseSuggestion({ ...good, configuration: { items: ["textSize.125", "drop table"] } })).toBeNull();
    expect(parseSuggestion({ ...good, configuration: { items: [] } })).toBeNull();
    expect(parseSuggestion(null)).toBeNull();
    expect(parseSuggestion({ ...good, id: 42 })).toBeNull();
  });

  it("status: consent flags and answers are sanitised; anything unreadable means offline", () => {
    const s = parseStatus({ available: true, consent: { personalisation: "granted", collaborative: "declined", research: "unset" }, profile: { answers: { detailLevel: "keyFacts", evil: "x" } } });
    expect(s.consent).toEqual({ personalisation: true, collaborative: false, research: false });
    expect(s.profile).toEqual({ answers: { detailLevel: "keyFacts" }, answered: 1 });
    expect(parseStatus("nope").available).toBe(false);
  });
});

describe("profile", () => {
  it("every question is optional and only allowlisted answers survive", () => {
    expect(sanitizeAnswers({})).toEqual({});
    expect(sanitizeAnswers({ inputMode: "voice", guidance: "sideways", age: "70", income: "low" })).toEqual({ inputMode: "voice" });
    expect(isValidAnswers({ inputMode: "voice" })).toBe(true);
    expect(isValidAnswers({ inputMode: "voice", ageBand: "65+" })).toBe(false);
  });

  it("asks nothing about health, disability, money circumstances or identity; age is separate research data", () => {
    const text = QUESTIONS.map((q) => [q.label, ...q.options.map((o) => o.label)].join(" ")).join(" ");
    expect(text).not.toMatch(/disab|impair|condition|diagnos|health|anxiety|mental|vulnerab|\bage\b|income|debt|afford|gender|ethnic|religio/i);
    expect(QUESTIONS.some((q) => (q.id as string) === "ageBand")).toBe(false);
    expect(sanitizeResearch({ ageBand: "35-49", income: 1 })).toEqual({ ageBand: "35-49" });
  });
});

describe("device storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocked storage never throws: no watch list, nothing saved, legacy check is false", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("SecurityError");
      },
    });
    expect(loadWatch()).toEqual([]);
    expect(() => saveWatch([{ id: "a", items: ["textSize.125"] }])).not.toThrow();
    expect(takeLegacy()).toBe(false);
  });

  it("v1's on-device data is deleted, and whether it had been turned on is reported once", () => {
    const store = new Map<string, string>([[LEGACY_KEY, JSON.stringify({ version: 1, consent: "granted", signals: { textLarger: 2 } })]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) },
    });
    expect(takeLegacy()).toBe(true);
    expect(store.has(LEGACY_KEY)).toBe(false);
    expect(takeLegacy()).toBe(false);
    saveWatch([{ id: "a", items: ["textSize.125"] }]);
    expect(loadWatch()).toEqual([{ id: "a", items: ["textSize.125"] }]);
    saveWatch([]);
    expect(store.has(WATCH_KEY)).toBe(false);
  });
});

describe("privacy boundaries", () => {
  it("the live state sent with Dial questions carries only Spend Pause, purchases and payments", () => {
    const body = liveState(SEED_TRANSACTIONS, { enabled: true, singlePurchaseThreshold: 10000, monthlyBudget: null, quietHours: null });
    expect(Object.keys(body).sort()).toEqual(["payments", "purchases", "spendPause"]);
    expect(JSON.stringify(body)).not.toMatch(/personalis|recommend|signal|consent|answers/i);
  });

  it("the AI backend, assistant client, finance and Gemini code never import personalisation or the recommender", () => {
    const files = ["lib/assistant/client.ts", "lib/assistant/live-state.ts", "lib/ai/ask.ts", "lib/ai/interpreter.ts", "lib/ai/model.ts", "app/api/ask/route.ts", "lib/finance/index.ts"];
    for (const f of files) expect(source(f), f).not.toMatch(/personalisation|recommender/);
    const ask = source("components/assistant/ask-dial.tsx");
    expect(ask.match(/usePersonalisation\(\)/g)).toHaveLength(1);
    expect(ask).toMatch(/const \{ noteVoiceOpened \} = usePersonalisation\(\)/);
  });

  it("browser code never imports the engine, a model file, the database or Gemini", () => {
    const browser = [
      "lib/personalisation/provider.tsx",
      "lib/personalisation/client.ts",
      "lib/personalisation/controller.ts",
      "components/personalise/ml-suggestion.tsx",
      "components/personalise/suggestions-settings.tsx",
      "components/personalise/about-you.tsx",
    ];
    for (const f of browser) {
      const s = source(f);
      expect(s, f).not.toMatch(/recommender\/engine|recommender\/models|model\.json|lib\/server|node:sqlite|@google\/genai|lib\/ai\//);
      expect(s, f).not.toMatch(/from "\.\/index"|personalisation\/index/);
    }
  });

  it("nothing a person sees on the card or in settings names a condition, diagnosis, age, vulnerability or financial circumstance", () => {
    const BANNED = /disab|impair|condition|diagnos|dyslex|autis|adhd|neuro|dementia|anxiety|depress|mental|vulnerab|elderly|older|senior|\bage\b|blind|deaf|struggl|confus|debt|afford|income|poor/i;
    const visible = (s: string) => [...s.matchAll(/>([^<>{}]+)</g), ...s.matchAll(/"([A-Z][^"]{8,})"/g)].map((m) => m[1]).join("\n");
    const card = visible(source("components/personalise/ml-suggestion.tsx"));
    const settings = source("components/personalise/suggestions-settings.tsx");
    // The research switch may say "age band": it describes the separately-consented research question itself.
    const settingsText = visible(settings).replace(/age band/g, "");
    expect(card).not.toMatch(BANNED);
    expect(settingsText).not.toMatch(BANNED);
    expect(card).toMatch(/made-up practice data/);
    expect(visible(settings)).toMatch(/made-up practice data/);
  });

  it("Make it yours (the rules-based fallback) is unchanged and independent of ML", () => {
    const imports = /from "[^"]*(personalisation|recommender)[^"]*"/;
    expect(source("lib/preferences/recommend.ts")).not.toMatch(imports);
    expect(source("components/personalise/make-it-yours.tsx")).not.toMatch(imports);
    expect(recommend(["lessInfo"])?.style).toBe("calm");
    expect(recommend(["voiceFirst", "largerText"])?.style).toBe("voice");
  });
});
