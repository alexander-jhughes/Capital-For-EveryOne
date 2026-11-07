"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type ChangeSource, emit, type PrefsListener } from "./events";
import { applyActions, DEFAULT_PREFS, encodePrefs, prefAttributes, PREFS_COOKIE, sanitize, type Preferences, type UiAction } from "./schema";

const SESSION_KEY = "cfe-prefs-session";

interface PrefsApi {
  /** What the screen shows now: a pending preview if there is one, else the kept preferences. */
  prefs: Preferences;
  /** The actions being previewed, if any. */
  preview: UiAction[] | null;
  canUndo: boolean;
  /** Kept changes that are not yet saved for future visits. */
  unsaved: boolean;
  /** Shows a change without keeping it: nothing is saved and undo history is untouched. */
  startPreview: (actions: UiAction[], opts?: { source?: ChangeSource }) => void;
  /** Keeps the preview; with `save`, also saves it for future visits in the same step. */
  acceptPreview: (opts?: { save?: boolean }) => void;
  rejectPreview: () => void;
  /** Applies straight away (settings page): still undoable, still session-only until saved. */
  apply: (actions: UiAction[], opts?: { save?: boolean; source?: ChangeSource }) => void;
  undo: () => void;
  save: () => void;
  resetToDefault: () => void;
  /** Notified after a change is kept, undone or reset (never for previews). Returns an unsubscribe function. */
  subscribe: (listener: PrefsListener) => () => void;
}

const PrefsContext = createContext<PrefsApi | null>(null);

function writeCookie(p: Preferences | null) {
  document.cookie = p
    ? `${PREFS_COOKIE}=${encodePrefs(p)}; path=/; max-age=31536000; samesite=lax`
    : `${PREFS_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/**
 * The single source of truth for accessibility preferences and personal layout.
 * saved (cookie, read by the server so it never flashes) → kept (this session) → preview (not yet accepted).
 */
export function PreferencesProvider({ initial, children }: { initial: Preferences; children: React.ReactNode }) {
  const [saved, setSaved] = useState(initial);
  const [kept, setKept] = useState(initial);
  const [preview, setPreview] = useState<{ actions: UiAction[]; result: Preferences; source: ChangeSource } | null>(null);
  /** Each entry: the preferences before a kept change, and where that change came from (so undo can say what it undid). */
  const history = useRef<{ prefs: Preferences; source: ChangeSource }[]>([]);
  const listeners = useRef(new Set<PrefsListener>());
  const subscribe = useCallback((l: PrefsListener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);
  const [historyLength, setHistoryLength] = useState(0);

  // Restore changes kept earlier in this session (not saved). Storage may be unavailable: the saved look still works.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) setKept(sanitize(JSON.parse(raw)));
    } catch {}
  }, []);

  const keep = useCallback((next: Preferences, prev: Preferences, source: ChangeSource) => {
    history.current.push({ prefs: prev, source });
    setHistoryLength(history.current.length);
    setKept(next);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const prefs = preview?.result ?? kept;

  useEffect(() => {
    const el = document.documentElement;
    for (const [k, v] of Object.entries(prefAttributes(prefs))) el.setAttribute(k, v);
  }, [prefs]);

  const api = useMemo<PrefsApi>(
    () => ({
      prefs,
      preview: preview?.actions ?? null,
      canUndo: historyLength > 0,
      unsaved: JSON.stringify(kept) !== JSON.stringify(saved),
      startPreview: (actions, opts) => setPreview({ actions, result: applyActions(kept, actions), source: opts?.source ?? "other" }),
      acceptPreview: (opts) => {
        if (!preview) return;
        keep(preview.result, kept, preview.source);
        setPreview(null);
        if (opts?.save) {
          writeCookie(preview.result);
          setSaved(preview.result);
        }
        emit(listeners.current, { kind: "kept", actions: preview.actions, before: kept, after: preview.result, source: preview.source });
      },
      rejectPreview: () => setPreview(null),
      apply: (actions, opts) => {
        const next = applyActions(kept, actions);
        const source = opts?.source ?? "other";
        keep(next, kept, source);
        if (opts?.save) {
          writeCookie(next);
          setSaved(next);
        }
        emit(listeners.current, { kind: "kept", actions, before: kept, after: next, source });
      },
      undo: () => {
        const entry = history.current.pop();
        setHistoryLength(history.current.length);
        if (!entry) return;
        const prev = entry.prefs;
        setPreview(null);
        setKept(prev);
        try {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(prev));
        } catch {}
        emit(listeners.current, { kind: "undo", before: kept, after: prev, undoneSource: entry.source });
      },
      save: () => {
        writeCookie(kept);
        setSaved(kept);
      },
      resetToDefault: () => {
        keep(DEFAULT_PREFS, kept, "other");
        setPreview(null);
        writeCookie(null);
        setSaved(DEFAULT_PREFS);
        emit(listeners.current, { kind: "reset", before: kept });
      },
      subscribe,
    }),
    [prefs, preview, historyLength, kept, saved, keep, subscribe],
  );

  return <PrefsContext.Provider value={api}>{children}</PrefsContext.Provider>;
}

export function usePreferences() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider");
  return ctx;
}
