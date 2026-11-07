"use client";

// Optional ML display suggestions, on this device only.
// - Off until the person turns it on in Display and voice. Turning it off deletes what was counted.
// - The trained model (about 200 KB) is fetched only after consent, never on first load.
// - Never changes the interface: the Home card asks, and only "Keep it" on the preview bar changes settings.
// - Separate from preferences (own localStorage key) and from Dial's money answers (nothing is sent anywhere).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePreferences } from "@/lib/preferences/provider";
import { useMode } from "@/lib/state/mode-context";
import type { ModelArtifact } from "./artifact";
import { onPrefsEvent, reconcile } from "./controller";
import type { PersonalisationInput } from "./features";
import { loadModel } from "./index";
import { type PersonalisationResult, recommendPreferences } from "./infer";
import {
  clearState,
  type Consent,
  INITIAL_STATE,
  loadState,
  type Outcome,
  type PersonalisationState,
  recordOutcome as recordOutcomeIn,
  recordSignal,
  resetPersonalisation,
  saveState,
  setConsent as setConsentIn,
} from "./state";
import type { TargetId } from "./targets";

export type ModelStatus = "idle" | "loading" | "ready" | "unavailable";

export interface PersonalisationApi {
  consent: Consent;
  modelStatus: ModelStatus;
  /** null until evaluated on this device (always null on the server and without consent). */
  result: PersonalisationResult | null;
  setConsent: (granted: boolean) => void;
  /** Forgets counts and answers. Keeps consent and leaves display settings alone. */
  resetSuggestions: () => void;
  /** `fingerprint` comes from the result the suggestion was shown with. */
  recordOutcome: (target: TargetId, outcome: Outcome, fingerprint: string) => void;
  /** The person tapped to open Voice Mode. Counted only with consent. Nothing they say is recorded. */
  noteVoiceOpened: () => void;
}

const noop = () => {};
const OFF: PersonalisationApi = {
  consent: "unset",
  modelStatus: "idle",
  result: null,
  setConsent: noop,
  resetSuggestions: noop,
  recordOutcome: noop,
  noteVoiceOpened: noop,
};
const Ctx = createContext<PersonalisationApi>(OFF);
/** Safe anywhere: outside the provider it behaves as "suggestions off". */
export const usePersonalisation = () => useContext(Ctx);

export function PersonalisationProvider({ children }: { children: React.ReactNode }) {
  const { prefs, preview, subscribe } = usePreferences();
  const { mode } = useMode();
  const [state, setState] = useState<PersonalisationState>(INITIAL_STATE);
  const [loaded, setLoaded] = useState(false);
  const [model, setModel] = useState<ModelArtifact | null | undefined>(undefined);
  const [modelStatus, setModelStatus] = useState<ModelStatus>("idle");
  const [result, setResult] = useState<PersonalisationResult | null>(null);

  // Read this device's ML state after hydration (never on the server). Storage may be blocked: then it stays off.
  useEffect(() => {
    setState(loadState());
    setLoaded(true);
  }, []);

  // Persist. Anything other than "on" stores nothing at all.
  useEffect(() => {
    if (!loaded) return;
    if (state.consent === "granted") saveState(state);
    else clearState();
  }, [state, loaded]);

  // Count explicit, kept display changes (rules in controller.ts).
  useEffect(() => subscribe((e) => setState((s) => onPrefsEvent(s, e))), [subscribe]);

  // Fetch the model only once the person has said yes.
  useEffect(() => {
    if (state.consent !== "granted" || model !== undefined) return;
    let live = true;
    setModelStatus("loading");
    loadModel().then((m) => {
      if (!live) return;
      setModel(m);
      setModelStatus(m ? "ready" : "unavailable");
    });
    return () => {
      live = false;
    };
  }, [state.consent, model]);

  // Re-evaluate when settings, view, ML state or the model change. Never during a preview.
  useEffect(() => {
    if (!loaded || preview) return;
    if (state.consent !== "granted" || model === undefined) {
      setResult(null);
      return;
    }
    const input: PersonalisationInput = { preferences: prefs, view: mode, choices: null };
    const reconciled = reconcile(state, input);
    if (reconciled !== state) {
      setState(reconciled); // runs again with the updated state
      return;
    }
    setResult(recommendPreferences(input, state, model, { maxSuggestions: 1 }));
  }, [loaded, preview, state, model, prefs, mode]);

  const setConsent = useCallback((granted: boolean) => setState((s) => setConsentIn(s, granted)), []);
  const resetSuggestions = useCallback(() => setState((s) => resetPersonalisation(s)), []);
  const recordOutcome = useCallback((t: TargetId, o: Outcome, fp: string) => setState((s) => recordOutcomeIn(s, t, o, fp)), []);
  const noteVoiceOpened = useCallback(() => setState((s) => recordSignal(s, "voiceSessions")), []);

  const api = useMemo<PersonalisationApi>(
    () => ({ consent: state.consent, modelStatus, result, setConsent, resetSuggestions, recordOutcome, noteVoiceOpened }),
    [state.consent, modelStatus, result, setConsent, resetSuggestions, recordOutcome, noteVoiceOpened],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
