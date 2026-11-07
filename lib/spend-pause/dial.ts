// What Dial can do with Spend Pause. See docs/SPEND-PAUSE.md.
// Nothing here changes a setting. Dial reads the status, or sends the person to a confirmation they answer themselves.
import { londonDate, londonTime } from "../demo-clock";
import { formatLongDate } from "../format";
import type { SpendPauseSettings } from "../types";
import { describeChecks, hasChecks } from "./settings";
import type { SpendPauseActivity } from "./state";

export type SpendPauseRequest = "status" | "turn_on" | "turn_off" | "can_turn_off" | "help" | "what_it_does" | "when_activated" | "balance_effect";

/** Plain words for a request, with no AI involved. Anything else returns null and stays with Dial. */
export function matchSpendPauseRequest(text: string): SpendPauseRequest | null {
  const q = text.toLowerCase().replace(/[’']/g, "").trim();
  // These come first: each one also contains words that would read as a status question.
  if (/\bwhen did i (activate|enable|start|turn on|switch on|turn it on|switch it on|turn spend pause on)\b|\bwhen was\b.*\bpause\b.*\b(activated|enabled|turned on|switched on|started)\b/.test(q)) return "when_activated";
  if (/\bpause\b/.test(q) && /\b(balance|statement|bill|minimum|due date|what i owe|how much i owe)\b/.test(q)) return "balance_effect";
  if (/\b(what|how)\b.*\b(is|does|do|happens)\b.*\bpause\b|\bwhat happens (while|when) (it|spend pause) is (active|on)\b|\bwhat\b.*\bpause\b.*\b(do|does|mean)\b/.test(q)) return "what_it_does";
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

const whenLabel = (iso: string) => {
  const at = new Date(iso);
  return `${formatLongDate(londonDate(at))} at ${londonTime(at)}`;
};

/** "Since Sunday 8 November at 10:00", or null with no record of it. Saved settings from before this was kept have none. */
export const activeSince = (settings: SpendPauseSettings, activity: SpendPauseActivity) =>
  settings.enabled && activity.activatedAt ? whenLabel(activity.activatedAt) : null;

const whenAnswer = (settings: SpendPauseSettings, activity: SpendPauseActivity) => {
  const { activatedAt, deactivatedAt } = activity;
  if (settings.enabled) return activatedAt ? `You turned on Spend Pause on ${whenLabel(activatedAt)}.` : "Spend Pause is on, but I don't have a record of when it was turned on.";
  if (!activatedAt) return "You haven't turned on Spend Pause yet.";
  return `You last turned on Spend Pause on ${whenLabel(activatedAt)}${deactivatedAt ? `, and turned it off on ${whenLabel(deactivatedAt)}` : ""}.`;
};

export interface SpendPauseReply {
  text: string;
  /** Where the person can act on it. Opening this never changes a setting by itself. */
  action?: { href: string; label: string };
}

/** Dial's answer about Spend Pause, from live state. Null when the question isn't about it. No AI, and no setting changes. */
export function spendPauseReply(question: string, settings: SpendPauseSettings, activity: SpendPauseActivity): SpendPauseReply | null {
  const request = matchSpendPauseRequest(question);
  if (!request) return null;
  const status = spendPauseStatus(settings);
  const open = { href: "/account/spend-pause", label: "Open Spend Pause" };
  const since = activeSince(settings, activity);
  const offer = (enabled: boolean) => {
    const proposal = proposeSpendPause(settings, enabled);
    return proposal ? { text: proposal.message, action: { href: proposal.href, label: enabled ? "Turn on Spend Pause" : "Turn off Spend Pause" } } : null;
  };
  switch (request) {
    case "status":
      return { text: since ? `${status} It has been on since ${since}.` : status, action: open };
    case "when_activated":
      return { text: whenAnswer(settings, activity), action: open };
    case "what_it_does":
      return {
        text: `Spend Pause asks you first before the purchases you've chosen to check in the demo shop, and you always make the final choice. It's a simulated check, so it can't stop purchases on a real card. ${status}`,
        action: open,
      };
    case "balance_effect":
      return { text: "No. Turning Spend Pause on or off doesn't change your balance, statement balance, minimum payment or due date, or anything you've already bought.", action: open };
    case "can_turn_off": {
      if (!settings.enabled) return { text: "Spend Pause is already off.", action: open };
      const next = offer(false);
      return { text: "Yes, you can turn it off at any time.", action: next?.action };
    }
    case "turn_on":
      return offer(true) ?? { text: "Spend Pause is already on.", action: open };
    case "turn_off":
      return offer(false) ?? { text: "Spend Pause is already off.", action: open };
    case "help":
      return { text: `Spend Pause can help. It asks you first before purchases you've chosen to check, in the demo shop. ${status}`, action: settings.enabled ? open : offer(true)?.action };
  }
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
