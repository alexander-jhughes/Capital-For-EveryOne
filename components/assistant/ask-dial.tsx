"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { useProfile } from "@/lib/profile/provider";
import { VoiceMode } from "../voice/voice-mode";

const AskContext = createContext<{ openAsk: (question?: string) => void; openVoice: () => void }>({ openAsk: () => {}, openVoice: () => {} });
export const useAskDial = () => useContext(AskContext);

/**
 * Dial for the whole app: one non-modal panel for typing and talking (components/voice/voice-mode.tsx).
 * `openAsk(question)` opens it and asks straight away; `openVoice()` just opens it. There is no separate modal sheet,
 * so nothing ever covers the page with a backdrop.
 */
export function AskDialProvider({ children }: { children: React.ReactNode }) {
  // Only used to count "opened Voice Mode" for optional display suggestions. No personalisation data goes to /api/ask.
  const { noteVoiceOpened } = usePersonalisation();
  // A count only, and only with About you tailoring turned on. What's asked is never stored in the profile.
  const { noteUsage } = useProfile();
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ text: string; id: number } | null>(null);

  const openAsk = useCallback((question?: string) => {
    noteUsage("dial");
    setOpen(true);
    if (question?.trim()) setRequest((r) => ({ text: question.trim(), id: (r?.id ?? 0) + 1 }));
  }, [noteUsage]);

  const openVoice = useCallback(() => {
    noteVoiceOpened(); // a count only, and only with suggestions turned on; nothing said is recorded
    noteUsage("dial");
    setOpen(true);
  }, [noteVoiceOpened, noteUsage]);

  return (
    <AskContext.Provider value={{ openAsk, openVoice }}>
      {children}
      <VoiceMode open={open} onClose={() => setOpen(false)} request={request} />
    </AskContext.Provider>
  );
}
