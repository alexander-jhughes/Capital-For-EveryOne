"use client";

import { Check, X } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { usePreferences } from "@/lib/preferences/provider";
import type { Recommendation } from "@/lib/preferences/recommend";
import { STYLES } from "@/lib/preferences/recommend";
import type { UiAction } from "@/lib/preferences/schema";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";

/** Anything previewed with the "Keep it / Go back" bar: a "Make it yours" style or an ML suggestion. */
export interface PreviewRequest {
  name: string;
  actions: UiAction[];
  /** Switch view for the preview (styles only). ML suggestions never set this. */
  mode?: Mode;
  source: "style" | "ml";
  /** Called once the person keeps it or goes back. */
  onFinish?: (kept: boolean) => void;
}

interface StylePreview {
  start: (r: Recommendation) => void;
  startRequest: (req: PreviewRequest) => void;
  active: { name: string; fromMode: Mode } | null;
}

const Ctx = createContext<StylePreview>({ start: () => {}, startRequest: () => {}, active: null });
export const useStylePreview = () => useContext(Ctx);

/** Previews a suggested style across the whole app (preferences + view), and remembers how to undo it exactly. */
export function StylePreviewProvider({ children }: { children: React.ReactNode }) {
  const { mode, setMode } = useMode();
  const { startPreview, acceptPreview, rejectPreview } = usePreferences();
  const announce = useAnnounce();
  const [active, setActive] = useState<(StylePreview["active"] & { onFinish?: (kept: boolean) => void }) | null>(null);

  const startRequest = (req: PreviewRequest) => {
    setActive({ name: req.name, fromMode: mode, onFinish: req.onFinish });
    startPreview(req.actions, { source: req.source });
    if (req.mode && req.mode !== mode) setMode(req.mode);
    announce(`Previewing ${req.name}. Keep it or go back from the bar at the top.`);
  };
  const start = (r: Recommendation) => startRequest({ name: STYLES[r.style].name, actions: r.actions, mode: r.mode, source: "style" });

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
    active.onFinish?.(keep);
  };

  return (
    <Ctx.Provider value={{ start, startRequest, active: active && { name: active.name, fromMode: active.fromMode } }}>
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
