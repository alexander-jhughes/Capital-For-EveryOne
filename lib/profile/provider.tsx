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

  const refresh = useCallback(async () => {
    const { view } = await call("GET");
    setProfile(view ?? EMPTY);
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (change: ProfileChangeRequest) => {
    const { view, error } = await call("PUT", change);
    if (view) setProfile(view);
    return error;
  }, []);

  const remove = useCallback(async () => {
    const { view, error } = await call("DELETE");
    if (view) setProfile(view);
    return error;
  }, []);

  // Counts change the model's input, so the result is fetched again, but at most once every few seconds.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteUsage = useCallback(
    (kind: UsageKind) => {
      if (!consented.current) return;
      void fetch("/api/profile/usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) })
        .then(() => {
          if (pending.current) clearTimeout(pending.current);
          pending.current = setTimeout(() => void refresh(), 3000);
        })
        .catch(() => {});
    },
    [refresh],
  );

  const value = useMemo(() => ({ profile, ready, save, remove, noteUsage }), [profile, ready, save, remove, noteUsage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
