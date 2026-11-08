// The configuration catalog: every interface setting the recommender is allowed to suggest.
//
// Only settings that genuinely exist are listed: the preferences in lib/preferences/schema.ts and the
// Simple/Detailed view. Each item's actions are real `UiAction`s, checked by the compiler, so the trusted
// preferences provider can preview and apply them. Nothing in this file applies anything.
//
// Deliberately NOT in the catalog:
// - lowering an accessibility setting (smaller text, standard contrast, animations back on): Dial never suggests that.
// - theme (light/dark): taste, not usability.
// - navigation structure, plain-English and terminology explanations: no such setting exists in the app.
// - answer length ("brief" answers): proposed on feat/dial-intelligence (`answerStyle`), not on the baseline yet.
//   Add one item here once it lands, then retrain. See docs/ml-personalisation/v2/CONTRACT.md.
import type { Preferences, UiAction, WidgetId } from "../preferences/schema";
import type { Mode } from "../types";

export const DIMENSIONS = [
  "view",
  "density",
  "textSize",
  "contrast",
  "spacing",
  "motion",
  "targets",
  "explanations",
  "voiceFirst",
  "homeFocus",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const ITEM_IDS = [
  "view.simple",
  "view.detailed",
  "density.calm",
  "textSize.125",
  "textSize.150",
  "contrast.high",
  "spacing.roomy",
  "motion.reduced",
  "targets.large",
  "explanations.stepByStep",
  "voiceFirst.on",
  "homeFocus.bill",
  "homeFocus.chart",
  "homeFocus.budget",
  "homeFocus.recent",
  "homeFocus.insights",
] as const;
export type ItemId = (typeof ITEM_IDS)[number];

/** Descriptive metadata about what an item changes. Used as item features by content-based and hybrid models. */
export const ITEM_TAGS = ["readability", "simplicity", "detail", "visual", "voice", "guidance", "motor", "payments", "spending", "layout"] as const;
export type ItemTag = (typeof ITEM_TAGS)[number];

export interface CatalogItem {
  id: ItemId;
  dimension: Dimension;
  /** Short name for a checkbox: "Larger text". */
  title: string;
  /** Preferences actions. Empty for view items, which use `mode`. */
  actions: UiAction[];
  /** View items only: the view to switch to. */
  mode?: Mode;
  tags: ItemTag[];
}

const focus = (widget: WidgetId, title: string, tags: ItemTag[], emphasise = false): Omit<CatalogItem, "id"> => ({
  dimension: "homeFocus",
  title,
  actions: emphasise
    ? [
        { type: "moveToTop", widget },
        { type: "emphasize", widget },
      ]
    : [
        { type: "show", widget },
        { type: "moveToTop", widget },
      ],
  tags: ["layout", ...tags],
});

export const CATALOG: Record<ItemId, CatalogItem> = {
  "view.simple": { id: "view.simple", dimension: "view", title: "Simple view", actions: [], mode: "simple", tags: ["simplicity"] },
  "view.detailed": { id: "view.detailed", dimension: "view", title: "Detailed view", actions: [], mode: "complex", tags: ["detail"] },
  "density.calm": { id: "density.calm", dimension: "density", title: "Less on the home screen", actions: [{ type: "density", value: "calm" }], tags: ["simplicity", "layout"] },
  "textSize.125": { id: "textSize.125", dimension: "textSize", title: "Larger text", actions: [{ type: "textSize", value: 125 }], tags: ["readability"] },
  "textSize.150": { id: "textSize.150", dimension: "textSize", title: "Much larger text", actions: [{ type: "textSize", value: 150 }], tags: ["readability"] },
  "contrast.high": { id: "contrast.high", dimension: "contrast", title: "Stronger contrast", actions: [{ type: "contrast", value: "high" }], tags: ["readability"] },
  "spacing.roomy": { id: "spacing.roomy", dimension: "spacing", title: "More space between things", actions: [{ type: "spacing", value: "roomy" }], tags: ["readability", "simplicity"] },
  "motion.reduced": { id: "motion.reduced", dimension: "motion", title: "Less animation", actions: [{ type: "motion", value: "reduced" }], tags: ["simplicity"] },
  "targets.large": { id: "targets.large", dimension: "targets", title: "Bigger buttons", actions: [{ type: "targets", value: "large" }], tags: ["motor"] },
  "explanations.stepByStep": {
    id: "explanations.stepByStep",
    dimension: "explanations",
    title: "Step-by-step explanations",
    actions: [{ type: "explanations", value: "stepByStep" }],
    tags: ["guidance"],
  },
  "voiceFirst.on": { id: "voiceFirst.on", dimension: "voiceFirst", title: "Talking to Dial first", actions: [{ type: "voiceFirst", value: true }], tags: ["voice"] },
  "homeFocus.bill": { id: "homeFocus.bill", ...focus("bill", "Your bill and next payment at the top", ["payments"], true) },
  "homeFocus.chart": { id: "homeFocus.chart", ...focus("chart", "Your spending chart at the top", ["visual", "spending"]) },
  "homeFocus.budget": { id: "homeFocus.budget", ...focus("budget", "Spending this month at the top", ["visual", "spending"]) },
  "homeFocus.recent": { id: "homeFocus.recent", ...focus("recent", "Recent transactions at the top", ["detail", "spending"]) },
  "homeFocus.insights": { id: "homeFocus.insights", ...focus("insights", "What Dial noticed at the top", ["guidance", "spending"]) },
};

/** Pairs that must never be suggested together, or alongside an explicit setting on the other side. */
export const CONFLICTS: readonly (readonly [ItemId, ItemId])[] = [
  // Detailed view exists to show everything; a calm home screen hides most of it.
  ["view.detailed", "density.calm"],
];

/** At most this many changes in one suggestion, so a preview stays easy to understand. */
export const MAX_BUNDLE_SIZE = 4;

export const isItemId = (v: unknown): v is ItemId => typeof v === "string" && (ITEM_IDS as readonly string[]).includes(v);
export const isDimension = (v: unknown): v is Dimension => typeof v === "string" && (DIMENSIONS as readonly string[]).includes(v);

export const itemsOf = (d: Dimension): ItemId[] => ITEM_IDS.filter((id) => CATALOG[id].dimension === d);

/** True if the two items can never be suggested together (same dimension, or a listed conflict). */
export function conflicts(a: ItemId, b: ItemId): boolean {
  if (a === b) return false;
  if (CATALOG[a].dimension === CATALOG[b].dimension) return true;
  return CONFLICTS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/** True if a set of items is a valid configuration: no duplicates, no conflicts, not too many. */
export function isCompatible(items: readonly ItemId[]): boolean {
  if (items.length > MAX_BUNDLE_SIZE || new Set(items).size !== items.length) return false;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (conflicts(items[i], items[j])) return false;
  return true;
}

const top = (p: Preferences) => p.layout.pinned[0] ?? null;

/**
 * Whether an item is already in effect (or exceeded: text at 150% satisfies "Larger text").
 * Items already in effect are never suggested.
 */
export function isActive(id: ItemId, p: Preferences, view: Mode): boolean {
  switch (id) {
    case "view.simple":
      return view === "simple";
    case "view.detailed":
      return view === "complex";
    case "density.calm":
      return p.layout.density === "calm";
    case "textSize.125":
      return p.textSize >= 125;
    case "textSize.150":
      return p.textSize >= 150;
    case "contrast.high":
      return p.contrast === "high";
    case "spacing.roomy":
      return p.spacing === "roomy";
    case "motion.reduced":
      return p.motion === "reduced";
    case "targets.large":
      return p.targets === "large";
    case "explanations.stepByStep":
      return p.explanations === "stepByStep";
    case "voiceFirst.on":
      return p.voiceFirst;
    case "homeFocus.bill":
      return top(p) === "bill" || p.layout.emphasis === "bill";
    case "homeFocus.chart":
      return top(p) === "chart";
    case "homeFocus.budget":
      return top(p) === "budget";
    case "homeFocus.recent":
      return top(p) === "recent";
    case "homeFocus.insights":
      return top(p) === "insights";
  }
}

/** The items currently in effect, in catalog order. */
export const activeItems = (p: Preferences, view: Mode): ItemId[] => ITEM_IDS.filter((id) => isActive(id, p, view));

/**
 * Dimensions whose current value differs from the default. A non-default value was set by someone on purpose
 * (the person, or a suggestion they kept), so it counts as explicit even if no event recorded it.
 * The view has no default here: it is explicit only when recorded.
 */
export function nonDefaultDimensions(p: Preferences): Dimension[] {
  const out: Dimension[] = [];
  if (p.layout.density !== "standard") out.push("density");
  if (p.textSize !== 100) out.push("textSize");
  if (p.contrast !== "standard") out.push("contrast");
  if (p.spacing !== "standard") out.push("spacing");
  if (p.motion !== "system") out.push("motion");
  if (p.targets !== "standard") out.push("targets");
  if (p.explanations !== "standard") out.push("explanations");
  if (p.voiceFirst) out.push("voiceFirst");
  if (p.layout.pinned.length > 0 || p.layout.emphasis !== null) out.push("homeFocus");
  return out;
}

/** Which dimension a preferences action changes, if any. `reset` and `onboarding` change none. */
export function dimensionOfAction(a: UiAction): Dimension | null {
  switch (a.type) {
    case "textSize":
    case "contrast":
    case "spacing":
    case "motion":
    case "targets":
    case "explanations":
    case "voiceFirst":
    case "density":
      return a.type;
    case "moveToTop":
    case "emphasize":
    case "clearEmphasis":
      return "homeFocus";
    case "show":
    case "hide":
    case "theme":
    case "onboarding":
    case "reset":
      return null;
  }
}

/** The preferences actions and view for a set of items, in catalog order. Pure. */
export function configurationActions(items: readonly ItemId[]): { actions: UiAction[]; mode?: Mode } {
  const ordered = ITEM_IDS.filter((id) => items.includes(id));
  const actions = ordered.flatMap((id) => CATALOG[id].actions);
  const mode = ordered.map((id) => CATALOG[id].mode).find((m) => m !== undefined);
  return mode ? { actions, mode } : { actions };
}
