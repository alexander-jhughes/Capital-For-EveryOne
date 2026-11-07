import { describe, expect, it } from "vitest";
import { explicitFingerprint, extractFeatures, FEATURE_IDS, hasInformativeFeatures, MISSING, SIGNAL_CAP } from "./features";
import { DEFAULTS } from "./examples";
import {
  BACKOFF_AFTER,
  clearState,
  clearVisit,
  INITIAL_STATE,
  isPaused,
  loadVisit,
  NEW_VISIT,
  noteOwnChange,
  loadState,
  PERSONALISATION_STORAGE_KEY,
  recordOutcome,
  recordSignal,
  REJECTION_LIMIT,
  resetPersonalisation,
  sanitizeState,
  saveState,
  saveVisit,
  setConsent,
  signalForAction,
  VISIT_STORAGE_KEY,
} from "./state";

const granted = setConsent(INITIAL_STATE, true);

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}
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

describe("consent", () => {
  it("starts unset, and records nothing until granted", () => {
    expect(INITIAL_STATE.consent).toBe("unset");
    expect(recordSignal(INITIAL_STATE, "textLarger")).toBe(INITIAL_STATE);
    expect(recordOutcome(INITIAL_STATE, "largerText", "rejected", "f")).toBe(INITIAL_STATE);
  });

  it("turning it off deletes everything learned", () => {
    const used = recordOutcome(recordSignal(granted, "voiceSessions"), "voiceFirst", "rejected", "f");
    const off = setConsent(used, false);
    expect(off).toEqual({ ...INITIAL_STATE, consent: "declined" });
    expect(recordSignal(off, "voiceSessions")).toBe(off);
  });
});

describe("signals", () => {
  it("counts explicit actions, capped", () => {
    let s = granted;
    for (let i = 0; i < SIGNAL_CAP + 5; i++) s = recordSignal(s, "textLarger");
    expect(s.signals.textLarger).toBe(SIGNAL_CAP);
  });

  it("maps explicit display changes to signals", () => {
    expect(signalForAction({ type: "textSize", value: 150 }, { textSize: 125 })).toBe("textLarger");
    expect(signalForAction({ type: "textSize", value: 100 }, { textSize: 125 })).toBe("textSmaller");
    expect(signalForAction({ type: "textSize", value: 125 }, { textSize: 125 })).toBeNull();
    expect(signalForAction({ type: "textSize", value: 150 })).toBeNull();
    expect(signalForAction({ type: "density", value: "calm" })).toBe("lessOnScreen");
    expect(signalForAction({ type: "hide", widget: "chart" })).toBe("lessOnScreen");
    expect(signalForAction({ type: "show", widget: "chart" })).toBe("moreDetail");
    expect(signalForAction({ type: "density", value: "standard" })).toBe("moreDetail");
    expect(signalForAction({ type: "theme", value: "dark" })).toBeNull();
    expect(signalForAction(null)).toBeNull();
  });
});

describe("outcomes", () => {
  it("rejections count up to the limit; accepting clears them", () => {
    let s = granted;
    for (let i = 0; i < REJECTION_LIMIT + 2; i++) s = recordOutcome(s, "largerText", "rejected", "f");
    expect(s.rejected.largerText?.count).toBe(REJECTION_LIMIT);
    s = recordOutcome(s, "largerText", "accepted", "f");
    expect(s.rejected.largerText).toBeUndefined();
  });

  it("ignoring remembers the settings it was ignored at", () => {
    expect(recordOutcome(granted, "calmLayout", "ignored", "abc").ignored.calmLayout).toBe("abc");
  });
});

