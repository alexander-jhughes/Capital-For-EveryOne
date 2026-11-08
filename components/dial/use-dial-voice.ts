"use client";

// The microphone as Dial's surfaces use it: the shared voice engine, behind the person's choice of where their voice
// is turned into text. Nothing listens until they have chosen, and nothing listens in the background.
//
// Tapping the microphone:
//   - never chosen, or chose typing: offers the choice (on this device, the browser's online service, or typing).
//   - on this device, but the browser doesn't have the on-device language installed: offers the same choice with a
//     plain explanation, instead of a dead-end error. Chrome's on-device pack often isn't installed.
//   - online service or an installed on-device language: starts listening. The browser then shows its own microphone
//     permission prompt the first time; if it was refused earlier, the error says how to allow it.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePreferences } from "@/lib/preferences/provider";
import type { Preferences } from "@/lib/preferences/schema";
import type { ListenMode, Utterance } from "@/lib/voice/types";
import { useVoiceEngine } from "@/lib/voice/use-voice-engine";

type SpeechChoice = Exclude<Preferences["speechInput"], "unset">;

export function useDialVoice(opts: { listenMode?: ListenMode; onUtterance(u: Utterance): void; onInterrupt?(reason: "user-speech" | "stop-word" | "backgrounded"): void }) {
  const { prefs, apply } = usePreferences();
  const [asking, setAsking] = useState<{ notice?: string } | null>(null);
  const startAfterChoice = useRef(false);
  const engine = useVoiceEngine({
    allowCloud: prefs.speechInput === "cloud",
    listenMode: opts.listenMode ?? prefs.listenMode,
    onUtterance: opts.onUtterance,
    onInterrupt: opts.onInterrupt,
  });
  const { start: engineStart, error } = engine;

  const start = useCallback(() => {
    // "typing" is a choice the person can change their mind about: tapping the microphone offers the choice again
    // instead of leaving voice switched off with no way back.
    if (prefs.speechInput === "unset" || prefs.speechInput === "typing") return setAsking({});
    engineStart();
  }, [prefs.speechInput, engineStart]);

  // On-device recognition isn't installed in this browser: say so and offer the online service, rather than a dead end.
  useEffect(() => {
    if (error?.code === "language-unavailable" && prefs.speechInput !== "cloud") {
      setAsking({ notice: "Your browser doesn't have on-device speech recognition ready yet, so it can't hear you without its online speech service." });
    }
  }, [error, prefs.speechInput]);

  /** Saved straight away, like any setting changed in Display and voice; it can be changed there later. */
  const choose = useCallback(
    (choice: SpeechChoice) => {
      apply([{ type: "speechInput", value: choice }], { save: true, source: "settings" });
      setAsking(null);
      startAfterChoice.current = choice !== "typing";
    },
    [apply],
  );

  // Start once the engine has been rebuilt with the new choice (allowCloud changes with it).
  useEffect(() => {
    if (!startAfterChoice.current || prefs.speechInput === "unset" || prefs.speechInput === "typing") return;
    startAfterChoice.current = false;
    engineStart();
  }, [prefs.speechInput, engineStart]);

  return {
    ...engine,
    start,
    speechInput: prefs.speechInput,
    consent: asking ? { choose, dismiss: () => setAsking(null), notice: asking.notice } : null,
  };
}
