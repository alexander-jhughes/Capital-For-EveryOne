"use client";

import { createContext, useContext, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import type { Mode } from "@/lib/types";

import { MODE_KEY } from "@/lib/demo-config";

const ModeContext = createContext<{ mode: Mode; setMode: (m: Mode) => void } | null>(null);

export function ModeProvider({ initialMode, children }: { initialMode: Mode; children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(initialMode);
  const announce = useAnnounce();

  const setMode = (m: Mode) => {
    setModeState(m);
    document.documentElement.dataset.mode = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
    // Cookie lets the server render the right mode's content, so there is no content flash either.
    document.cookie = `${MODE_KEY}=${m}; path=/; max-age=31536000; samesite=lax`;
    announce(`Dial: ${m === "simple" ? "Simple" : "Complex"} view on.`);
  };

  return <ModeContext.Provider value={{ mode, setMode }}>{children}</ModeContext.Provider>;
}

export function useMode() {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode must be used inside ModeProvider");
  return ctx;
}
