// Integration tests for ML suggestions on the adaptive-UI branch: the real preferences schema, the real
// "Make it yours" rules, the trained model, and the controller, driven through the same event sequence
// PreferencesProvider emits (kept / undo / reset; previews emit nothing).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveState } from "../assistant/live-state";
import { SEED_TRANSACTIONS } from "../data/seed";
import { emit, type ChangeSource, type PrefsEvent } from "../preferences/events";
import { CHOICES as RULE_CHOICES, recommend } from "../preferences/recommend";
import { applyActions, DEFAULT_PREFS, sanitize, type Preferences, type UiAction } from "../preferences/schema";
import type { ModelArtifact } from "./artifact";
import { forVisit, onPrefsEvent, reconcile, shouldShowCard } from "./controller";
import { CHOICES } from "./features";
import { type PersonalisationResult, recommendPreferences } from "./infer";
import modelJson from "./model.json";
import {
  BACKOFF_AFTER,
  INITIAL_STATE,
  loadState,
  NEW_VISIT,
  type Outcome,
  type PersonalisationState,
  recordOutcome,
  recordSignal,
  resetPersonalisation,
  saveState,
  setConsent,
  type Visit,
} from "./state";
import type { TargetId } from "./targets";
import { TARGET_IDS, TARGETS } from "./targets";

const model = modelJson as unknown as ModelArtifact;
const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const source = (rel: string) => readFileSync(root(rel), "utf8");

/** A stand-in for PreferencesProvider + PersonalisationProvider, with the same event semantics. */
function app(opts: { prefs?: Preferences; consent?: boolean; model?: ModelArtifact | null; view?: "simple" | "complex" } = {}) {
  let prefs: Preferences = opts.prefs ?? { ...DEFAULT_PREFS, onboarding: "done" };
  let preview: { actions: UiAction[]; result: Preferences; source: ChangeSource } | null = null;
  let saved: Preferences = prefs;
  const history: { prefs: Preferences; source: ChangeSource }[] = [];
  let ml: PersonalisationState = opts.consent === false ? INITIAL_STATE : setConsent(INITIAL_STATE, true);
  let visit: Visit = NEW_VISIT;
  const m = opts.model === undefined ? model : opts.model;
  const view = opts.view ?? "simple";
  const send = (e: PrefsEvent) => emit([(ev) => (ml = onPrefsEvent(ml, ev))], e);

  const api = {
    get prefs() {
      return preview?.result ?? prefs;
    },
    get kept() {
      return prefs;
    },
    get saved() {
      return saved;
    },
    get ml() {
      return ml;
    },
    set ml(s: PersonalisationState) {
      ml = s;
    },
    get visit() {
      return visit;
    },
    /** The tab was closed and opened again: sessionStorage starts empty. */
    newVisit() {
      visit = NEW_VISIT;
    },
    historyLength: () => history.length,
    apply(actions: UiAction[], source: ChangeSource = "other") {
      const before = prefs;
      prefs = applyActions(prefs, actions);
      history.push({ prefs: before, source });
      send({ kind: "kept", actions, before, after: prefs, source });
    },
    startPreview(actions: UiAction[], source: ChangeSource = "other") {
      preview = { actions, result: applyActions(prefs, actions), source };
    },
    acceptPreview(save = false) {
      if (!preview) return;
      const before = prefs;
      history.push({ prefs: before, source: preview.source });
      prefs = preview.result;
      if (save) saved = prefs;
      const p = preview;
      preview = null;
      send({ kind: "kept", actions: p.actions, before, after: prefs, source: p.source });
    },
    rejectPreview() {
      preview = null;
    },
    undo() {
      const entry = history.pop();
      if (!entry) return;
      const before = prefs;
      prefs = entry.prefs;
      send({ kind: "undo", before, after: prefs, undoneSource: entry.source });
    },
    resetToDefault() {
      const before = prefs;
      history.push({ prefs: before, source: "other" });
      prefs = { ...DEFAULT_PREFS, onboarding: prefs.onboarding };
      saved = prefs;
      send({ kind: "reset", before });
    },
    openVoice() {
      ml = recordSignal(ml, "voiceSessions");
    },
    /** What PersonalisationProvider does on every change when no preview is showing. */
    evaluate(): PersonalisationResult | null {
      if (preview || ml.consent !== "granted") return null;
      const input = { preferences: api.prefs, view, choices: null };
      ml = reconcile(ml, input);
      const r = forVisit(recommendPreferences(input, ml, m, { maxSuggestions: 1 }), visit);
      if (r.status === "ok" && visit.shown === null) visit = { shown: r.preferences[0].target, answered: false };
      return r;
    },
    /** PersonalisationProvider.recordOutcome: any answer ends suggestions for this visit. */
    answer(target: TargetId, outcome: Outcome, fingerprint: string) {
      ml = recordOutcome(ml, target, outcome, fingerprint);
      visit = { shown: visit.shown ?? target, answered: true };
    },
    card(result: PersonalisationResult | null) {
      return shouldShowCard({ consent: ml.consent, result, onboarding: api.prefs.onboarding, previewActive: preview !== null });
    },
    /** The card's "Preview it" then the bar's "Keep it" / "Go back". */
    previewSuggestion(result: PersonalisationResult, keep: boolean) {
      const rec = result.preferences[0];
      api.startPreview(rec.actions, "ml");
      if (keep) api.acceptPreview(true);
      else api.rejectPreview();
      api.answer(rec.target, keep ? "accepted" : "rejected", result.fingerprint!);
    },
  };
  return api;
}

