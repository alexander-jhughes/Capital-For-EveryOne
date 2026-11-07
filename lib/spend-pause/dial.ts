// What Dial can do with Spend Pause. See docs/SPEND-PAUSE.md.
// Nothing here changes a setting. Dial reads the status, or sends the person to a confirmation they answer themselves.
import type { SpendPauseSettings } from "../types";
import { describeChecks, hasChecks } from "./settings";

export type SpendPauseRequest = "status" | "turn_on" | "turn_off" | "can_turn_off" | "help";

/** Plain words for a request, with no AI involved. Anything else returns null and stays with Dial. */
export function matchSpendPauseRequest(text: string): SpendPauseRequest | null {
  const q = text.toLowerCase().replace(/[’']/g, "").trim();
  if (/\b(can|could|how do) i (turn|switch) (it|spend pause) off\b|\bcan i (stop|cancel) (it|spend pause)\b/.test(q)) return "can_turn_off";
  if (/\b(turn|switch) off\b.*\bpause\b|\bpause\b.*\b(off)\b(?!\?)|\bdisable\b.*\bpause\b/.test(q) && !/\bis\b/.test(q)) return "turn_off";
  if (/\b(turn|switch) on\b.*\bpause\b|\b(turn|switch)\b.*\bpause\b.*\bon\b|\benable\b.*\bpause\b/.test(q) && !/\bis\b/.test(q)) return "turn_on";
  if (/\bis\b.*\bpause\b|\bpause\b.*\b(on|enabled|active)\b/.test(q)) return "status";
  return /\b(avoid|stop|cut down on|reduce)\b.*\b(unnecessary|impulse|overspending|spending)\b|\boverspending\b/.test(q) ? "help" : null;
}

/** A sentence for Dial to say. It never claims more than the demo does. */
export function spendPauseStatus(settings: SpendPauseSettings): string {
  if (!settings.enabled) return "Spend Pause is off.";
  const checks = describeChecks(settings).map((check) => check.replace(/^Any purchase/, "any purchase"));
  return checks.length > 0 ? `Spend Pause is on. It checks with you first for ${checks.join(", and ")}, in the demo shop.` : "Spend Pause is on, but it has nothing to check yet.";
}

export interface SpendPauseProposal {
  /** Where to send the person. The screen asks them to confirm before anything changes. */
  href: string;
  message: string;
}

/** The next step for turning Spend Pause on or off, or null when it's already that way. */
export function proposeSpendPause(settings: SpendPauseSettings, enabled: boolean): SpendPauseProposal | null {
  if (settings.enabled === enabled) return null;
  if (enabled && !hasChecks(settings)) return { href: "/account/spend-pause", message: "Choose what Spend Pause should check first." };
  return {
    href: `/account/spend-pause?confirm=${enabled ? "on" : "off"}`,
    message: enabled ? "I can't turn this on for you, but you can confirm it here." : "I can't turn this off for you, but you can confirm it here.",
  };
}

/** A confirmation link that is safe to act on: it only opens the question, and only when the answer would change something. */
export function confirmationFor(settings: SpendPauseSettings, requested: string | undefined): "on" | "off" | null {
  if (requested === "on" && !settings.enabled && hasChecks(settings)) return "on";
  return requested === "off" && settings.enabled ? "off" : null;
}
