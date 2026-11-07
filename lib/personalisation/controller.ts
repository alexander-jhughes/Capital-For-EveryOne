// Pure glue between the preferences provider and the ML engine. No React, no storage, no network.
//
// Behaviour-signal rules (docs/ml-personalisation/README.md, "Integration"):
//   - only changes the person KEPT from Display and voice ("settings") or Voice Mode ("voice") are counted;
//   - "Make it yours" styles, Dial's own suggestions, onboarding and anything untagged are never counted;
//   - previews and rejected previews never reach here (the provider only emits kept changes, undo and reset);
//   - nothing is counted without consent.
import type { ChangeSource, PrefsEvent } from "../preferences/events";
import type { Preferences } from "../preferences/schema";
import { explicitFingerprint, extractFeatures, type PersonalisationInput } from "./features";
import type { PersonalisationResult } from "./infer";
import { type Consent, type PersonalisationState, recordSignal, REJECTION_LIMIT, signalForAction } from "./state";
import { TARGET_IDS, targetStatus } from "./targets";

export const COUNTED_SOURCES: readonly ChangeSource[] = ["settings", "voice"];

/** Applies one preferences event to the ML state. */
export function onPrefsEvent(state: PersonalisationState, e: PrefsEvent): PersonalisationState {
  if (state.consent !== "granted") return state;
  if (e.kind === "kept") {
    if (!COUNTED_SOURCES.includes(e.source)) return state;
    let next = state;
    for (const a of e.actions) {
      const s = signalForAction(a, { textSize: e.before.textSize });
      if (s) next = recordSignal(next, s);
    }
    return next;
  }
  if (e.kind === "undo") return COUNTED_SOURCES.includes(e.undoneSource) ? recordSignal(state, "undoneChanges") : state;
  return state; // reset: preferences only, ML data untouched
}

/**
 * A suggestion the person kept that is no longer on (undone, reset or changed back in Settings) counts as a "no",
 * so Dial doesn't offer it straight back. Returns the same object when nothing changed.
 */
export function reconcile(state: PersonalisationState, input: PersonalisationInput): PersonalisationState {
  if (state.consent !== "granted") return state;
  const reverted = TARGET_IDS.filter((id) => state.accepted[id] !== undefined && targetStatus(id, input.preferences) !== "on");
  if (reverted.length === 0) return state;
  const fingerprint = explicitFingerprint(extractFeatures(input, state.signals));
  const accepted = { ...state.accepted };
  const rejected = { ...state.rejected };
  for (const id of reverted) {
    delete accepted[id];
    rejected[id] = { count: Math.min((rejected[id]?.count ?? 0) + 1, REJECTION_LIMIT), fingerprint };
  }
  return { ...state, accepted, rejected };
}

/** The Home suggestion card shows only when every condition holds. */
export function shouldShowCard(x: {
  consent: Consent;
  result: PersonalisationResult | null;
  onboarding: Preferences["onboarding"];
  previewActive: boolean;
}): boolean {
  return x.consent === "granted" && x.result?.status === "ok" && x.result.preferences.length > 0 && x.onboarding !== "unset" && !x.previewActive;
}
