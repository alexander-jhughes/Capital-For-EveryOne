// What the personalisation engine remembers about one person, on their device only.
// Pure functions plus try/catch storage helpers. Nothing here is sent to a server or to the Gemini assistant.
//
// - consent: nothing is recorded or predicted until the person says yes. Saying no (or turning it off later) deletes everything.
// - signals: counts of explicit display actions ("made the text bigger"). No timestamps, no content, nothing financial.
// - rejected / ignored: so Dial never nags with the same suggestion.
import { type SignalId, SIGNAL_CAP, SIGNAL_IDS, type Signals } from "./features";
import { TARGET_IDS, type TargetId } from "./targets";

export const PERSONALISATION_STORAGE_KEY = "cfe-personalisation";
/** After this many "no thanks" a suggestion is never offered again (until the person resets personalisation). */
export const REJECTION_LIMIT = 2;

export type Consent = "unset" | "granted" | "declined";
export type Outcome = "accepted" | "rejected" | "ignored";

export interface PersonalisationState {
  version: 1;
  consent: Consent;
  signals: Signals;
  /** Per suggestion: how often it was turned down, and the person's explicit settings at the last "no". */
  rejected: Partial<Record<TargetId, { count: number; fingerprint: string }>>;
  /** Per suggestion: the explicit settings when it was last dismissed without an answer. */
  ignored: Partial<Record<TargetId, string>>;
  /** Per suggestion kept from Dial: the explicit settings at that moment. If the setting is later undone, it counts as a no. */
  accepted: Partial<Record<TargetId, string>>;
}

export const INITIAL_STATE: PersonalisationState = { version: 1, consent: "unset", signals: {}, rejected: {}, ignored: {}, accepted: {} };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTarget = (k: string): k is TargetId => (TARGET_IDS as readonly string[]).includes(k);
const MAX_FINGERPRINT = 200;

/** Rebuilds state from untrusted storage, keeping only known keys and sane values. */
export function sanitizeState(input: unknown): PersonalisationState {
  if (!isObj(input) || input.version !== 1) return INITIAL_STATE;
  const consent: Consent = input.consent === "granted" || input.consent === "declined" ? input.consent : "unset";
  if (consent !== "granted") return { ...INITIAL_STATE, consent };

  const signals: Signals = {};
  if (isObj(input.signals))
    for (const id of SIGNAL_IDS) {
      const n = input.signals[id];
      if (typeof n === "number" && Number.isFinite(n) && n > 0) signals[id] = Math.min(Math.floor(n), SIGNAL_CAP);
    }

  const rejected: PersonalisationState["rejected"] = {};
  if (isObj(input.rejected))
    for (const [k, v] of Object.entries(input.rejected))
      if (isTarget(k) && isObj(v) && typeof v.count === "number" && v.count >= 1 && typeof v.fingerprint === "string" && v.fingerprint.length <= MAX_FINGERPRINT)
        rejected[k] = { count: Math.min(Math.floor(v.count), REJECTION_LIMIT), fingerprint: v.fingerprint };

  const ignored: PersonalisationState["ignored"] = {};
  if (isObj(input.ignored))
    for (const [k, v] of Object.entries(input.ignored)) if (isTarget(k) && typeof v === "string" && v.length <= MAX_FINGERPRINT) ignored[k] = v;

  // Older stored state has no `accepted`: treated as empty.
  const accepted: PersonalisationState["accepted"] = {};
  if (isObj(input.accepted))
    for (const [k, v] of Object.entries(input.accepted)) if (isTarget(k) && typeof v === "string" && v.length <= MAX_FINGERPRINT) accepted[k] = v;

  return { version: 1, consent, signals, rejected, ignored, accepted };
}

/** Yes turns personalisation on. No (or turning it off) also deletes everything it had learned. */
export function setConsent(_state: PersonalisationState, granted: boolean): PersonalisationState {
  return granted ? { ..._state, consent: "granted" } : { ...INITIAL_STATE, consent: "declined" };
}

/** Counts one explicit display action. Does nothing without consent. */
export function recordSignal(state: PersonalisationState, id: SignalId): PersonalisationState {
  if (state.consent !== "granted" || !SIGNAL_IDS.includes(id)) return state;
  const n = Math.min((state.signals[id] ?? 0) + 1, SIGNAL_CAP);
  return { ...state, signals: { ...state.signals, [id]: n } };
}

/** Remembers what the person did with a suggestion. `fingerprint` comes from the result that offered it. */
export function recordOutcome(state: PersonalisationState, target: TargetId, outcome: Outcome, fingerprint: string): PersonalisationState {
  if (state.consent !== "granted" || !isTarget(target)) return state;
  const rejected = { ...state.rejected };
  const ignored = { ...state.ignored };
  const accepted = { ...state.accepted };
  if (outcome === "accepted") {
    delete rejected[target];
    delete ignored[target];
    accepted[target] = fingerprint;
  } else if (outcome === "rejected") {
    rejected[target] = { count: Math.min((rejected[target]?.count ?? 0) + 1, REJECTION_LIMIT), fingerprint };
    delete ignored[target];
    delete accepted[target];
  } else ignored[target] = fingerprint;
  return { ...state, rejected, ignored, accepted };
}

/** "Reset personalisation": forgets every count and answer, keeps the person's on/off choice. */
export function resetPersonalisation(state: PersonalisationState): PersonalisationState {
  return { ...INITIAL_STATE, consent: state.consent };
}

/**
 * Which signal (if any) an explicit display change counts as. Pass the person's text size before the change.
 * Only changes kept from Settings or Voice Mode are counted (see controller.ts). Dial's own suggestions, "Make it yours"
 * styles and view switches are never counted. Opening Voice Mode counts as "voiceSessions"; undoing a counted change
 * as "undoneChanges".
 */
export function signalForAction(action: unknown, before?: { textSize?: number }): SignalId | null {
  if (!isObj(action)) return null;
  switch (action.type) {
    case "textSize":
      if (typeof action.value !== "number" || typeof before?.textSize !== "number" || action.value === before.textSize) return null;
      return action.value > before.textSize ? "textLarger" : "textSmaller";
    case "density":
      return action.value === "calm" ? "lessOnScreen" : action.value === "standard" ? "moreDetail" : null;
    case "hide":
      return "lessOnScreen";
    case "show":
      return "moreDetail";
    default:
      return null;
  }
}

type ReadStore = Pick<Storage, "getItem">;
type WriteStore = Pick<Storage, "setItem" | "removeItem">;
/** Merely reading window.localStorage throws where storage is blocked, so this must never throw: undefined means "no storage". */
const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

/** Never throws: private mode, blocked storage or corrupt data all give the initial (consent unset) state. */
export function loadState(storage: ReadStore | undefined = browserStorage()): PersonalisationState {
  try {
    const raw = storage?.getItem(PERSONALISATION_STORAGE_KEY);
    return raw && raw.length < 4000 ? sanitizeState(JSON.parse(raw)) : INITIAL_STATE;
  } catch {
    return INITIAL_STATE;
  }
}

/** Never throws. Returns false if the state couldn't be stored (it still works for this visit). */
export function saveState(state: PersonalisationState, storage: WriteStore | undefined = browserStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PERSONALISATION_STORAGE_KEY, JSON.stringify(sanitizeState(state)));
    return true;
  } catch {
    return false;
  }
}

/** Deletes everything stored on this device. Never throws. */
export function clearState(storage: WriteStore | undefined = browserStorage()): boolean {
  try {
    storage?.removeItem(PERSONALISATION_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