/** Someone who opened Voice Mode six times and chose bigger buttons in Settings: the model suggests talking first. */
function talker(opts?: Parameters<typeof app>[0]) {
  const a = app(opts);
  a.apply([{ type: "targets", value: "large" }], "settings");
  for (let i = 0; i < 6; i++) a.openVoice();
  return a;
}

describe("consent", () => {
  it("C1: before consent nothing is counted, predicted or shown", () => {
    const a = app({ consent: false });
    a.apply([{ type: "textSize", value: 150 }], "settings");
    a.openVoice();
    expect(a.ml).toEqual(INITIAL_STATE);
    expect(a.evaluate()).toBeNull();
    expect(recommendPreferences({ preferences: a.prefs, view: "simple" }, a.ml, model).status).toBe("needs_consent");
    expect(a.card(null)).toBe(false);
  });

  it("C2: with consent, only kept Settings and Voice changes are counted, per the published rules", () => {
    const a = app();
    a.apply([{ type: "textSize", value: 125 }], "settings");
    a.startPreview([{ type: "density", value: "calm" }], "voice");
    a.acceptPreview();
    a.apply([{ type: "hide", widget: "recent" }], "settings");
    a.apply([{ type: "show", widget: "chart" }], "settings");
    a.apply([{ type: "textSize", value: 100 }], "settings");
    expect(a.ml.signals).toEqual({ textLarger: 1, lessOnScreen: 2, moreDetail: 1, textSmaller: 1 });
  });

  it("C3: turning suggestions off deletes ML data and leaves display settings exactly as they were", () => {
    const a = talker();
    const before = a.kept;
    a.ml = setConsent(a.ml, false);
    expect(a.ml).toEqual({ ...INITIAL_STATE, consent: "declined" });
    expect(a.kept).toBe(before);
    expect(a.kept.targets).toBe("large");
    expect(a.evaluate()).toBeNull();
  });

  it("ML consent is not part of display preferences and survives a preferences reset", () => {
    expect(Object.keys(sanitize({ ...DEFAULT_PREFS, consent: "granted" }))).not.toContain("consent");
    const a = talker();
    a.resetToDefault();
    expect(a.ml.consent).toBe("granted");
  });
});

