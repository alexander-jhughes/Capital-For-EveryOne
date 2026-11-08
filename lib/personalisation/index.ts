// Public entry point for the frontend. Lazy-loads the trained model so it never weighs on the first page load,
// and degrades to status "unavailable" (the app carries on as before) if the model can't be loaded.
// Separate from the Groq assistant (lib/ai, /api/ask): this predicts presentation settings only, on the device.
import { isValidModel, type ModelArtifact } from "./artifact";
import type { PersonalisationInput } from "./features";
import { type InferenceOptions, type PersonalisationResult, recommendPreferences } from "./infer";
import type { PersonalisationState } from "./state";

let modelPromise: Promise<ModelArtifact | null> | null = null;

export function loadModel(): Promise<ModelArtifact | null> {
  modelPromise ??= import("./model.json")
    .then((m) => {
      const data: unknown = m.default;
      return isValidModel(data) ? data : null;
    })
    .catch(() => null);
  return modelPromise;
}

/** Loads the model if needed, then runs inference. Never rejects. */
export async function getPersonalisation(input: PersonalisationInput, state: PersonalisationState, options?: InferenceOptions): Promise<PersonalisationResult> {
  const model = await loadModel();
  return recommendPreferences(input, state, model, options);
}

export type { ModelArtifact } from "./artifact";
export type { PersonalisationInput, PreferenceSnapshot, SignalId, Signals } from "./features";
export type { InferenceOptions, PersonalisationResult, PersonalisationStatus, PreferenceRecommendation, WithheldReason } from "./infer";
export { recommendPreferences } from "./infer";
export type { Consent, Outcome, PersonalisationState } from "./state";
export {
  clearState,
  INITIAL_STATE,
  loadState,
  PERSONALISATION_STORAGE_KEY,
  recordOutcome,
  recordSignal,
  resetPersonalisation,
  saveState,
  setConsent,
  signalForAction,
} from "./state";
export type { LayoutStyle, SuggestedAction, TargetId } from "./targets";
