// Feature extraction for the personalisation model.
//
// Allowlist only. The model reads exactly three things, all chosen by the person:
//   1. the display settings they set themselves (lib/preferences/schema.ts `Preferences`),
//   2. the boxes they ticked in "Make it yours", if they did it,
//   3. counts of explicit interface actions (e.g. "made the text bigger"), kept on this device, only with consent.
// Anything else passed in (transactions, balances, spending, age, account data) is never read.
// The same function builds training rows and live inference rows, so the model never sees a different encoding.

export const MISSING = -1;

export const TEXT_SIZE_LEVELS = [100, 125, 150, 200] as const;

/** "Make it yours" choices. Ids and labels match lib/preferences/recommend.ts on feat/hackathon-adaptive-ui. */
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
export const CHOICE_IDS = CHOICES.map((c) => c.id) as ChoiceId[];

/** Explicit interface actions the person took. Counts only: no timestamps, no content, nothing financial. */
export const SIGNAL_IDS = ["textLarger", "textSmaller", "voiceSessions", "lessOnScreen", "moreDetail", "undoneChanges"] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];
/** Counts are capped so one very busy session cannot dominate. */
export const SIGNAL_CAP = 10;

/**
 * The subset of `Preferences` the model reads. Every field is optional and loosely typed so that the
 * `Preferences` type from either the redesign branch or the adaptive-UI branch can be passed straight in.
 */
export interface PreferenceSnapshot {
  textSize?: number;
  contrast?: string;
  spacing?: string;
  motion?: string;
  theme?: string;
  targets?: string;
  explanations?: string;
  voiceFirst?: boolean;
  layout?: {
    pinned?: readonly string[];
    shown?: readonly string[];
    hidden?: readonly string[];
    emphasis?: string | null;
    density?: string;
  };
}

export interface PersonalisationInput {
  /** The person's current explicit settings. Without these the engine makes no recommendation. */
  preferences?: PreferenceSnapshot | null;
  /** Simple or Detailed view, as chosen with the Dial switch. */
  view?: "simple" | "complex" | null;
  /** Ticked "Make it yours" boxes. Leave out (null/undefined) if the person never did it; [] means "did it, ticked none". */
  choices?: readonly string[] | null;
}

export type Signals = Partial<Record<SignalId, number>>;

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const choiceLabel = (id: ChoiceId) => CHOICES.find((c) => c.id === id)!.label;

export interface FeatureDef {
  id: string;
  /** Plain-English reason for a value, or null when the value is not something worth saying (off, missing). */
  describe: (value: number) => string | null;
}

const flag = (id: string, text: string): FeatureDef => ({ id, describe: (v) => (v === 1 ? text : null) });

export const FEATURES: FeatureDef[] = [
  { id: "textSize", describe: (v) => (v >= 1 ? `You use ${TEXT_SIZE_LEVELS[v]}% text` : null) },
  flag("contrastHigh", "You turned on stronger contrast"),
  flag("spacingRoomy", "You chose more space between things"),
  flag("motionReduced", "You turned off animations"),
  flag("themeDark", "You use the dark interface"),
  flag("targetsLarge", "You chose bigger buttons"),
  flag("densityCalm", "You chose a calmer home screen"),
  flag("stepByStepOn", "You turned on step-by-step explanations"),
  flag("voiceFirstOn", "You made talking to Dial the first option"),
  flag("billProminent", "You put your bill at the top of your home screen"),
  flag("chartProminent", "You added the spending chart to your home screen"),
  { id: "hiddenCount", describe: (v) => (v >= 1 ? `You hid ${v === 1 ? "a section" : `${v} sections`} on your home screen` : null) },
  { id: "simpleView", describe: (v) => (v === 1 ? "You use Simple view" : v === 0 ? "You use Detailed view" : null) },
  ...CHOICE_IDS.map((id) => flag(`choice_${id}`, `In "Make it yours" you ticked "${choiceLabel(id)}"`)),
  { id: "sig_textLarger", describe: (v) => (v >= 1 ? `You made the text bigger ${times(v)}` : null) },
  { id: "sig_textSmaller", describe: (v) => (v >= 1 ? `You made the text smaller ${times(v)}` : null) },
  { id: "sig_voiceSessions", describe: (v) => (v >= 1 ? `You've talked to Dial ${times(v)}` : null) },
  { id: "sig_lessOnScreen", describe: (v) => (v >= 1 ? `You asked for less on screen ${times(v)}` : null) },
  { id: "sig_moreDetail", describe: (v) => (v >= 1 ? `You asked for more detail ${times(v)}` : null) },
  { id: "sig_undoneChanges", describe: (v) => (v >= 1 ? `You undid a display change ${times(v)}` : null) },
];

