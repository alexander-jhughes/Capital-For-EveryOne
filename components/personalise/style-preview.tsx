"use client";

import { Check, X } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { usePreferences } from "@/lib/preferences/provider";
import type { Recommendation } from "@/lib/preferences/recommend";
import { STYLES } from "@/lib/preferences/recommend";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";

interface StylePreview {
  start: (r: Recommendation) => void;
  active: { name: string; fromMode: Mode } | null;
}

const Ctx = createContext<StylePreview>({ start: () => {}, active: null });
export const useStylePreview = () => useContext(Ctx);

/** Previews a suggested style across the whole app (preferences + view), and remembers how to undo it exactly. */
export function StylePreviewProvider({ children }: { children: React.ReactNode }) {
  const { mode, setMode } = useMode();
  const { startPreview, acceptPreview, rejectPreview } = usePreferences();
  const announce = useAnnounce();
  const [active, setActive] = useState<StylePreview["active"]>(null);

  const start = (r: Recommendation) => {
    setActive({ name: STYLES[r.style].name, fromMode: mode });
    startPreview(r.actions);
    if (r.mode !== mode) setMode(r.mode);
    announce(`Previewing ${STYLES[r.style].name}. Keep it or go back from the bar at the top.`);
  };

  // Keeping a style saves it: the whole point of choosing one is that it is still there next time.
  const finish = (keep: boolean) => {
    if (!active) return;
    if (keep) acceptPreview({ save: true });
    else {
      rejectPreview();
      if (mode !== active.fromMode) setMode(active.fromMode);
    }
    announce(keep ? `${active.name} kept. Change or undo it any time in Display and voice.` : "Back to how it was.");
    setActive(null);
  };

  return (
    <Ctx.Provider value={{ start, active }}>
      {active && (
        <div role="region" aria-label="Style preview" className="gutter sticky top-0 z-50 bg-primary py-2 text-primary-foreground">
          <div className="page-width flex flex-wrap items-center justify-between gap-x-4 gap-y-2 lg:px-10">
            <p className="font-bold">Previewing {active.name}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => finish(true)} className="inline-flex min-h-(--target-min) items-center gap-1.5 rounded-full bg-primary-foreground px-4 font-bold text-primary">
                <Check aria-hidden className="size-[1em]" />
                Keep it
              </button>
              <button type="button" onClick={() => finish(false)} className="inline-flex min-h-(--target-min) items-center gap-1.5 rounded-full border border-primary-foreground px-4 font-bold">
                <X aria-hidden className="size-[1em]" />
                Go back
              </button>
            </div>
          </div>
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}
