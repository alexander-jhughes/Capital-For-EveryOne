// The settings form, shared by Simple's one-question screens and Complex's single form.
import { formatPence } from "../format";
import type { Pence, SpendPauseSettings } from "../types";

export const THRESHOLD_PRESETS: Pence[] = [5000, 10000, 20000];
const MAX_AMOUNT: Pence = 10_000_000;

export type ThresholdChoice = "none" | "other" | `${number}`;

export interface SettingsForm {
  threshold: ThresholdChoice;
  otherAmount: string;
  budgetOn: boolean;
  budgetAmount: string;
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
}

export type FormField = "threshold" | "otherAmount" | "budgetAmount" | "quietHours";
export type FormErrors = Partial<Record<FormField, string>>;

/** Pounds as typed, to whole pence, without ever holding money in a float. Null if it isn't an amount. */
export function parsePounds(text: string): Pence | null {
  const match = text.trim().replace(/^£/, "").replace(/,/g, "").match(/^(\d{1,7})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

const toPounds = (pence: Pence) => (pence % 100 === 0 ? String(pence / 100) : formatPence(pence).replace(/[£,]/g, ""));

export function formFromSettings(settings: SpendPauseSettings): SettingsForm {
  const threshold = settings.singlePurchaseThreshold;
  const isPreset = threshold !== null && THRESHOLD_PRESETS.includes(threshold);
  return {
    threshold: threshold === null ? "none" : isPreset ? (String(threshold) as ThresholdChoice) : "other",
    otherAmount: threshold !== null && !isPreset ? toPounds(threshold) : "",
    budgetOn: settings.monthlyBudget !== null,
    budgetAmount: settings.monthlyBudget !== null ? toPounds(settings.monthlyBudget) : "",
    quietOn: settings.quietHours !== null,
    quietStart: settings.quietHours?.start ?? "22:00",
    quietEnd: settings.quietHours?.end ?? "06:00",
  };
}

const amountError = (text: string, what: string) => {
  const pence = parsePounds(text);
  if (pence === null) return `Enter ${what} in pounds, like 75 or 75.50.`;
  if (pence <= 0) return `${what[0].toUpperCase()}${what.slice(1)} needs to be more than £0.`;
  return pence > MAX_AMOUNT ? `${what[0].toUpperCase()}${what.slice(1)} needs to be £100,000 or less.` : null;
};

/** Plain-English errors for one step, or for the whole form when no step is given. */
export function validateForm(form: SettingsForm, step?: "threshold" | "budget" | "quietHours"): FormErrors {
  const errors: FormErrors = {};
  const checks = (s: "threshold" | "budget" | "quietHours") => !step || step === s;
  if (checks("threshold") && form.threshold === "other") {
    const error = amountError(form.otherAmount, "an amount");
    if (error) errors.otherAmount = error;
  }
  if (checks("budget") && form.budgetOn) {
    const error = amountError(form.budgetAmount, "a budget");
    if (error) errors.budgetAmount = error;
  }
  if (checks("quietHours") && form.quietOn) {
    const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!valid.test(form.quietStart) || !valid.test(form.quietEnd)) errors.quietHours = "Enter both times.";
    else if (form.quietStart === form.quietEnd) errors.quietHours = "The start and end times need to be different.";
  }
  if (!step && Object.keys(errors).length === 0 && form.threshold === "none" && !form.budgetOn && !form.quietOn) {
    errors.threshold = "Choose at least one thing for Spend Pause to check.";
  }
  return errors;
}

/** The settings a valid form describes. Only the form's choices change; `enabled` is kept as it was. */
export function settingsFromForm(form: SettingsForm, enabled: boolean): SpendPauseSettings {
  const threshold = form.threshold === "none" ? null : form.threshold === "other" ? parsePounds(form.otherAmount) : Number(form.threshold);
  return {
    enabled,
    singlePurchaseThreshold: threshold,
    monthlyBudget: form.budgetOn ? parsePounds(form.budgetAmount) : null,
    quietHours: form.quietOn ? { start: form.quietStart, end: form.quietEnd } : null,
  };
}

/** True when Spend Pause has something to check. Without this, turning it on would do nothing. */
export const hasChecks = (s: SpendPauseSettings) => s.singlePurchaseThreshold !== null || s.monthlyBudget !== null || s.quietHours !== null;

/** Each check in plain English, for the status card, confirmations and Dial. */
export function describeChecks(s: SpendPauseSettings): string[] {
  return [
    ...(s.singlePurchaseThreshold !== null ? [`Any purchase over ${formatPence(s.singlePurchaseThreshold)}`] : []),
    ...(s.monthlyBudget !== null ? [`Any purchase that would go over your ${formatPence(s.monthlyBudget)} monthly budget`] : []),
    ...(s.quietHours ? [`Any purchase between ${s.quietHours.start} and ${s.quietHours.end}`] : []),
  ];
}
