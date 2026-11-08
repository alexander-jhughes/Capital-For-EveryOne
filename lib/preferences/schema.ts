// Accessibility preferences and personal layout. Independent of the Simple/Detailed view (its own cookie).
// Everything Dial or the settings page can change is listed here; anything else is rejected by sanitize().
import type { Mode } from "../types";
import type { ListenMode } from "../voice/types";

export const WIDGETS = ["bill", "balance", "insights", "budget", "chart", "recent", "pause"] as const;
export type WidgetId = (typeof WIDGETS)[number];

export const WIDGET_LABELS: Record<WidgetId, string> = {
  bill: "Your bill and next payment",
  balance: "Balance and credit",
  insights: "Dial noticed",
  budget: "Spending this month",
  chart: "Daily spending chart",
  recent: "Recent transactions",
  pause: "Spend Pause",
};

export const TEXT_SIZES = [100, 125, 150, 200] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export interface Layout {
  /** Widgets moved to the top, most recent first. The rest keep the view's default order. */
  pinned: WidgetId[];
  /** Widgets the person asked to see even if the view hides them by default. */
  shown: WidgetId[];
  hidden: WidgetId[];
  emphasis: WidgetId | null;
  /** "calm" keeps only the first three widgets: less on screen without switching view. */
  density: "standard" | "calm";
}

export interface Preferences {
  textSize: TextSize;
  contrast: "standard" | "high";
  spacing: "standard" | "roomy";
  motion: "system" | "reduced";
  theme: "system" | "light" | "dark";
  targets: "standard" | "large";
  /** How Dial's financial cards explain things: plain, or with numbered steps. */
  explanations: "standard" | "stepByStep";
  /** Puts "Talk to Dial" first: the Dial button opens Voice Mode and Home shows a voice shortcut. */
  voiceFirst: boolean;
  /** Whether the optional "Make it yours" setup was completed or skipped (so it never nags). */
  onboarding: "unset" | "done" | "skipped";
  /** How long Dial's answers are: standard, or brief (the key fact first, fewer words). */
  answerStyle: "standard" | "brief";
  /** How the microphone listens: one question per tap, while held (push-to-talk), or continuously (opt-in). */
  listenMode: ListenMode;
  /**
   * Where the person agreed their voice is turned into text. Asked before the microphone is first used.
   * unset: not asked yet. on-device: only on this device. cloud: the browser's online speech service may be used.
   * typing: the person prefers not to use voice input. whisper: "clearer recognition", the recording goes to Groq's
   * Whisper, which copes better with accents and slow or unclear speech.
   */
  speechInput: "unset" | "on-device" | "cloud" | "typing" | "whisper";
  /** Easier reading: wider letter, word and line spacing, left-aligned text, no italics (dyslexia friendly). */
  reading: "standard" | "easy";
  /** Colour-safe: alerts and statuses never rely on red against green; a blue and orange palette with shapes and words. */
  colours: "standard" | "safe";
  /** How fast Dial speaks its replies. */
  voiceRate: "slow" | "normal" | "fast";
  /** Read Dial's replies aloud as soon as they arrive. Only ever on because the person asked for it. */
  autoRead: boolean;
  /** One-handed use: the main buttons and Dial's controls sit low on the screen, within thumb reach. */
  reach: "standard" | "thumb";
  /** Ignores a second tap on the same control within a moment, so a shaky press doesn't count twice. */
  tapGuard: boolean;
  /** A short vibration when Dial replies or Spend Pause steps in, for people who can't rely on sound. */
  vibrate: boolean;
  /** The night look: display changes applied only between NIGHT_WINDOW.from and NIGHT_WINDOW.to. Empty means off. */
  night: NightAction[];
  layout: Layout;
}

/** When the night look applies, in local hours: from 7pm until 7am. */
export const NIGHT_WINDOW = { from: 19, to: 7 } as const;
export const inNightWindow = (hour: number) => hour >= NIGHT_WINDOW.from || hour < NIGHT_WINDOW.to;

/** Settings that may be part of a night look: how the screen looks, never how Dial behaves. */
export const NIGHT_SETTINGS = ["textSize", "contrast", "theme", "spacing", "motion", "reading", "colours", "targets"] as const;
export type NightAction = Extract<UiAction, { type: (typeof NIGHT_SETTINGS)[number] }>;

/** The one-word answer style sent to /api/ask. Step by step wins over brief, because it was asked for explicitly. */
export type DialStyle = "standard" | "brief" | "stepByStep";
export const dialStyle = (p: Pick<Preferences, "explanations" | "answerStyle">): DialStyle =>
  p.explanations === "stepByStep" ? "stepByStep" : p.answerStyle === "brief" ? "brief" : "standard";

