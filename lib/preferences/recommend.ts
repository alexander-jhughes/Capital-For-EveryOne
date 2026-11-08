// "Make it yours": a transparent, rule-based style suggestion. It is NOT machine learning.
// Input is only what the person ticks. It never sees transactions, spending, age or account data,
// never infers a condition, and keeps no score about the person: just points per style, shown to them.
import type { Mode } from "../types";
import type { UiAction } from "./schema";

export const CHOICES = [
  { id: "largerText", label: "Larger text" },
  { id: "lessInfo", label: "Less information on screen" },
  { id: "moreVisual", label: "More charts and visual information" },
  { id: "stepByStep", label: "Step-by-step explanations" },
  { id: "voiceFirst", label: "Talking to Dial instead of tapping" },
  { id: "moreDetail", label: "More detailed financial information" },
  { id: "reducedMotion", label: "Less animation" },
  { id: "highContrast", label: "Stronger contrast" },
  { id: "paymentsProminent", label: "Upcoming payments easier to see" },
] as const;
export type ChoiceId = (typeof CHOICES)[number]["id"];

export const STYLE_ORDER = ["calm", "visual", "detailed", "voice"] as const;
export type StyleId = (typeof STYLE_ORDER)[number];

export const STYLES: Record<StyleId, { name: string; summary: string; mode: Mode; actions: UiAction[] }> = {
  calm: {
    name: "Calm & Clear",
    summary: "Simple view, fewer sections on the home screen and more space between things.",
    mode: "simple",
    actions: [{ type: "density", value: "calm" }, { type: "spacing", value: "roomy" }],
  },
  visual: {
    name: "Visual Insights",
    summary: "Detailed view with your spending chart near the top.",
    mode: "complex",
    actions: [{ type: "density", value: "standard" }, { type: "show", widget: "chart" }, { type: "moveToTop", widget: "chart" }],
  },
  detailed: {
    name: "Detailed Finance",
    summary: "Detailed view with every section: balance, bill, insights, budget, chart and activity.",
    mode: "complex",
    actions: [{ type: "density", value: "standard" }],
  },
  voice: {
    name: "Accessible Voice",
    summary: "Simple view with talking to Dial as the first option and bigger buttons.",
    mode: "simple",
    actions: [{ type: "voiceFirst", value: true }, { type: "targets", value: "large" }],
  },
};

/** The published rule table: points each choice gives each style. */
export const WEIGHTS: Record<ChoiceId, Partial<Record<StyleId, number>>> = {
  largerText: { calm: 1, voice: 1 },
  lessInfo: { calm: 3 },
  moreVisual: { visual: 3 },
  stepByStep: { calm: 2, voice: 1 },
  voiceFirst: { voice: 3 },
  moreDetail: { detailed: 3, visual: 1 },
  reducedMotion: { calm: 1 },
  highContrast: {},
  paymentsProminent: { calm: 1, detailed: 1 },
};

/** Settings each choice turns on directly, whatever style is suggested. */
const DIRECT: Record<ChoiceId, UiAction[]> = {
  largerText: [{ type: "textSize", value: 125 }],
  lessInfo: [{ type: "density", value: "calm" }],
  moreVisual: [],
  stepByStep: [{ type: "explanations", value: "stepByStep" }],
  voiceFirst: [{ type: "voiceFirst", value: true }],
  moreDetail: [],
  reducedMotion: [{ type: "motion", value: "reduced" }],
  highContrast: [{ type: "contrast", value: "high" }],
  paymentsProminent: [{ type: "moveToTop", widget: "bill" }, { type: "emphasize", widget: "bill" }],
};

export interface Recommendation {
  style: StyleId;
  scores: Record<StyleId, number>;
  /** The ticked choices that added points to the suggested style, in the order shown. */
  reasons: { label: string; points: number }[];
  /** Ticked choices applied directly as settings. */
  direct: string[];
  mode: Mode;
  /** Allowlisted actions only: style preset first, then direct settings (which win), then onboarding done. */
  actions: UiAction[];
}

const label = (id: ChoiceId) => CHOICES.find((c) => c.id === id)!.label;

/** Deterministic: the same ticks always give the same suggestion. Returns null when nothing is ticked. */
export function recommend(choices: ChoiceId[]): Recommendation | null {
  const picked = CHOICES.map((c) => c.id).filter((id) => choices.includes(id));
  if (picked.length === 0) return null;

  const scores = Object.fromEntries(STYLE_ORDER.map((s) => [s, 0])) as Record<StyleId, number>;
  for (const id of picked) for (const [s, pts] of Object.entries(WEIGHTS[id]) as [StyleId, number][]) scores[s] += pts;

  // Highest score wins; ties go to the earlier style in STYLE_ORDER (calmest first).
  const style = STYLE_ORDER.reduce((best, s) => (scores[s] > scores[best] ? s : best), STYLE_ORDER[0]);
  const reasons = picked.filter((id) => (WEIGHTS[id][style] ?? 0) > 0).map((id) => ({ label: label(id), points: WEIGHTS[id][style]! }));
  const directIds = picked.filter((id) => DIRECT[id].length > 0);

  return {
    style,
    scores,
    reasons,
    direct: directIds.map(label),
    mode: STYLES[style].mode,
    actions: [...STYLES[style].actions, ...directIds.flatMap((id) => DIRECT[id]), { type: "onboarding", value: "done" }],
  };
}
