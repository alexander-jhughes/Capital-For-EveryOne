// What an adaptation the person didn't spell out may never do. The rules and the catalogue never hide these sections;
// this check is for steps a model chose (Groq through /api/dial), which are already validated against the allowlist but
// could still hide something that matters by misreading "less on screen".
import type { DialStep } from "../dial/types";
import type { UiAction, WidgetId } from "../preferences/schema";

/** What is due, Spend Pause, and Dial's warnings (possible duplicates, price changes). */
export const PROTECTED_WIDGETS: readonly WidgetId[] = ["bill", "pause", "insights"];

export const PROTECTED_NOTE =
  "I won't hide your bill, Spend Pause or Dial's warnings on my own. If you really want one gone, you can hide it yourself in Settings.";

const hidesProtected = (a: UiAction) => a.type === "hide" && PROTECTED_WIDGETS.includes(a.widget);

/** Model-chosen steps without any hide of a protected section. `removed` says whether anything was taken out. */
export function withoutProtectedHides(steps: DialStep[]): { steps: DialStep[]; removed: boolean } {
  let removed = false;
  const out: DialStep[] = [];
  for (const step of steps) {
    if (step.type !== "preferences") {
      out.push(step);
      continue;
    }
    const actions = step.actions.filter((a) => !hidesProtected(a));
    if (actions.length !== step.actions.length) removed = true;
    if (actions.length > 0) out.push({ ...step, actions });
  }
  return { steps: out, removed };
}
