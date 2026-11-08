// Pure glue between the preferences provider and Dial's personalisation API. No React, no network.
//
// Rules (docs/ml-personalisation/v2/CONTRACT.md):
//   - signals: only display changes the person KEPT from Display and voice ("settings") or Voice Mode ("voice"),
//     plus opening Voice Mode. "Make it yours" styles, Dial's own suggestions, onboarding and untagged changes are
//     never counted. Previews never emit events. Nothing is counted without consent.
//   - explicit dimensions: anything the person set themselves (settings, voice, a "Make it yours" style, the view
//     switch). Dial never suggests a change on an explicit dimension.
//   - reverts: a kept suggestion that is no longer in effect is reported once, with how it was undone.
import type { ChangeSource, PrefsEvent } from "../preferences/events";
import type { Preferences, UiAction } from "../preferences/schema";
import { type Dimension, dimensionOfAction, isActive, isItemId, type ItemId } from "../recommender/catalog";
import type { SignalId, SignalSource } from "../recommender/types";
import type { Mode } from "../types";

export const COUNTED_SOURCES: readonly ChangeSource[] = ["settings", "voice"];
export const EXPLICIT_SOURCES: readonly ChangeSource[] = ["settings", "voice", "style"];

/** Which signal one kept action is, if any. */
export function signalForAction(a: UiAction, before: Preferences): SignalId | null {
  switch (a.type) {
    case "textSize":
      return a.value === before.textSize ? null : a.value > before.textSize ? "textLarger" : "textSmaller";
    case "density":
      return a.value === before.layout.density ? null : a.value === "calm" ? "lessOnScreen" : "moreDetail";
    case "hide":
      return "lessOnScreen";
    case "show":
    case "moveToTop":
      return a.widget === "chart" ? "moreVisual" : a.type === "show" ? "moreDetail" : null;
    default:
      return null;
  }
}

/** Signals for one preferences event. Empty for previews (never emitted), styles, ML, onboarding and resets. */
export function signalsForEvent(e: PrefsEvent): { id: SignalId; source: SignalSource }[] {
  if (e.kind === "kept") {
    if (!COUNTED_SOURCES.includes(e.source)) return [];
    const source = e.source as SignalSource;
    return e.actions.flatMap((a) => {
      const id = signalForAction(a, e.before);
      return id ? [{ id, source }] : [];
    });
  }
  if (e.kind === "undo" && COUNTED_SOURCES.includes(e.undoneSource)) return [{ id: "undoneChanges", source: e.undoneSource as SignalSource }];
  return [];
}

/** The signal for switching view with the Dial switch (never during a preview). */
export const signalForViewChange = (to: Mode): SignalId => (to === "complex" ? "moreDetail" : "lessOnScreen");

/**
 * The view is the person's own choice once they have used the Dial switch (or kept a style): only then does the
 * `cfe-mode` cookie exist. This covers choices made before suggestions were turned on, which nothing recorded.
 */
export const viewWasChosen = (cookie: string) => /(?:^|;\s*)cfe-mode=/.test(cookie);

/** Dimensions the person set themselves in this event. A style also chooses the view. */
export function explicitForEvent(e: PrefsEvent): Dimension[] {
  if (e.kind !== "kept" || !EXPLICIT_SOURCES.includes(e.source)) return [];
  const dims = e.actions.map(dimensionOfAction).filter((d): d is Dimension => d !== null);
  if (e.source === "style") dims.push("view");
  return [...new Set(dims)];
}

// ---------------------------------------------------------------------------------------------------------------
// Kept suggestions, watched so that undoing one later counts as a "no" (sent once, then forgotten).
// ---------------------------------------------------------------------------------------------------------------

export interface Watched {
  id: string;
  items: ItemId[];
}

export type RevertVia = "undo" | "settings" | "reset";

/** Kept items that are no longer in effect, grouped by suggestion. */
export function revertedItems(watch: readonly Watched[], prefs: Preferences, view: Mode): Watched[] {
  return watch.map((w) => ({ id: w.id, items: w.items.filter((i) => !isActive(i, prefs, view)) })).filter((w) => w.items.length > 0);
}

/** The watch list without the reverted items (and without suggestions that have none left). */
export function withoutReverted(watch: readonly Watched[], reverted: readonly Watched[]): Watched[] {
  return watch
    .map((w) => {
      const gone = reverted.find((r) => r.id === w.id)?.items ?? [];
      return { id: w.id, items: w.items.filter((i) => !gone.includes(i)) };
    })
    .filter((w) => w.items.length > 0);
}

/** Why a kept suggestion stopped being in effect, from the event that changed it. */
export function revertVia(e: PrefsEvent | null): RevertVia {
  if (e?.kind === "reset") return "reset";
  if (e?.kind === "undo") return "undo";
  return "settings";
}

export function sanitizeWatch(v: unknown): Watched[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((w): w is { id: string; items: unknown[] } => typeof w === "object" && w !== null && typeof w.id === "string" && w.id.length <= 100 && Array.isArray(w.items))
    .map((w) => ({ id: w.id, items: [...new Set(w.items.filter(isItemId))] }))
    .filter((w) => w.items.length > 0)
    .slice(-20);
}

// ---------------------------------------------------------------------------------------------------------------
// Device storage. Only the watch list, only with consent. Every access is guarded: storage can be blocked.
// ---------------------------------------------------------------------------------------------------------------

export const WATCH_KEY = "cfe-personalisation-v2";
/** v1 kept its on-device suggestion data here. v2 replaces it; the old data is deleted. */
export const LEGACY_KEY = "cfe-personalisation";

const storage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export function loadWatch(): Watched[] {
  try {
    return sanitizeWatch(JSON.parse(storage()?.getItem(WATCH_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function saveWatch(watch: readonly Watched[]) {
  try {
    if (watch.length === 0) storage()?.removeItem(WATCH_KEY);
    else storage()?.setItem(WATCH_KEY, JSON.stringify(watch));
  } catch {}
}

/** Deletes v1's on-device data. Returns true if v1 suggestions had been turned on in this browser. */
export function takeLegacy(): boolean {
  try {
    const s = storage();
    const raw = s?.getItem(LEGACY_KEY);
    if (raw == null) return false;
    s?.removeItem(LEGACY_KEY);
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && (v as { consent?: unknown }).consent === "granted";
  } catch {
    return false;
  }
}

/** The Home suggestion card shows only when every condition holds. */
export function shouldShowCard(x: {
  consented: boolean;
  suggestionId: string | null;
  onboarding: Preferences["onboarding"];
  previewActive: boolean;
  answered: ReadonlySet<string>;
}): boolean {
  return x.consented && x.suggestionId !== null && x.onboarding !== "unset" && !x.previewActive && !x.answered.has(x.suggestionId);
}
