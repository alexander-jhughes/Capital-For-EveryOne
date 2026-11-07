"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

const AnnounceContext = createContext<(message: string) => void>(() => {});

/** One polite live region for the whole app: mode changes, payments, Spend Pause decisions, saves. */
export function AnnouncerProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const announce = useCallback((m: string) => {
    // Clear first so repeating the same message is still announced.
    setMessage("");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(m), 50);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

export const useAnnounce = () => useContext(AnnounceContext);