export const FEATURE_IDS = FEATURES.map((f) => f.id);
export const featureIndex = (id: string) => {
  const i = FEATURE_IDS.indexOf(id);
  if (i < 0) throw new Error(`Unknown feature ${id}`);
  return i;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);

/** 1/0 when the field holds one of the known values, MISSING otherwise. */
const enumFlag = (v: unknown, on: string, off: readonly string[]) => (v === on ? 1 : off.includes(v as string) ? 0 : MISSING);

/** Reads only allowlisted fields from untrusted input. Never throws. */
export function extractFeatures(input: unknown, signals?: unknown): number[] {
  const inp = isObj(input) ? input : {};
  const p = isObj(inp.preferences) ? inp.preferences : null;
  const l = p && isObj(p.layout) ? p.layout : null;
  const out: number[] = [];

  const level = p ? TEXT_SIZE_LEVELS.indexOf(p.textSize as (typeof TEXT_SIZE_LEVELS)[number]) : -1;
  out.push(level >= 0 ? level : MISSING);
  out.push(p ? enumFlag(p.contrast, "high", ["standard"]) : MISSING);
  out.push(p ? enumFlag(p.spacing, "roomy", ["standard"]) : MISSING);
  out.push(p ? enumFlag(p.motion, "reduced", ["system"]) : MISSING);
  out.push(p ? enumFlag(p.theme, "dark", ["system", "light"]) : MISSING);
  out.push(p ? enumFlag(p.targets, "large", ["standard"]) : MISSING);
  out.push(l ? enumFlag(l.density, "calm", ["standard"]) : MISSING);
  out.push(p ? enumFlag(p.explanations, "stepByStep", ["standard"]) : MISSING);
  out.push(p && typeof p.voiceFirst === "boolean" ? (p.voiceFirst ? 1 : 0) : MISSING);

  const pinned = l ? strList(l.pinned) : null;
  const shown = l ? strList(l.shown) : null;
  const hidden = l ? strList(l.hidden) : null;
  out.push(l && pinned ? (pinned.includes("bill") || l.emphasis === "bill" ? 1 : 0) : MISSING);
  out.push(l && pinned && shown ? (pinned.includes("chart") || shown.includes("chart") || l.emphasis === "chart" ? 1 : 0) : MISSING);
  out.push(hidden ? Math.min(new Set(hidden).size, 7) : MISSING);
  out.push(inp.view === "simple" ? 1 : inp.view === "complex" ? 0 : MISSING);

  const choices = strList(inp.choices);
  for (const id of CHOICE_IDS) out.push(choices ? (choices.includes(id) ? 1 : 0) : MISSING);

  const s = isObj(signals) ? signals : null;
  for (const id of SIGNAL_IDS) {
    const n = s ? s[id] : undefined;
    out.push(s ? (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), SIGNAL_CAP) : 0) : MISSING);
  }
  return out;
}

/** True when the person has told us anything at all beyond the defaults. */
export function hasInformativeFeatures(x: number[]): boolean {
  const view = featureIndex("simpleView");
  return x.some((v, i) => i !== view && v > 0);
}

/**
 * A stable string for the person's explicit choices (settings and ticks, not action counts).
 * When it changes, a recommendation they turned down earlier may be offered once more.
 */
export function explicitFingerprint(x: number[]): string {
  const firstSignal = featureIndex(`sig_${SIGNAL_IDS[0]}`);
  return x.slice(0, firstSignal).join(",");
}
