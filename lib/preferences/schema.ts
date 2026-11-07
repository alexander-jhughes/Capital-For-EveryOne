// Accessibility preferences and personal layout. Independent of the Simple/Detailed view (its own cookie).
// Everything Dial or the settings page can change is listed here; anything else is rejected by sanitize().
import type { Mode } from "../types";

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
  layout: Layout;
}

export const DEFAULT_PREFS: Preferences = {
  textSize: 100,
  contrast: "standard",
  spacing: "standard",
  motion: "system",
  theme: "system",
  targets: "standard",
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
    layout: {
      pinned: widgetList(l.pinned),
      shown: widgetList(l.shown),
      hidden: widgetList(l.hidden),
      emphasis: oneOf(l.emphasis, [...WIDGETS, null] as const, null),
      density: oneOf(l.density, ["standard", "calm"] as const, "standard"),
    },
  };
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
      return { ...p, [a.type]: a.value };
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

/** The widgets a view shows, in order, after the person's layout. */
export function visibleWidgets(mode: Mode, layout: Layout): WidgetId[] {
  const { order, visible } = VIEW_DEFAULTS[mode];
  const set = new Set([...visible, ...layout.shown].filter((w) => !layout.hidden.includes(w)));
  const ordered = [...layout.pinned.filter((w) => set.has(w)), ...order.filter((w) => set.has(w) && !layout.pinned.includes(w))];
  return layout.density === "calm" ? ordered.slice(0, 3) : ordered;
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
  };
}
