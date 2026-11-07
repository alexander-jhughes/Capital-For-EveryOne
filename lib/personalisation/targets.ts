// The presentation preferences the model predicts. Each is one binary question:
// "would this person keep this setting if Dial offered it?" Only asked when the setting is currently off.
// Suggested changes use the same shapes as `UiAction` in lib/preferences/schema.ts, so the frontend can
// preview them with the existing PreferencesProvider.startPreview(). Nothing here applies anything.
import type { UiAction } from "../preferences/schema";
import type { PreferenceSnapshot } from "./features";

export const TARGET_IDS = [
  "largerText",
  "calmLayout",
  "visualSummary",
  "stepByStep",
  "voiceFirst",
  "reducedMotion",
  "highContrast",
  "paymentsProminent",
] as const;
export type TargetId = (typeof TARGET_IDS)[number];

/** A subset of `UiAction` (lib/preferences/schema.ts), checked at compile time below. */
export type SuggestedAction =
  | { type: "textSize"; value: 125 }
  | { type: "density"; value: "calm" }
  | { type: "show"; widget: "chart" }
  | { type: "moveToTop"; widget: "chart" | "bill" }
  | { type: "emphasize"; widget: "bill" }
  | { type: "explanations"; value: "stepByStep" }
  | { type: "voiceFirst"; value: true }
  | { type: "motion"; value: "reduced" }
  | { type: "contrast"; value: "high" };

/** Compile-time proof that every suggested change is a valid preferences action. */
type Assert<T extends true> = T;
export type SuggestedActionIsUiAction = Assert<SuggestedAction extends UiAction ? true : false>;

/** Matches the style ids in lib/preferences/recommend.ts ("Make it yours"). */
export type LayoutStyle = "calm" | "visual" | "voice";

/** on: already set. off: can be offered. unsupported: this version of the app has no such setting, or we can't tell. */
export type TargetStatus = "on" | "off" | "unsupported";

export interface TargetDef {
  id: TargetId;
  title: string;
  /** What Dial asks. A question, never a statement about the person. */
  offer: string;
  actions: SuggestedAction[];
  layout?: LayoutStyle;
  /** Groups used for the combined offer ("easier to read"). */
  readability: boolean;
  status: (p: PreferenceSnapshot) => TargetStatus;
}

const two = <T>(v: unknown, on: T, off: readonly T[]): TargetStatus => (v === on ? "on" : off.includes(v as T) ? "off" : "unsupported");

const layoutList = (p: PreferenceSnapshot, key: "pinned" | "shown") => {
  const v = p.layout?.[key];
  return Array.isArray(v) ? v : null;
};

export const TARGETS: Record<TargetId, TargetDef> = {
  largerText: {
    id: "largerText",
    title: "Larger text",
    offer: "Would you like me to make the text larger?",
    actions: [{ type: "textSize", value: 125 }],
    readability: true,
    status: (p) => (typeof p.textSize !== "number" ? "unsupported" : p.textSize >= 125 ? "on" : "off"),
  },
  calmLayout: {
    id: "calmLayout",
    title: "A calmer home screen",
    offer: "Would you like me to show less on your home screen, keeping the most important parts?",
    actions: [{ type: "density", value: "calm" }],
    layout: "calm",
    readability: true,
    status: (p) => two(p.layout?.density, "calm", ["standard"]),
  },
  visualSummary: {
    id: "visualSummary",
    title: "Your spending chart near the top",
    offer: "Would you like me to put your spending chart near the top?",
    actions: [
      { type: "show", widget: "chart" },
      { type: "moveToTop", widget: "chart" },
    ],
    layout: "visual",
    readability: false,
    status: (p) => {
      const pinned = layoutList(p, "pinned");
      return pinned === null ? "unsupported" : pinned.includes("chart") ? "on" : "off";
    },
  },
  stepByStep: {
    id: "stepByStep",
    title: "Step-by-step explanations",
    offer: "Would you like Dial to explain things step by step?",
    actions: [{ type: "explanations", value: "stepByStep" }],
    readability: false,
    status: (p) => two(p.explanations, "stepByStep", ["standard"]),
  },
  voiceFirst: {
    id: "voiceFirst",
    title: "Talking to Dial first",
    offer: "Would you like talking to Dial to be the first option?",
    actions: [{ type: "voiceFirst", value: true }],
    layout: "voice",
    readability: false,
    status: (p) => (typeof p.voiceFirst !== "boolean" ? "unsupported" : p.voiceFirst ? "on" : "off"),
  },
  reducedMotion: {
    id: "reducedMotion",
    title: "Less animation",
    offer: "Would you like me to turn off animations?",
    actions: [{ type: "motion", value: "reduced" }],
    readability: true,
    status: (p) => two(p.motion, "reduced", ["system"]),
  },
  highContrast: {
    id: "highContrast",
    title: "Stronger contrast",
    offer: "Would you like me to use stronger contrast?",
    actions: [{ type: "contrast", value: "high" }],
    readability: true,
    status: (p) => two(p.contrast, "high", ["standard"]),
  },
  paymentsProminent: {
    id: "paymentsProminent",
    title: "Your next payment at the top",
    offer: "Would you like me to put your bill and next payment at the top?",
    actions: [
      { type: "moveToTop", widget: "bill" },
      { type: "emphasize", widget: "bill" },
    ],
    readability: false,
    status: (p) => {
      const pinned = layoutList(p, "pinned");
      return pinned === null ? "unsupported" : pinned.includes("bill") || p.layout?.emphasis === "bill" ? "on" : "off";
    },
  },
};

export function targetStatus(id: TargetId, p: PreferenceSnapshot | null | undefined): TargetStatus {
  if (typeof p !== "object" || p === null) return "unsupported";
  return TARGETS[id].status(p);
}