describe("back-off after No thanks in a row", () => {
  it("two No thanks in a row, on any suggestions, pause everything until the person changes a setting themselves", () => {
    let s = recordOutcome(granted, "largerText", "rejected", "f");
    expect(isPaused(s)).toBe(false);
    s = recordOutcome(s, "calmLayout", "ignored", "f");
    expect(s.declines).toBe(1); // Not now is not a no
    s = recordOutcome(s, "voiceFirst", "rejected", "f");
    expect(isPaused(s)).toBe(true);
    s = recordOutcome(s, "stepByStep", "rejected", "f");
    expect(s.declines).toBe(BACKOFF_AFTER);
    expect(isPaused(noteOwnChange(s))).toBe(false);
    // The per-suggestion limit is separate and unchanged.
    expect(noteOwnChange(s).rejected.largerText?.count).toBe(1);
  });

  it("Keep it ends a run of noes; turning suggestions off or resetting forgets it", () => {
    const s = recordOutcome(recordOutcome(granted, "largerText", "rejected", "f"), "calmLayout", "accepted", "f");
    expect(s.declines).toBe(0);
    const paused = recordOutcome(recordOutcome(granted, "largerText", "rejected", "f"), "calmLayout", "rejected", "f");
    expect(setConsent(paused, false)).toEqual({ ...INITIAL_STATE, consent: "declined" });
    expect(resetPersonalisation(paused).declines).toBe(0);
    expect(noteOwnChange(INITIAL_STATE)).toBe(INITIAL_STATE);
  });
});

describe("visit (sessionStorage)", () => {
  it("round-trips only the suggestion id and whether it was answered, with no timestamps", () => {
    const store = memoryStorage();
    expect(saveVisit({ shown: "calmLayout", answered: true }, store)).toBe(true);
    expect(JSON.parse(store.m.get(VISIT_STORAGE_KEY)!)).toEqual({ shown: "calmLayout", answered: true });
    expect(loadVisit(store)).toEqual({ shown: "calmLayout", answered: true });
    expect(clearVisit(store)).toBe(true);
    expect(loadVisit(store)).toEqual(NEW_VISIT);
  });

  it("never throws and sanitises what it reads", () => {
    expect(loadVisit(broken)).toEqual(NEW_VISIT);
    expect(saveVisit(NEW_VISIT, broken)).toBe(false);
    expect(clearVisit(broken)).toBe(false);
    expect(loadVisit(undefined)).toEqual(NEW_VISIT);
    const store = memoryStorage();
    store.setItem(VISIT_STORAGE_KEY, JSON.stringify({ shown: "deleteAccount", answered: "yes", at: 123 }));
    expect(loadVisit(store)).toEqual(NEW_VISIT);
    store.setItem(VISIT_STORAGE_KEY, "{nope");
    expect(loadVisit(store)).toEqual(NEW_VISIT);
  });
});

describe("reset", () => {
  it("forgets counts and answers but keeps the on/off choice", () => {
    const used = recordOutcome(recordSignal(granted, "textLarger"), "largerText", "rejected", "f");
    expect(resetPersonalisation(used)).toEqual({ ...INITIAL_STATE, consent: "granted" });
  });

  it("clearState removes the stored data", () => {
    const store = memoryStorage();
    saveState(recordSignal(granted, "textLarger"), store);
    expect(store.m.has(PERSONALISATION_STORAGE_KEY)).toBe(true);
    expect(clearState(store)).toBe(true);
    expect(loadState(store)).toEqual(INITIAL_STATE);
  });
});

