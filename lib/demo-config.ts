import type { SpendPauseSettings } from "./types";

// Change this to choose whether Spend Pause starts on after "Reset demo".
export const SPEND_PAUSE_ON_RESET = true;

export const RESET_SPEND_PAUSE: SpendPauseSettings = {
  enabled: SPEND_PAUSE_ON_RESET,
  singlePurchaseThreshold: 10000,
  monthlyBudget: 50000,
  quietHours: null,
};

// Spend Pause is off until the person turns it on. Only "Reset demo" may start it on, using the settings above.
export const INITIAL_SPEND_PAUSE: SpendPauseSettings = { ...RESET_SPEND_PAUSE, enabled: false };

// Cookie name for the Dial (mode). The cookie is the single source of truth.
export const MODE_KEY = "cfe-mode";