export const DEFAULT_PREFS: Preferences = {
  textSize: 100,
  contrast: "standard",
  spacing: "standard",
  motion: "system",
  theme: "system",
  targets: "standard",
  explanations: "standard",
  voiceFirst: false,
  onboarding: "unset",
  answerStyle: "standard",
  listenMode: "tap",
  speechInput: "unset",
  reading: "standard",
  colours: "standard",
  voiceRate: "normal",
  autoRead: false,
  reach: "standard",
  tapGuard: false,
  vibrate: false,
  night: [],
  layout: { pinned: [], shown: [], hidden: [], emphasis: null, density: "standard" },
};

/** Which widgets each view shows, in its own default order. */
export const VIEW_DEFAULTS: Record<Mode, { order: WidgetId[]; visible: WidgetId[] }> = {
  simple: { order: ["bill", "insights", "pause", "balance", "budget", "chart", "recent"], visible: ["bill", "insights", "pause"] },
  complex: {
    order: ["balance", "bill", "insights", "budget", "chart", "recent", "pause"],
    visible: ["balance", "bill", "insights", "budget", "chart", "recent", "pause"],
  },
};

export type UiAction =
  | { type: "textSize"; value: TextSize }
  | { type: "contrast"; value: Preferences["contrast"] }
  | { type: "spacing"; value: Preferences["spacing"] }
  | { type: "motion"; value: Preferences["motion"] }
  | { type: "theme"; value: Preferences["theme"] }
  | { type: "targets"; value: Preferences["targets"] }
  | { type: "density"; value: Layout["density"] }
  | { type: "explanations"; value: Preferences["explanations"] }
  | { type: "voiceFirst"; value: boolean }
  | { type: "onboarding"; value: Preferences["onboarding"] }
  | { type: "answerStyle"; value: Preferences["answerStyle"] }
  | { type: "listenMode"; value: ListenMode }
  | { type: "speechInput"; value: Preferences["speechInput"] }
  | { type: "reading"; value: Preferences["reading"] }
  | { type: "colours"; value: Preferences["colours"] }
  | { type: "voiceRate"; value: Preferences["voiceRate"] }
  | { type: "autoRead"; value: boolean }
  | { type: "reach"; value: Preferences["reach"] }
  | { type: "tapGuard"; value: boolean }
  | { type: "vibrate"; value: boolean }
  | { type: "nightLook"; actions: NightAction[] }
  | { type: "nightOff" }
  | { type: "moveToTop"; widget: WidgetId }
  | { type: "emphasize"; widget: WidgetId }
  | { type: "show"; widget: WidgetId }
  | { type: "hide"; widget: WidgetId }
  | { type: "clearEmphasis" }
  | { type: "reset" };

const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const widgetList = (v: unknown): WidgetId[] =>
  Array.isArray(v) ? [...new Set(v.filter((w): w is WidgetId => WIDGETS.includes(w as WidgetId)))] : [];

/** Rebuilds preferences from untrusted input (cookie, storage), keeping only allowlisted values. */
export function sanitize(input: unknown): Preferences {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const l = (typeof o.layout === "object" && o.layout !== null ? o.layout : {}) as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  return {
    textSize: oneOf(o.textSize, TEXT_SIZES, d.textSize),
    contrast: oneOf(o.contrast, ["standard", "high"] as const, d.contrast),
    spacing: oneOf(o.spacing, ["standard", "roomy"] as const, d.spacing),
    motion: oneOf(o.motion, ["system", "reduced"] as const, d.motion),
    theme: oneOf(o.theme, ["system", "light", "dark"] as const, d.theme),
    targets: oneOf(o.targets, ["standard", "large"] as const, d.targets),
    explanations: oneOf(o.explanations, ["standard", "stepByStep"] as const, d.explanations),
    voiceFirst: o.voiceFirst === true,
    onboarding: oneOf(o.onboarding, ["unset", "done", "skipped"] as const, d.onboarding),
    answerStyle: oneOf(o.answerStyle, ["standard", "brief"] as const, d.answerStyle),
    listenMode: oneOf(o.listenMode, ["tap", "hold", "continuous"] as const, d.listenMode),
    speechInput: oneOf(o.speechInput, ["unset", "on-device", "cloud", "typing", "whisper"] as const, d.speechInput),
    reading: oneOf(o.reading, ["standard", "easy"] as const, d.reading),
    colours: oneOf(o.colours, ["standard", "safe"] as const, d.colours),
    voiceRate: oneOf(o.voiceRate, ["slow", "normal", "fast"] as const, d.voiceRate),
    autoRead: o.autoRead === true,
    reach: oneOf(o.reach, ["standard", "thumb"] as const, d.reach),
    tapGuard: o.tapGuard === true,
    vibrate: o.vibrate === true,
    night: nightList(o.night),
    layout: {
      pinned: widgetList(l.pinned),
      shown: widgetList(l.shown),
      hidden: widgetList(l.hidden),
      emphasis: oneOf(l.emphasis, [...WIDGETS, null] as const, null),
      density: oneOf(l.density, ["standard", "calm"] as const, "standard"),
    },
  };
}

