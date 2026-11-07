import type { SpendPauseSettings } from "./types";

// Change this to choose whether Spend Pause starts on after "Reset demo".
export const SPEND_PAUSE_ON_RESET = true;

export const RESET_SPEND_PAUSE: SpendPauseSettings = {
  enabled: SPEND_PAUSE_ON_RESET,
  singlePurchaseThreshold: 10000,
  monthlyBudget: 50000,
  quietHours: null,
};

// localStorage + cookie key for the Dial (mode).
export const MODE_KEY = "cfe-mode";