describe("storage", () => {
  it("round-trips", () => {
    const store = memoryStorage();
    const s = recordOutcome(recordSignal(granted, "voiceSessions"), "voiceFirst", "ignored", "fp");
    expect(saveState(s, store)).toBe(true);
    expect(loadState(store)).toEqual(s);
  });

  it("never throws when storage is blocked, missing or corrupt", () => {
    expect(loadState(broken)).toEqual(INITIAL_STATE);
    expect(saveState(granted, broken)).toBe(false);
    expect(clearState(broken)).toBe(false);
    expect(loadState(undefined)).toEqual(INITIAL_STATE);
    const store = memoryStorage();
    store.setItem(PERSONALISATION_STORAGE_KEY, "{not json");
    expect(loadState(store)).toEqual(INITIAL_STATE);
  });

  it("sanitises tampered data", () => {
    const s = sanitizeState({
      version: 1,
      consent: "granted",
      signals: { textLarger: 999, voiceSessions: -3, evil: 5, lessOnScreen: "7" },
      rejected: { largerText: { count: 50, fingerprint: "x" }, nope: { count: 1, fingerprint: "y" }, calmLayout: { count: 0, fingerprint: "z" } },
      ignored: { voiceFirst: "a", other: "b", calmLayout: 4 },
      declines: 99,
      extra: "dropped",
    });
    expect(s).toEqual({
      version: 1,
      consent: "granted",
      signals: { textLarger: SIGNAL_CAP },
      rejected: { largerText: { count: REJECTION_LIMIT, fingerprint: "x" } },
      ignored: { voiceFirst: "a" },
      accepted: {},
      declines: BACKOFF_AFTER,
    });
    expect(sanitizeState({ version: 1, consent: "granted", declines: "2" }).declines).toBe(0);
    expect(sanitizeState({ version: 2, consent: "granted" })).toEqual(INITIAL_STATE);
    expect(sanitizeState({ version: 1, consent: "declined", signals: { textLarger: 3 } })).toEqual({ ...INITIAL_STATE, consent: "declined" });
  });
});

describe("features", () => {
  it("encodes the allowlisted settings, choices and signals", () => {
    const x = extractFeatures(
      { preferences: { ...DEFAULTS, textSize: 150, contrast: "high", layout: { pinned: ["bill"], shown: [], hidden: ["recent", "chart"], emphasis: null, density: "calm" } }, view: "simple", choices: ["lessInfo"] },
      { textLarger: 2, voiceSessions: 50 },
    );
    const v = (id: string) => x[FEATURE_IDS.indexOf(id)];
    expect(x).toHaveLength(FEATURE_IDS.length);
    expect([v("textSize"), v("contrastHigh"), v("densityCalm"), v("billProminent"), v("hiddenCount"), v("simpleView")]).toEqual([2, 1, 1, 1, 2, 1]);
    expect([v("choice_lessInfo"), v("choice_moreDetail")]).toEqual([1, 0]);
    expect([v("sig_textLarger"), v("sig_voiceSessions"), v("sig_moreDetail")]).toEqual([2, SIGNAL_CAP, 0]);
  });

  it("marks what it doesn't know as missing rather than guessing", () => {
    const x = extractFeatures({ preferences: { textSize: 100 } });
    expect(x[FEATURE_IDS.indexOf("textSize")]).toBe(0);
    for (const id of FEATURE_IDS.filter((f) => f !== "textSize")) expect(x[FEATURE_IDS.indexOf(id)], id).toBe(MISSING);
    expect(extractFeatures(undefined).every((v) => v === MISSING)).toBe(true);
    expect(extractFeatures("nonsense", 42).every((v) => v === MISSING)).toBe(true);
  });

  it("knows when there is nothing to learn from", () => {
    expect(hasInformativeFeatures(extractFeatures({ preferences: DEFAULTS, view: "simple" }, {}))).toBe(false);
    expect(hasInformativeFeatures(extractFeatures({ preferences: DEFAULTS }, { voiceSessions: 1 }))).toBe(true);
  });

  it("the fingerprint follows explicit settings, not action counts", () => {
    const a = extractFeatures({ preferences: DEFAULTS }, { textLarger: 1 });
    const b = extractFeatures({ preferences: DEFAULTS }, { textLarger: 5 });
    const c = extractFeatures({ preferences: { ...DEFAULTS, contrast: "high" } }, { textLarger: 1 });
    expect(explicitFingerprint(a)).toBe(explicitFingerprint(b));
    expect(explicitFingerprint(a)).not.toBe(explicitFingerprint(c));
  });
});

describe("blocked browser storage", () => {
  it("loadState, saveState and clearState never throw when touching localStorage throws", () => {
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    const blocked = {};
    Object.defineProperty(blocked, "localStorage", { get() { throw new Error("blocked"); } });
    g.window = blocked;
    try {
      expect(loadState()).toEqual(INITIAL_STATE);
      expect(saveState(INITIAL_STATE)).toBe(false);
      expect(() => clearState()).not.toThrow();
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
  });
});
