// Hand-written example people for the documentation and tests. Not training data.
import type { PersonalisationInput, PreferenceSnapshot } from "./features";
import { INITIAL_STATE, type PersonalisationState } from "./state";

const DEFAULT_LAYOUT = { pinned: [], shown: [], hidden: [], emphasis: null, density: "standard" };
/** Default settings in the adaptive-UI schema (has step-by-step and voice-first). */
export const DEFAULTS: PreferenceSnapshot = {
  textSize: 100,
  contrast: "standard",
  spacing: "standard",
  motion: "system",
  theme: "system",
  targets: "standard",
  explanations: "standard",
  voiceFirst: false,
  layout: DEFAULT_LAYOUT,
};
/** Default settings in the redesign schema (no step-by-step or voice-first settings). */
export const REDESIGN_DEFAULTS: PreferenceSnapshot = {
  textSize: 100,
  contrast: "standard",
  spacing: "standard",
  motion: "system",
  theme: "system",
  targets: "standard",
  layout: DEFAULT_LAYOUT,
};

const granted = (signals: PersonalisationState["signals"] = {}): PersonalisationState => ({ ...INITIAL_STATE, consent: "granted", signals });

export interface Example {
  name: string;
  input: PersonalisationInput;
  state: PersonalisationState;
}

export const EXAMPLES: Example[] = [
  // The three demo paths in docs/ml-personalisation/README.md ("Demo path"). Each is a short sequence of explicit
  // actions in Display and voice, counted by the controller exactly as written here. A test pins their outcomes.
  {
    name: "Demo path: hid one home screen section in Display and voice, Simple view",
    input: { preferences: { ...DEFAULTS, layout: { ...DEFAULT_LAYOUT, hidden: ["insights"] } }, view: "simple" },
    state: granted({ lessOnScreen: 1 }),
  },
  {
    name: "Demo path: hid one home screen section in Display and voice, Detailed view",
    input: { preferences: { ...DEFAULTS, layout: { ...DEFAULT_LAYOUT, hidden: ["recent"] } }, view: "complex" },
    state: granted({ lessOnScreen: 1 }),
  },
  {
    name: "Demo path: chose bigger buttons, then opened Dial three times, Simple view",
    input: { preferences: { ...DEFAULTS, targets: "large" }, view: "simple" },
    state: granted({ voiceSessions: 3 }),
  },
  {
    name: "Keeps choosing larger text and less on screen (the brief's example)",
    input: { preferences: { ...DEFAULTS, textSize: 150 }, view: "simple" },
    state: granted({ textLarger: 3, lessOnScreen: 3 }),
  },
  {
    name: "The same, and also hid a section of the home screen",
    input: { preferences: { ...DEFAULTS, textSize: 150, layout: { ...DEFAULT_LAYOUT, hidden: ["recent"] } }, view: "simple" },
    state: granted({ textLarger: 3, lessOnScreen: 3 }),
  },
  {
    name: "Often talks to Dial and chose bigger buttons",
    input: { preferences: { ...DEFAULTS, targets: "large" }, view: "simple" },
    state: granted({ voiceSessions: 6 }),
  },
  {
    name: "Ticked larger text and stronger contrast in Make it yours, then kept the standard look",
    input: { preferences: DEFAULTS, view: "simple", choices: ["largerText", "highContrast", "lessInfo"] },
    state: granted({ textLarger: 2 }),
  },
  {
    name: "Mixed signals: asked for less on screen and for more detail",
    input: { preferences: DEFAULTS, view: "complex" },
    state: granted({ lessOnScreen: 4, moreDetail: 4 }),
  },
  {
    name: "Has not changed anything",
    input: { preferences: DEFAULTS, view: "complex" },
    state: granted(),
  },
  {
    name: "Often talks to Dial, on the redesign branch (no voice-first setting exists)",
    input: { preferences: { ...REDESIGN_DEFAULTS, targets: "large" }, view: "simple" },
    state: granted({ voiceSessions: 6 }),
  },
  {
    name: "Has not been asked about personalisation yet",
    input: { preferences: { ...DEFAULTS, textSize: 150 }, view: "simple" },
    state: { ...INITIAL_STATE, signals: { textLarger: 3, lessOnScreen: 3 } },
  },
];