describe("behaviour-signal rules", () => {
  it("S1: Make it yours styles, Dial's own suggestions, onboarding and untagged changes are never counted", () => {
    const a = app();
    for (const s of ["style", "ml", "other"] as ChangeSource[]) {
      a.apply([{ type: "textSize", value: 150 }, { type: "density", value: "calm" }, { type: "hide", widget: "chart" }], s);
      a.undo();
    }
    a.apply([{ type: "onboarding", value: "skipped" }], "settings");
    expect(a.ml.signals).toEqual({});
  });

  it("S1: previews that are rejected never count, even from Settings or Voice", () => {
    const a = app();
    a.startPreview([{ type: "textSize", value: 200 }], "voice");
    a.rejectPreview();
    expect(a.ml.signals).toEqual({});
  });

  it("S2: a Make it yours style kept through the preview bar adds no signals, and the rules give the same answer whatever ML is doing", () => {
    const rules = recommend(["largerText", "lessInfo", "voiceFirst"])!;
    const withMl = app();
    withMl.startPreview(rules.actions, "style");
    withMl.acceptPreview(true);
    expect(withMl.ml.signals).toEqual({});
    expect(withMl.kept.onboarding).toBe("done");
    // The rules recommender is untouched and independent of ML state.
    expect(recommend(["largerText", "lessInfo", "voiceFirst"])).toEqual(rules);
    expect(source("lib/preferences/recommend.ts")).not.toMatch(/personalisation/);
    expect(source("components/personalise/make-it-yours.tsx")).not.toMatch(/lib\/personalisation/);
  });

  it("view switches and theme changes are not signals", () => {
    const a = app();
    a.apply([{ type: "theme", value: "dark" }, { type: "contrast", value: "high" }], "settings");
    expect(a.ml.signals).toEqual({});
  });
});

