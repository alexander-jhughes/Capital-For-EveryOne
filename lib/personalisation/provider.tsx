"use client";

// Dial personalisation v2 in the browser: consent, the optional "About you" answers, structured signals and
// suggestions, all through Dial's own API (/api/personalisation). No third parties and no Gemini.
// - Nothing is sent, stored or counted until the person turns suggestions on. Turning them off deletes everything.
// - The model runs on Dial's server, so nothing is downloaded to the device.
// - Never changes the interface: the Home card asks, and only "Keep it" on the preview bar changes settings.
// - Separate from preferences (their own cookie) and from Dial's money answers (nothing goes to /api/ask).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PrefsEvent } from "@/lib/preferences/events";
import { usePreferences } from "@/lib/preferences/provider";
import type { Dimension, ItemId } from "@/lib/recommender/catalog";
import type { ProfileAnswers, ResearchAnswers } from "@/lib/recommender/profile";
import { isSignalId, type SignalId, type SignalSource } from "@/lib/recommender/types";
import { useMode } from "@/lib/state/mode-context";
import {
  type ConsentState,
  deleteEverything as deleteAll,
  getExport,
  getStatus,
  OFFLINE,
  postFeedback,
  postRating,
  postRecommendation,
  postSignals,
  putConsent,
  putProfile,
  putResearch,
  type ServerStatus,
  type Suggestion,
} from "./client";
import {
  explicitForEvent,
  loadWatch,
  revertedItems,
  revertVia,
  saveWatch,
  signalForViewChange,
  signalsForEvent,
  takeLegacy,
  viewWasChosen,
  type Watched,
  withoutReverted,
} from "./controller";

export type Answer = "accepted" | "modified" | "rejected" | "dismissed";

export interface PersonalisationApi {
  /** False until the server status has been read (always false on the server render). */
  loaded: boolean;
  status: ServerStatus;
  /** The current suggestion for Home, or null. Only fetched while something shows it (`useSuggestionFeed`). */
  suggestion: Suggestion | null;
  /** Suggestions answered during this visit: never shown again in it. */
  answered: ReadonlySet<string>;
  /** v1's on-device suggestions were on in this browser. They were replaced, so the person is asked again. */
  replacedV1: boolean;
  setConsent: (change: Partial<ConsentState>) => Promise<boolean>;
  saveProfile: (answers: ProfileAnswers) => Promise<boolean>;
  saveResearch: (research: ResearchAnswers) => Promise<boolean>;
  /** `items`: what was kept (accepted/modified) or previewed (rejected). */
  respond: (s: Suggestion, answer: Answer, items: ItemId[]) => void;
  rate: (id: string, satisfaction: -1 | 0 | 1) => void;
  /** Structured, allowlisted signals only (for the voice/Dial layer). Ignored without consent. */
  noteSignal: (id: SignalId, source: SignalSource) => void;
  /** The person tapped to open Voice Mode. Counted only with consent. Nothing they say is recorded. */
  noteVoiceOpened: () => void;
  /** Registers a component that shows suggestions; returns the cleanup. */
  watchSuggestions: () => () => void;
  exportData: () => Promise<unknown | null>;
  deleteEverything: () => Promise<boolean>;
}

const noop = () => {};
const OFF: PersonalisationApi = {
  loaded: false,
  status: OFFLINE,
  suggestion: null,
  answered: new Set(),
  replacedV1: false,
  setConsent: async () => false,
  saveProfile: async () => false,
  saveResearch: async () => false,
  respond: noop,
  rate: noop,
  noteSignal: noop,
  noteVoiceOpened: noop,
  watchSuggestions: () => noop,
  exportData: async () => null,
  deleteEverything: async () => false,
};
const Ctx = createContext<PersonalisationApi>(OFF);
/** Safe anywhere: outside the provider it behaves as "suggestions off". */
export const usePersonalisation = () => useContext(Ctx);

/** For the component that shows suggestions: fetching happens only while it is mounted and `active`. */
export function useSuggestionFeed(active = true) {
  const api = usePersonalisation();
  const { watchSuggestions } = api;
  useEffect(() => (active ? watchSuggestions() : undefined), [watchSuggestions, active]);
  return api;
}

const SIGNAL_FLUSH_MS = 1500;
const readCookies = () => {
  try {
    return document.cookie;
  } catch {
    return "";
  }
};
const FETCH_DEBOUNCE_MS = 500;