/**
 * A night look from untrusted input: only NIGHT_SETTINGS with allowed values, one per setting (the last one wins).
 * Each value is checked by sanitize itself, so the night look can never hold a value the day look couldn't.
 */
export function nightList(v: unknown): NightAction[] {
  if (!Array.isArray(v)) return [];
  const bySetting = new Map<string, NightAction>();
  for (const item of v.slice(0, NIGHT_SETTINGS.length * 2)) {
    if (typeof item !== "object" || item === null) continue;
    const { type, value } = item as { type?: unknown; value?: unknown };
    if (!NIGHT_SETTINGS.includes(type as (typeof NIGHT_SETTINGS)[number])) continue;
    const kept = sanitize({ [type as string]: value }) as unknown as Record<string, unknown>;
    if (kept[type as string] === value) bySetting.set(type as string, { type, value } as NightAction);
  }
  return [...bySetting.values()];
}

const without = (list: WidgetId[], w: WidgetId) => list.filter((x) => x !== w);

/** Pure: applies one allowlisted action. Never touches account data. */
export function applyAction(p: Preferences, a: UiAction): Preferences {
  const l = p.layout;
  switch (a.type) {
    case "reset":
      return DEFAULT_PREFS;
    case "textSize":
    case "contrast":
    case "spacing":
    case "motion":
    case "theme":
    case "targets":
    case "explanations":
    case "voiceFirst":
    case "onboarding":
    case "answerStyle":
    case "listenMode":
    case "speechInput":
    case "reading":
    case "colours":
    case "voiceRate":
    case "autoRead":
    case "reach":
    case "tapGuard":
    case "vibrate":
      return { ...p, [a.type]: a.value };
    case "nightLook":
      return { ...p, night: nightList(a.actions) };
    case "nightOff":
      return { ...p, night: [] };
    case "density":
      return { ...p, layout: { ...l, density: a.value } };
    case "moveToTop":
      return { ...p, layout: { ...l, pinned: [a.widget, ...without(l.pinned, a.widget)], hidden: without(l.hidden, a.widget), shown: [...new Set([...l.shown, a.widget])] } };
    case "emphasize":
      return { ...p, layout: { ...l, emphasis: a.widget, hidden: without(l.hidden, a.widget) } };
    case "clearEmphasis":
      return { ...p, layout: { ...l, emphasis: null } };
    case "show":
      return { ...p, layout: { ...l, shown: [...new Set([...l.shown, a.widget])], hidden: without(l.hidden, a.widget) } };
    case "hide":
      return {
        ...p,
        layout: { ...l, hidden: [...new Set([...l.hidden, a.widget])], shown: without(l.shown, a.widget), pinned: without(l.pinned, a.widget), emphasis: l.emphasis === a.widget ? null : l.emphasis },
      };
  }
}

export const applyActions = (p: Preferences, actions: UiAction[]) => actions.reduce(applyAction, p);

/** What the screen should show at this hour: the kept preferences, with the night look on top during the night window. */
export function effectivePrefs(p: Preferences, hour: number): Preferences {
  return p.night.length > 0 && inNightWindow(hour) ? applyActions(p, p.night) : p;
}

/** The widgets a view shows, in order, after the person's layout. */
export function visibleWidgets(mode: Mode, layout: Layout): WidgetId[] {
  const { order, visible } = VIEW_DEFAULTS[mode];
  const set = new Set([...visible, ...layout.shown].filter((w) => !layout.hidden.includes(w)));
  const ordered = [...layout.pinned.filter((w) => set.has(w)), ...order.filter((w) => set.has(w) && !layout.pinned.includes(w))];
  return layout.density === "calm" ? ordered.slice(0, 3) : ordered;
}

/**
 * Whether a widget is on Home in this view, before the "calm" cut to three. This is what the settings tick means:
 * Simple view leaves some widgets off by default, so "not hidden" is not the same as "shown".
 */
export function isWidgetShown(mode: Mode, layout: Layout, w: WidgetId): boolean {
  if (layout.hidden.includes(w)) return false;
  return VIEW_DEFAULTS[mode].visible.includes(w) || layout.shown.includes(w);
}

