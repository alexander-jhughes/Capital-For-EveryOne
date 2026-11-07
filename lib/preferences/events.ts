// Events PreferencesProvider emits after a change is committed, and where each change came from.
// Used by the optional ML suggestions (lib/personalisation) to count explicit display changes.
// Previews never emit: only kept changes, undo and reset do.
import type { Preferences, UiAction } from "./schema";

/**
 * settings: Display and voice page. voice: a Voice Mode request the person kept. style: a "Make it yours" style.
 * ml: an ML suggestion the person kept. other: anything else (onboarding skip, voice reset...), the safe default.
 */
export type ChangeSource = "settings" | "voice" | "style" | "ml" | "other";

export type PrefsEvent =
  | { kind: "kept"; actions: UiAction[]; before: Preferences; after: Preferences; source: ChangeSource }
  | { kind: "undo"; before: Preferences; after: Preferences; undoneSource: ChangeSource }
  | { kind: "reset"; before: Preferences };

export type PrefsListener = (e: PrefsEvent) => void;

/** Calls every listener; a failing listener never breaks the preferences provider or the other listeners. */
export function emit(listeners: Iterable<PrefsListener>, e: PrefsEvent) {
  for (const l of listeners) {
    try {
      l(e);
    } catch {}
  }
}