export function PersonalisationProvider({ children }: { children: React.ReactNode }) {
  const { prefs, preview, subscribe } = usePreferences();
  const { mode } = useMode();
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<ServerStatus>(OFFLINE);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const [replacedV1, setReplacedV1] = useState(false);
  const [watchers, setWatchers] = useState(0);
  const [profileVersion, setProfileVersion] = useState(0);

  const consented = status.consent.personalisation;
  const consentRef = useRef(false);
  consentRef.current = consented;
  const queue = useRef<{ id: SignalId; source: SignalSource }[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explicit = useRef(new Set<Dimension>());
  const watch = useRef<Watched[]>([]);
  const lastEvent = useRef<PrefsEvent | null>(null);

  // After hydration: delete v1's on-device data, read the server status, and the kept-suggestion watch list.
  useEffect(() => {
    setReplacedV1(takeLegacy());
    let live = true;
    getStatus().then((s) => {
      if (!live) return;
      setStatus(s);
      setLoaded(true);
      watch.current = s.consent.personalisation ? loadWatch() : [];
      if (!s.consent.personalisation) saveWatch([]);
    });
    return () => {
      live = false;
    };
  }, []);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const batch = queue.current.splice(0, 20);
    if (batch.length > 0 && consentRef.current) void postSignals(batch);
    if (queue.current.length > 0) flushTimer.current = setTimeout(flush, SIGNAL_FLUSH_MS);
  }, []);

  const enqueue = useCallback(
    (signals: { id: SignalId; source: SignalSource }[]) => {
      if (!consentRef.current || signals.length === 0) return;
      queue.current.push(...signals);
      flushTimer.current ??= setTimeout(flush, SIGNAL_FLUSH_MS);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  // Count explicit, kept display changes (rules in controller.ts). Nothing before consent.
  useEffect(
    () =>
      subscribe((e) => {
        lastEvent.current = e;
        if (!consentRef.current) return;
        enqueue(signalsForEvent(e));
        for (const d of explicitForEvent(e)) explicit.current.add(d);
      }),
    [subscribe, enqueue],
  );

  // A view change made with the Dial switch is explicit. Changes made by a preview (or going back from one) are not.
  const prevMode = useRef(mode);
  const prevPreview = useRef(preview !== null);
  useEffect(() => {
    const changed = prevMode.current !== mode;
    const fromPreview = preview !== null || prevPreview.current;
    prevMode.current = mode;
    prevPreview.current = preview !== null;
    if (!changed || fromPreview || !consentRef.current) return;
    explicit.current.add("view");
    enqueue([{ id: signalForViewChange(mode), source: "settings" }]);
  }, [mode, preview, enqueue]);

  // A kept suggestion that is no longer in effect counts as a "no", once. Never judged mid-preview.
  useEffect(() => {
    // The event behind this change (undo, reset), if any. Consumed now so a later view switch isn't blamed on it.
    const via = revertVia(lastEvent.current);
    lastEvent.current = null;
    if (!consented || preview !== null || watch.current.length === 0) return;
    const gone = revertedItems(watch.current, prefs, mode);
    if (gone.length === 0) return;
    for (const g of gone) void postFeedback(g.id, { outcome: "reverted", items: g.items, via });
    watch.current = withoutReverted(watch.current, gone);
    saveWatch(watch.current);
  }, [consented, preview, prefs, mode]);

  // Fetch a suggestion while something shows one. Never during a preview or before the first-run choice.
  useEffect(() => {
    if (!consented || watchers === 0 || preview !== null || prefs.onboarding === "unset") return;
    let live = true;
    const t = setTimeout(() => {
      const chosen = new Set(explicit.current);
      if (viewWasChosen(readCookies())) chosen.add("view");
      postRecommendation({ preferences: prefs, view: mode, explicit: [...chosen] }).then((s) => {
        if (live) setSuggestion(s);
      });
    }, FETCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [consented, watchers, preview, prefs, mode, profileVersion]);

  const forgetLocal = useCallback(() => {
    queue.current = [];
    explicit.current.clear();
    watch.current = [];
    saveWatch([]);
    setSuggestion(null);
  }, []);

  const setConsent = useCallback(
    async (change: Partial<ConsentState>) => {
      const next = await putConsent(change);
      if (!next) return false;
      setStatus(next);
      if (!next.consent.personalisation) forgetLocal();
      else setProfileVersion((v) => v + 1);
      return true;
    },
    [forgetLocal],
  );

  const saveProfile = useCallback(async (answers: ProfileAnswers) => {
    const ok = await putProfile(answers);
    if (ok) {
      setStatus(await getStatus());
      setProfileVersion((v) => v + 1);
    }
    return ok;
  }, []);

  const saveResearch = useCallback(async (research: ResearchAnswers) => {
    const ok = await putResearch(research);
    if (ok) setStatus(await getStatus());
    return ok;
  }, []);

  const respond = useCallback((s: Suggestion, answer: Answer, items: ItemId[]) => {
    setAnswered((prev) => new Set(prev).add(s.id));
    setSuggestion((cur) => (cur?.id === s.id ? null : cur));
    void postFeedback(s.id, { outcome: answer, items, via: "card" });
    if (answer === "accepted" || answer === "modified") {
      watch.current = [...watch.current.filter((w) => w.id !== s.id), { id: s.id, items }];
      saveWatch(watch.current);
    }
  }, []);

  const rate = useCallback((id: string, satisfaction: -1 | 0 | 1) => void postRating(id, satisfaction), []);
  const noteSignal = useCallback((id: SignalId, source: SignalSource) => (isSignalId(id) ? enqueue([{ id, source }]) : undefined), [enqueue]);
  const noteVoiceOpened = useCallback(() => enqueue([{ id: "voiceSessions", source: "voice" }]), [enqueue]);
  const watchSuggestions = useCallback(() => {
    setWatchers((n) => n + 1);
    return () => setWatchers((n) => n - 1);
  }, []);

  const deleteEverything = useCallback(async () => {
    const ok = await deleteAll();
    if (ok) {
      forgetLocal();
      setStatus(await getStatus());
    }
    return ok;
  }, [forgetLocal]);

  const api = useMemo<PersonalisationApi>(
    () => ({
      loaded,
      status,
      suggestion,
      answered,
      replacedV1,
      setConsent,
      saveProfile,
      saveResearch,
      respond,
      rate,
      noteSignal,
      noteVoiceOpened,
      watchSuggestions,
      exportData: getExport,
      deleteEverything,
    }),
    [loaded, status, suggestion, answered, replacedV1, setConsent, saveProfile, saveResearch, respond, rate, noteSignal, noteVoiceOpened, watchSuggestions, deleteEverything],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
