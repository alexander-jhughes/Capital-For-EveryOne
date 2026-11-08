// What is different from the standard look right now, as the same actions Dial and Settings use, so each one can be
// described in plain words ("make the text 150% of the standard size") and shown as "your changes".
import { DEFAULT_PREFS, type Preferences, type UiAction } from "../preferences/schema";

/** Consent and setup choices aren't adaptations; layout and the night look are listed in their own terms below. */
const NOT_ADAPTATIONS = new Set<keyof Preferences>(["onboarding", "speechInput", "layout", "night"]);

export function activeChanges(p: Preferences): UiAction[] {
  const out: UiAction[] = [];
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof Preferences)[]) {
    if (NOT_ADAPTATIONS.has(key) || p[key] === DEFAULT_PREFS[key]) continue;
    out.push({ type: key, value: p[key] } as UiAction);
  }
  if (p.night.length > 0) out.push({ type: "nightLook", actions: p.night });
  const l = p.layout;
  if (l.density !== "standard") out.push({ type: "density", value: l.density });
  for (const w of l.pinned) out.push({ type: "moveToTop", widget: w });
  if (l.emphasis) out.push({ type: "emphasize", widget: l.emphasis });
  for (const w of l.hidden) out.push({ type: "hide", widget: w });
  // Moving a section to the top also shows it, so only list sections shown on their own.
  for (const w of l.shown) if (!l.pinned.includes(w)) out.push({ type: "show", widget: w });
  return out;
}

/** The action that turns one active change off again, or null where there is no single opposite (a section moved up). */
export function turnOff(a: UiAction): UiAction | null {
  switch (a.type) {
    case "nightLook":
      return { type: "nightOff" };
    case "density":
      return { type: "density", value: "standard" };
    case "emphasize":
      return { type: "clearEmphasis" };
    case "hide":
      return { type: "show", widget: a.widget };
    case "show":
      return { type: "hide", widget: a.widget };
    case "moveToTop":
    case "clearEmphasis":
    case "reset":
    case "nightOff":
      return null;
    default:
      return { type: a.type, value: DEFAULT_PREFS[a.type] } as UiAction;
  }
}