describe("suggestion lifecycle", () => {
  it("G1: kept Settings changes plus Voice Mode use lead to one explained suggestion that is a valid preference change", () => {
    const a = talker();
    const r = a.evaluate()!;
    expect(r.status).toBe("ok");
    expect(r.preferences).toHaveLength(1);
    expect(r.preferences[0].target).toBe("voiceFirst");
    expect(r.preferences[0].reasons).toContain("You've talked to Dial 6 times");
    expect(r.trainedOn).toBe("synthetic");
    expect(a.card(r)).toBe(true);
    for (const id of TARGET_IDS) {
      const p = applyActions(DEFAULT_PREFS, TARGETS[id].actions);
      expect(sanitize(p), id).toEqual(p);
      expect(TARGETS[id].status(p), id).toBe("on");
    }
  });

  it("G2: the card stays hidden without consent, before Make it yours is done or skipped, during any preview, or with no suggestion", () => {
    const a = talker();
    const r = a.evaluate()!;
    expect(shouldShowCard({ consent: "granted", result: r, onboarding: "done", previewActive: false })).toBe(true);
    expect(shouldShowCard({ consent: "granted", result: r, onboarding: "skipped", previewActive: false })).toBe(true);
    expect(shouldShowCard({ consent: "unset", result: r, onboarding: "done", previewActive: false })).toBe(false);
    expect(shouldShowCard({ consent: "declined", result: r, onboarding: "done", previewActive: false })).toBe(false);
    expect(shouldShowCard({ consent: "granted", result: r, onboarding: "unset", previewActive: false })).toBe(false);
    expect(shouldShowCard({ consent: "granted", result: r, onboarding: "done", previewActive: true })).toBe(false);
    expect(shouldShowCard({ consent: "granted", result: { ...r, status: "no_recommendation", preferences: [] }, onboarding: "done", previewActive: false })).toBe(false);
    expect(shouldShowCard({ consent: "granted", result: null, onboarding: "done", previewActive: false })).toBe(false);
  });

  it("preview changes the screen only: nothing kept, saved or added to undo history, and no re-evaluation", () => {
    const a = talker();
    const r = a.evaluate()!;
    const kept = a.kept;
    const saved = a.saved;
    const historyLength = a.historyLength();
    const signals = a.ml.signals;
    a.startPreview(r.preferences[0].actions, "ml");
    expect(a.prefs.voiceFirst).toBe(true);
    expect(a.kept).toBe(kept);
    expect(a.saved).toBe(saved);
    expect(a.historyLength()).toBe(historyLength);
    expect(a.ml.signals).toBe(signals);
    expect(a.evaluate()).toBeNull();
    expect(a.card(r)).toBe(false);
  });

  it("A1: Keep it saves the setting, is undoable, adds no signal, and the suggestion is not offered again", () => {
    const a = talker();
    const r = a.evaluate()!;
    const signals = a.ml.signals;
    a.previewSuggestion(r, true);
    expect(a.kept.voiceFirst).toBe(true);
    expect(a.saved.voiceFirst).toBe(true);
    expect(a.historyLength()).toBeGreaterThan(0);
    expect(a.ml.signals).toEqual(signals);
    const next = a.evaluate()!;
    expect(next.withheld).toContainEqual({ target: "voiceFirst", reason: "already_on" });
  });

  it("R1: Go back / No thanks: settings unchanged, not offered again for the same settings, never after a second no", () => {
    const a = talker();
    const r = a.evaluate()!;
    const kept = a.kept;
    a.previewSuggestion(r, false);
    expect(a.kept).toBe(kept);
    expect(a.evaluate()!.withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
    a.apply([{ type: "spacing", value: "roomy" }], "settings");
    const again = a.evaluate()!;
    if (again.preferences[0]?.target === "voiceFirst") {
      a.ml = recordOutcome(a.ml, "voiceFirst", "rejected", again.fingerprint!);
      a.apply([{ type: "theme", value: "dark" }], "settings");
      expect(a.evaluate()!.withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
    }
  });

  it("I1: Not now holds the suggestion for the rest of the visit, and after that until settings change", () => {
    const a = talker();
    a.answer("voiceFirst", "ignored", a.evaluate()!.fingerprint!);
    expect(a.evaluate()!.withheld).toContainEqual({ target: "voiceFirst", reason: "recently_ignored" });
    // A settings change in the same visit does not bring it back: the visit is answered.
    a.apply([{ type: "spacing", value: "roomy" }], "settings");
    expect(a.card(a.evaluate()!)).toBe(false);
    // Next visit, with changed settings, it may be offered again.
    a.newVisit();
    expect(a.evaluate()!.withheld.find((w) => w.target === "voiceFirst")?.reason).not.toBe("recently_ignored");
    // Next visit with unchanged settings: still held.
    const b = talker();
    b.answer("voiceFirst", "ignored", b.evaluate()!.fingerprint!);
    b.newVisit();
    expect(b.evaluate()!.withheld).toContainEqual({ target: "voiceFirst", reason: "recently_ignored" });
  });

  it("V1: at most one suggestion per visit, whatever the person answers", () => {
    for (const outcome of ["accepted", "rejected", "ignored"] as const) {
      const a = talker();
      const r = a.evaluate()!;
      expect(a.visit).toEqual({ shown: "voiceFirst", answered: false });
      a.answer("voiceFirst", outcome, r.fingerprint!);
      // Give the model every reason to suggest something else this visit.
      a.apply([{ type: "hide", widget: "recent" }, { type: "hide", widget: "budget" }], "settings");
      for (let i = 0; i < 4; i++) a.apply([{ type: "density", value: "calm" }, { type: "density", value: "standard" }], "settings");
      const again = a.evaluate()!;
      expect(again.preferences, outcome).toEqual([]);
      expect(a.card(again), outcome).toBe(false);
    }
  });

  it("V1: the visit's one suggestion is the first one shown; a different one waits for the next visit", () => {
    const a = talker();
    const r = recommendPreferences({ preferences: a.prefs, view: "simple", choices: null }, a.ml, model, { maxSuggestions: 1 });
    expect(r.preferences[0].target).toBe("voiceFirst");
    const held = forVisit(r, { shown: "calmLayout", answered: false });
    expect(held.status).toBe("no_recommendation");
    expect(held.preferences).toEqual([]);
    expect(held.withheld).toContainEqual({ target: "voiceFirst", reason: "one_per_visit" });
    expect(forVisit(r, { shown: "voiceFirst", answered: false })).toBe(r);
    expect(forVisit(r, NEW_VISIT)).toBe(r);
  });

  it("B1: after two No thanks in a row (any suggestions), nothing is suggested until the person changes a setting themselves", () => {
    const a = talker();
    a.previewSuggestion(a.evaluate()!, false); // No thanks to talking first
    a.newVisit();
    a.answer("calmLayout", "rejected", a.evaluate()!.fingerprint!); // No thanks to another suggestion, next visit
    expect(a.ml.declines).toBe(BACKOFF_AFTER);
    a.newVisit();
    const paused = a.evaluate()!;
    expect(paused.status).toBe("paused");
    expect(paused.preferences).toEqual([]);
    expect(a.card(paused)).toBe(false);
    // Changes the person did not make themselves don't lift it.
    for (const src of ["style", "ml", "other"] as ChangeSource[]) a.apply([{ type: "theme", value: "dark" }], src);
    a.undo();
    expect(a.evaluate()!.status).toBe("paused");
    // Their own change in Settings does. The per-suggestion rules still apply afterwards.
    a.apply([{ type: "spacing", value: "roomy" }], "settings");
    expect(a.evaluate()!.status).not.toBe("paused");
    expect(a.ml.rejected.voiceFirst?.count).toBe(1);
  });

  it("B1: undoing a kept suggestion counts as a no towards the back-off", () => {
    const a = talker();
    a.previewSuggestion(a.evaluate()!, true);
    a.undo();
    a.evaluate();
    expect(a.ml.declines).toBe(1);
  });
});

describe("undo and reset", () => {
  it("U1: undoing a kept suggestion counts as a no and does not count as an undone display change", () => {
    const a = talker();
    a.previewSuggestion(a.evaluate()!, true);
    a.undo();
    expect(a.kept.voiceFirst).toBe(false);
    const r = a.evaluate()!;
    expect(r.withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
    expect(a.ml.accepted).toEqual({});
    expect(a.ml.signals.undoneChanges).toBeUndefined();
  });

  it("U2: undoing the person's own Settings change counts as an undone display change", () => {
    const a = app();
    a.apply([{ type: "textSize", value: 150 }], "settings");
    a.undo();
    expect(a.ml.signals).toEqual({ textLarger: 1, undoneChanges: 1 });
  });

  it("X1: Reset to default resets display settings only; ML consent and counts stay; a kept suggestion becomes a no", () => {
    const a = talker();
    a.previewSuggestion(a.evaluate()!, true);
    const signals = a.ml.signals;
    a.resetToDefault();
    expect(a.kept.voiceFirst).toBe(false);
    expect(a.ml.consent).toBe("granted");
    expect(a.ml.signals).toEqual(signals);
    expect(a.evaluate()!.withheld).toContainEqual({ target: "voiceFirst", reason: "previously_rejected" });
  });

  it("X2: Reset suggestions forgets ML counts and answers, keeps consent, and leaves display settings alone", () => {
    const a = talker();
    a.previewSuggestion(a.evaluate()!, false);
    const kept = a.kept;
    a.ml = resetPersonalisation(a.ml);
    expect(a.ml).toEqual({ ...INITIAL_STATE, consent: "granted" });
    expect(a.kept).toBe(kept);
  });
});

describe("fallback", () => {
  it("F1: no model or a broken model: no card, and Make it yours works exactly as before", () => {
    for (const m of [null, { ...model, features: [] } as unknown as ModelArtifact]) {
      const a = talker({ model: m });
      const r = a.evaluate()!;
      expect(r.status).toBe("unavailable");
      expect(a.card(r)).toBe(false);
      const rules = recommend(["lessInfo"])!;
      a.startPreview(rules.actions, "style");
      a.acceptPreview(true);
      expect(a.kept.layout.density).toBe("calm");
    }
  });

  it("F2: blocked storage starts with suggestions off; stored state round-trips including kept suggestions", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadState(broken).consent).toBe("unset");
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    const a = talker();
    a.previewSuggestion(a.evaluate()!, true);
    saveState(a.ml, store);
    expect(loadState(store)).toEqual(a.ml);
    // State saved before this integration (no `accepted`) still loads.
    expect(loadState({ getItem: () => JSON.stringify({ version: 1, consent: "granted", signals: { textLarger: 2 } }) }).accepted).toEqual({});
  });

  it("listener failures never break preferences", () => {
    const seen: string[] = [];
    emit(
      [
        () => {
          throw new Error("boom");
        },
        (e) => seen.push(e.kind),
      ],
      { kind: "reset", before: DEFAULT_PREFS },
    );
    expect(seen).toEqual(["reset"]);
  });
});

describe("conflicting preferences", () => {
  it("K1: asking for both less and more on screen gives no layout suggestion", () => {
    const a = app({ view: "complex" });
    for (let i = 0; i < 4; i++) {
      a.apply([{ type: "hide", widget: "recent" }], "settings");
      a.apply([{ type: "show", widget: "recent" }], "settings");
    }
    expect(a.ml.signals).toMatchObject({ lessOnScreen: 4, moreDetail: 4 });
    const r = a.evaluate()!;
    expect(r.preferences.map((p) => p.target)).not.toContain("calmLayout");
    expect(r.withheld).toContainEqual({ target: "calmLayout", reason: "conflicting_signals" });
  });
});

describe("privacy boundaries", () => {
  it("P1: the live state sent with Dial questions carries only Spend Pause, purchases and payments", () => {
    const body = liveState(SEED_TRANSACTIONS, { enabled: true, singlePurchaseThreshold: 10000, monthlyBudget: null, quietHours: null });
    expect(Object.keys(body).sort()).toEqual(["payments", "purchases", "spendPause"]);
    expect(JSON.stringify(body)).not.toMatch(/personalis|signal|consent|voiceSessions|textLarger/i);
  });

  it("P1: the AI backend, assistant client and API routes never import personalisation; Ask Dial only reports opening Voice Mode", () => {
    const files = ["lib/assistant/client.ts", "lib/assistant/live-state.ts", "lib/ai/ask.ts", "lib/ai/interpreter.ts", "app/api/ask/route.ts", "lib/finance/index.ts"];
    for (const f of files) expect(source(f), f).not.toMatch(/personalisation/);
    const ask = source("components/assistant/ask-dial.tsx");
    expect(ask.match(/usePersonalisation\(\)/g)).toHaveLength(1);
    expect(ask).toMatch(/const \{ noteVoiceOpened \} = usePersonalisation\(\)/);
  });

  it("P1: withdrawing consent clears the visit too; the visit stores no timestamps or content", () => {
    const p = source("lib/personalisation/provider.tsx");
    expect(p).toMatch(/clearState\(\);\s*clearVisit\(\);/);
    expect(p).toMatch(/setState\(\(s\) => setConsentIn\(s, granted\)\);\s*setVisit\(NEW_VISIT\);/);
    const state = source("lib/personalisation/state.ts");
    const saveVisitBody = state.slice(state.indexOf("export function saveVisit"), state.indexOf("export function clearVisit"));
    expect(saveVisitBody).toMatch(/JSON\.stringify\(\{ shown: visit\.shown, answered: visit\.answered \}\)/);
    expect(state).not.toMatch(/Date\.now|new Date|performance\.now/);
  });

  it("P1: the model file is never imported statically, so it is fetched only after consent", () => {
    for (const f of ["lib/personalisation/index.ts", "lib/personalisation/provider.tsx", "components/personalise/ml-suggestion.tsx", "components/settings/display-settings.tsx", "components/home/home-screen.tsx"])
      expect(source(f), f).not.toMatch(/^import[^\n]*model\.json/m);
    expect(source("lib/personalisation/provider.tsx")).toMatch(/if \(state\.consent !== "granted" \|\| model !== undefined\) return;\s*let live = true;\s*setModelStatus\("loading"\);\s*loadModel\(\)/);
  });

  it("P2: nothing a person sees names a condition, diagnosis, age, vulnerability or financial circumstance", () => {
    const BANNED = /disab|impair|condition|diagnos|dyslex|autis|adhd|neuro|dementia|anxiety|depress|mental|vulnerab|elderly|older|senior|\bage\b|blind|deaf|struggl|confus|debt|afford|income|poor/i;
    const card = source("components/personalise/ml-suggestion.tsx");
    const settings = source("components/settings/display-settings.tsx");
    const section = settings.slice(settings.indexOf('id="suggestions"'), settings.indexOf("</section>", settings.indexOf('id="suggestions"')));
    const visible = (s: string) => [...s.matchAll(/>([^<>{}]+)</g), ...s.matchAll(/"([A-Z][^"]{8,})"/g)].map((m) => m[1]).join("\n");
    expect(visible(card)).not.toMatch(BANNED);
    expect(visible(section)).not.toMatch(BANNED);
    expect(visible(card)).toMatch(/made-up example data/);
    expect(visible(section)).toMatch(/made-up example data/);
  });

  it("P3: the model's Make it yours choices match the rules recommender exactly", () => {
    expect(CHOICES.map((c) => ({ id: c.id, label: c.label }))).toEqual(RULE_CHOICES.map((c) => ({ id: c.id, label: c.label })));
  });
});