export function stepTextSize(current: TextSize, dir: 1 | -1): TextSize {
  const i = TEXT_SIZES.indexOf(current) + dir;
  return TEXT_SIZES[Math.min(Math.max(i, 0), TEXT_SIZES.length - 1)];
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Plain-English description of a set of actions, for Dial's offer and the preview banner. */
export function describeActions(actions: UiAction[]): string {
  const parts = actions.map((a) => {
    switch (a.type) {
      case "reset":
        return "put everything back to the original look";
      case "textSize":
        return a.value === 100 ? "use the standard text size" : `make the text ${a.value}% of the standard size`;
      case "contrast":
        return a.value === "high" ? "use stronger contrast" : "use standard contrast";
      case "spacing":
        return a.value === "roomy" ? "give everything more space" : "use standard spacing";
      case "motion":
        return a.value === "reduced" ? "turn off animations" : "follow your device's animation setting";
      case "theme":
        return a.value === "system" ? "follow your device's light or dark setting" : `use a ${a.value} interface`;
      case "targets":
        return a.value === "large" ? "make buttons bigger and easier to press" : "use standard button sizes";
      case "explanations":
        return a.value === "stepByStep" ? "explain things step by step" : "use standard explanations";
      case "voiceFirst":
        return a.value ? "make talking to Dial the first option" : "make touch and typing the first option";
      case "onboarding":
        return a.value === "skipped" ? "skip personalising for now" : "finish personalising";
      case "answerStyle":
        return a.value === "brief" ? "keep my answers short" : "use standard-length answers";
      case "listenMode":
        return a.value === "hold" ? "listen only while I hold the button" : a.value === "continuous" ? "keep listening until I stop it" : "listen for one question each time I tap";
      case "speechInput":
        return a.value === "on-device"
          ? "turn my voice into text on this device only"
          : a.value === "cloud"
            ? "allow my browser's online speech service to turn my voice into text"
            : a.value === "typing"
              ? "use typing instead of voice input"
              : a.value === "whisper"
                ? "use clearer recognition, which sends my recording to Groq to turn it into text"
              : "ask me before using the microphone";
      case "density":
        return a.value === "calm" ? "show less on the home screen, keeping the most important parts" : "show everything on the home screen";
      case "moveToTop":
        return `put ${lower(WIDGET_LABELS[a.widget])} at the top`;
      case "emphasize":
        return `make ${lower(WIDGET_LABELS[a.widget])} stand out`;
      case "clearEmphasis":
        return "stop highlighting a section";
      case "show":
        return `show ${lower(WIDGET_LABELS[a.widget])}`;
      case "hide":
        return `hide ${lower(WIDGET_LABELS[a.widget])}`;
      case "reading":
        return a.value === "easy" ? "space out the words and lines so they're easier to read" : "use standard text spacing";
      case "colours":
        return a.value === "safe" ? "use colours that don't rely on telling red from green" : "use the standard colours";
      case "voiceRate":
        return a.value === "slow" ? "speak more slowly" : a.value === "fast" ? "speak faster" : "speak at the normal speed";
      case "autoRead":
        return a.value ? "read my replies aloud straight away" : "only read replies aloud when I ask";
      case "reach":
        return a.value === "thumb" ? "move the main buttons within reach of your thumb" : "put the buttons back in their usual place";
      case "tapGuard":
        return a.value ? "ignore accidental double taps" : "count every tap";
      case "vibrate":
        return a.value ? "vibrate when Dial replies or Spend Pause steps in" : "stop vibrating";
      case "nightLook":
        return a.actions.length ? `from ${NIGHT_WINDOW.from - 12}pm to ${NIGHT_WINDOW.to}am, ${describeActions(a.actions)}` : "turn off the night look";
      case "nightOff":
        return "turn off the night look";
    }
  });
  const unique = [...new Set(parts)];
  return unique.length <= 1 ? unique.join("") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`;
}

export const PREFS_COOKIE = "cfe-prefs";

export const encodePrefs = (p: Preferences) => encodeURIComponent(JSON.stringify(p));

export function decodePrefs(raw: string | undefined): Preferences {
  if (!raw || raw.length > 2000) return DEFAULT_PREFS;
  try {
    return sanitize(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The data-* attributes the CSS reads. Used by the server render and by the client provider. */
export function prefAttributes(p: Preferences): Record<string, string> {
  return {
    "data-text": String(p.textSize),
    "data-contrast": p.contrast,
    "data-spacing": p.spacing,
    "data-motion": p.motion,
    "data-theme": p.theme,
    "data-targets": p.targets,
    "data-reading": p.reading,
    "data-colours": p.colours,
    "data-reach": p.reach,
    "data-tap-guard": String(p.tapGuard),
  };
}
