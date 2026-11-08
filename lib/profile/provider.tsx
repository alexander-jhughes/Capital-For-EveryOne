"use client";

// The browser's copy of the saved profile. The server is the source of truth (a signed, HttpOnly cookie the browser
// can't read or forge); this only mirrors GET /api/profile and sends changes. Without consent it holds nothing.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NeedId, PersonType } from "./catalog";
import type { UsageKind } from "./features";
import type { ProfileResult } from "./infer";

export interface ProfileView {
  consent: boolean;
  sensitiveConsent: boolean;
  needs: NeedId[];
  chosen: PersonType | null;
  result: ProfileResult | null;
}

export interface ProfileChangeRequest {
  consent?: boolean;
  sensitiveConsent?: boolean;
  needs?: NeedId[];
  chosen?: PersonType | null;
}

interface ProfileApi {
  profile: ProfileView | null;
  /** false until the first reply, so screens don't flash a card that then disappears. */
  ready: boolean;
  /** Resolves to null on success, or the server's friendly message. */
  save: (change: ProfileChangeRequest) => Promise<string | null>;
  remove: () => Promise<string | null>;
  /** One use of a part of the app. Ignored without consent; the server checks too. */
  noteUsage: (kind: UsageKind) => void;
}

const EMPTY: ProfileView = { consent: false, sensitiveConsent: false, needs: [], chosen: null, result: null };
const Ctx = createContext<ProfileApi>({ profile: null, ready: false, save: async () => null, remove: async () => null, noteUsage: () => {} });
export const useProfile = () => useContext(Ctx);

function parseView(body: unknown): ProfileView | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Partial<ProfileView>;
  if (typeof b.consent !== "boolean" || typeof b.sensitiveConsent !== "boolean" || !Array.isArray(b.needs)) return null;
  return { consent: b.consent, sensitiveConsent: b.sensitiveConsent, needs: b.needs, chosen: b.chosen ?? null, result: b.result ?? null };
}

async function call(method: string, body?: unknown): Promise<{ view: ProfileView | null; error: string | null }> {
  try {
    const res = await fetch("/api/profile", { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) return { view: null, error: (json as { error?: string } | null)?.error ?? "Sorry, that couldn't be saved. Please try again." };
    return { view: parseView(json), error: null };
  } catch {
    return { view: null, error: "We couldn't reach the server. Nothing has changed." };
  }
}

/** Counts one visit to a screen, once per mount. */
export function useCountUse(kind: UsageKind) {
  const { noteUsage, ready } = useProfile();
  useEffect(() => {
    if (ready) noteUsage(kind);
  }, [ready, kind, noteUsage]);
}

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [ready, setReady] = useState(false);
  const consented = useRef(false);
  consented.current = profile?.consent ?? false;

  // Every profile request goes out one at a time, in order. Each reply re-signs the whole cookie, so two requests in
  // flight together could finish in either order: a usage count started before "Delete everything" could otherwise
  // land last and put the deleted profile back. Queued, the count runs after the delete, finds no profile, and does nothing.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inOrder = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(task, task);
    queue.current = next.catch(() => {});
    return next;
  }, []);

  const refresh = useCallback(async () => {
    const { view } = await inOrder(() => call("GET"));
    setProfile(view ?? EMPTY);
    setReady(true);
  }, [inOrder]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Counts change the model's input, so the result is fetched again, but at most once every few seconds.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelRefresh = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
  };

  const save = useCallback(
    async (change: ProfileChangeRequest) => {
      if (change.consent === false) consented.current = false;
      const { view, error } = await inOrder(() => call("PUT", change));
      if (view) setProfile(view);
      return error;
    },
    [inOrder],
  );

  const remove = useCallback(async () => {
    // No more counts from now on, even before the reply arrives.
    consented.current = false;
    cancelRefresh();
    const { view, error } = await inOrder(() => call("DELETE"));
    if (view) setProfile(view);
    return error;
  }, [inOrder]);

  const noteUsage = useCallback(
    (kind: UsageKind) => {
      if (!consented.current) return;
      void inOrder(() => fetch("/api/profile/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) }))
        .then(() => {
          cancelRefresh();
          pending.current = setTimeout(() => void refresh(), 3000);
        })
        .catch(() => {});
    },
    [inOrder, refresh],
  );

  const value = useMemo(() => ({ profile, ready, save, remove, noteUsage }), [profile, ready, save, remove, noteUsage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
