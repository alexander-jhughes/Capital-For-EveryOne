// SIMILAR-USER DEMO. Three SYNTHETIC sample profiles (demo data only: not real customers, not Capital One data) and a
// deterministic similarity score against the person's own display choices. This is NOT a trained model: it is a plain
// nearest-profile match, so the explanation can say exactly which choices matched. Pure and on the device.
import type { Preferences } from "../preferences/schema";
import type { Mode } from "../types";

export const SIGNALS = ["largerText", "largeTargets", "stepByStep", "calmLayout", "highContrast", "reducedMotion", "briefAnswers", "voiceFirst"] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_LABEL: Record<Signal, string> = {
  largerText: "larger text",
  largeTargets: "bigger buttons",
  stepByStep: "step-by-step explanations",
  calmLayout: "a calmer home screen",
  highContrast: "stronger contrast",
  reducedMotion: "less motion",
  briefAnswers: "shorter answers",
  voiceFirst: "talking to Dial first",
};

export interface SampleProfile {
  id: string;
  label: string;
  summary: string;
  traits: string[];
  /** How strongly people like this choose each setting, 0 to 1. */
  weights: Record<Signal, number>;
  recommends: Mode;
  reason: string;
}

export const SAMPLE_PROFILES: SampleProfile[] = [
  {
    id: "a",
    label: "Sample profile A, age 68",
    summary: "Checks balances and pays bills online; less confident with busy screens.",
    traits: ["Prefers larger text", "Likes straightforward explanations", "Mostly checks balances and bills"],
    weights: { largerText: 1, largeTargets: 0.9, stepByStep: 0.9, calmLayout: 0.7, highContrast: 0.5, reducedMotion: 0.4, briefAnswers: 0.4, voiceFirst: 0.5 },
    recommends: "simple",
    reason: "People with similar accessibility preferences often find a simpler layout easier to navigate.",
  },
  {
    id: "b",
    label: "Sample profile B, age 34",
    summary: "Busy professional with regular transactions and several commitments.",
    traits: ["Comfortable with technology", "Wants detailed spending breakdowns", "Likes quick insights"],
    weights: { largerText: 0, largeTargets: 0, stepByStep: 0, calmLayout: 0, highContrast: 0, reducedMotion: 0, briefAnswers: 0.2, voiceFirst: 0 },
    recommends: "complex",
    reason: "People who keep the standard settings usually like seeing every breakdown at once.",
  },
  {
    id: "c",
    label: "Sample profile C, age 21",
    summary: "Student with irregular income and spending.",
    traits: ["Prefers visual, clear guidance", "Wants less on screen", "Likes short answers"],
    weights: { largerText: 0, largeTargets: 0.2, stepByStep: 0.4, calmLayout: 0.9, highContrast: 0, reducedMotion: 0.5, briefAnswers: 0.9, voiceFirst: 0.3 },
    recommends: "simple",
    reason: "People who want less on screen and shorter answers often find the simpler layout calmer.",
  },
];

export function signalsFrom(p: Preferences): Record<Signal, number> {
  return {
    largerText: p.textSize >= 125 ? 1 : 0,
    largeTargets: p.targets === "large" ? 1 : 0,
    stepByStep: p.explanations === "stepByStep" ? 1 : 0,
    calmLayout: p.layout.density === "calm" ? 1 : 0,
    highContrast: p.contrast === "high" ? 1 : 0,
    reducedMotion: p.motion === "reduced" ? 1 : 0,
    briefAnswers: p.answerStyle === "brief" ? 1 : 0,
    voiceFirst: p.voiceFirst ? 1 : 0,
  };
}

export interface SimilarMatch {
  profile: SampleProfile;
  /** 0-100: 100 means the same choices as the sample profile. */
  similarity: number;
  /** The person's own choices that this profile shares. */
  matched: Signal[];
}

/** The closest sample profile, or null when the person hasn't changed any setting yet (nothing to compare). */
export function closestProfile(p: Preferences, profiles: SampleProfile[] = SAMPLE_PROFILES): SimilarMatch | null {
  const s = signalsFrom(p);
  if (!SIGNALS.some((k) => s[k] === 1)) return null;
  let best: SimilarMatch | null = null;
  for (const profile of profiles) {
    const dist = Math.sqrt(SIGNALS.reduce((sum, k) => sum + (s[k] - profile.weights[k]) ** 2, 0));
    const similarity = Math.round((1 - dist / Math.sqrt(SIGNALS.length)) * 100);
    if (!best || similarity > best.similarity) best = { profile, similarity, matched: SIGNALS.filter((k) => s[k] === 1 && profile.weights[k] >= 0.5) };
  }
  return best;
}
