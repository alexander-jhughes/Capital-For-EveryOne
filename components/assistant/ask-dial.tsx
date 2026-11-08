"use client";

import { Mic, Square, Volume2, X } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { SUGGESTED_QUESTIONS } from "@/lib/assistant/client";
import { spokenText } from "@/lib/dial/runner";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { DialReply } from "../dial/dial-reply";
import { useDialSession } from "../dial/session";
import { useDialVoice } from "../dial/use-dial-voice";
import { useSpeaker } from "../dial/use-speaker";
import { VoiceConsent } from "../dial/voice-consent";
import { VoiceMode } from "../voice/voice-mode";
import { DialMark } from "../wordmark";

const AskContext = createContext<{ openAsk: (question?: string) => void; openVoice: () => void }>({ openAsk: () => {}, openVoice: () => {} });
export const useAskDial = () => useContext(AskContext);

const button = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-[1.1em] font-bold disabled:opacity-60";
const secondary = `${button} hairline bg-card`;

/** The demo questions first, then a few that show what Dial 2.0 can do on the device. */
const TRY = [...SUGGESTED_QUESTIONS.map((q) => q.question), "Where does most of my money go?", "Compare October with September", "Show my groceries spending for October"];

/** Ask Dial: one bottom sheet for the whole app. `openAsk(question)` opens it and asks straight away. */
export function AskDialProvider({ children }: { children: React.ReactNode }) {
  // Only used to count "opened Voice Mode" for optional display suggestions. No personalisation data goes to /api/ask.
  const { noteVoiceOpened } = usePersonalisation();
  const session = useDialSession();
  const speaker = useSpeaker();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [input, setInput] = useState("");
  const [asked, setAsked] = useState("");

  const ask = useCallback(
    async (question: string, replaces?: string) => {
      const q = question.trim();
      if (!q) return;
      speaker.cancel();
      setAsked(q);
      await session.submit(q, { replaces });
    },
    [session, speaker],
  );

  // The sheet's microphone uses the same engine as Voice Mode: one question per tap, shown live, editable.
  const askRef = useRef(ask);
  askRef.current = ask;
  const mic = useDialVoice({
    listenMode: "tap",
    onUtterance: (u) => {
      setInput(u.text);
      void askRef.current(u.text, u.replaces);
    },
  });

  const close = () => dialogRef.current?.close();

  useEffect(() => {
    if (!sheetOpen || voiceOpen) return;
    session.setSurface({ onNavigated: close, onExit: close, onStop: () => (speaker.cancel(), mic.cancel()) });
    return () => session.setSurface(null);
  }, [sheetOpen, voiceOpen, session, speaker, mic]);

  const openAsk = useCallback(
    (question?: string) => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) {
        returnFocus.current = document.activeElement as HTMLElement | null;
        dialog.showModal();
        setSheetOpen(true);
        titleRef.current?.focus();
      }
      if (question) {
        setInput("");
        void ask(question);
      }
    },
    [ask],
  );

  // Runs for the Close button, Escape and backdrop clicks alike. A preview left showing is withdrawn.
  function onClosed() {
    speaker.cancel();
    mic.cancel();
    setSheetOpen(false);
    if (session.offer && !voiceOpen) session.decide(false);
    returnFocus.current?.focus?.();
  }

  const openVoice = () => {
    noteVoiceOpened(); // a count only, and only with suggestions turned on; nothing said is recorded
    dialogRef.current?.close();
    setVoiceOpen(true);
  };

  const turn = session.turn;
  const spoken = turn?.status === "done" ? spokenText(turn.items) : "";
  const listening = mic.state === "listening" || mic.state === "transcribing" || mic.state === "requesting-permission";

  return (
    <AskContext.Provider value={{ openAsk, openVoice }}>
      {children}
      <VoiceMode open={voiceOpen} onClose={() => setVoiceOpen(false)} />
      <dialog ref={dialogRef} aria-labelledby={`${inputId}-title`} className="ask-sheet" onClose={onClosed} onClick={(e) => e.target === dialogRef.current && close()}>
        <div className="flex max-h-[85dvh] flex-col gap-(--space) overflow-y-auto p-(--space) pb-[max(var(--space),env(safe-area-inset-bottom))]">
          <div className="flex flex-wrap items-center justify-between gap-(--space)">
            <h2 id={`${inputId}-title`} ref={titleRef} tabIndex={-1} className="flex items-center gap-2 text-xl font-bold">
              <DialMark className="size-[1.2em]" />
              Dial
            </h2>
            <button type="button" onClick={close} className={secondary}>
              <X aria-hidden className="size-[1em]" />
              Close
            </button>
          </div>
          <button type="button" onClick={openVoice} className="elevated flex min-h-(--target-min) items-center justify-center gap-3 rounded-xl bg-primary px-5 text-lg font-bold text-primary-foreground">
            <Mic aria-hidden className="size-[1.2em]" />
            Talk to Dial
          </button>
          <p className="-mt-1 text-sm text-muted-foreground">
            Ask about your money, ask Dial to take you somewhere, or ask it to change how the app looks. Or change it yourself in{" "}
            <Link href="/account/settings" onClick={close} className="font-bold text-primary underline underline-offset-4">
              Display and voice
            </Link>
            .
          </p>

          {mic.consent && <VoiceConsent tone="light" onChoose={mic.consent.choose} onDismiss={mic.consent.dismiss} />}

          <div aria-live="polite" aria-busy={turn?.status === "working"} className="flex flex-col gap-(--space)">
            {turn && asked && <p className="text-sm text-muted-foreground">You asked: {turn.input}</p>}
            {turn && <DialReply turn={turn} tone="light" offer={session.offer} onDecide={session.decide} onFollowUp={(q) => void ask(q)} onNavigate={close} />}
            {spoken && speaker.supported && (
              <button type="button" onClick={() => (speaker.speaking ? speaker.cancel() : speaker.speak(spoken))} className={`${secondary} self-start`} aria-pressed={speaker.speaking}>
                {speaker.speaking ? <Square aria-hidden className="size-[1em]" /> : <Volume2 aria-hidden className="size-[1em]" />}
                {speaker.speaking ? "Stop reading" : "Read aloud"}
              </button>
            )}
          </div>

          <section aria-labelledby={`${inputId}-chips`} className="flex flex-col gap-2">
            <h3 id={`${inputId}-chips`} className="text-sm font-bold">
              Try asking
            </h3>
            <ul className="flex flex-col gap-2">
              {TRY.map((question) => (
                <li key={question}>
                  <button type="button" onClick={() => void ask(question)} className="min-h-(--target-min) w-full rounded-xl hairline bg-background px-4 py-2 text-left font-bold hover:bg-accent">
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void ask(input);
            }}
            className="flex flex-col gap-1"
          >
            <label htmlFor={inputId} className="text-sm font-bold">
              Or ask your own question
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={inputId}
                value={listening && mic.snapshot ? mic.snapshot.text : input}
                onChange={(e) => setInput(e.target.value)}
                readOnly={listening}
                maxLength={300}
                autoComplete="off"
                className="min-h-(--target-min) min-w-0 flex-1 basis-48 rounded-xl hairline bg-background px-3"
              />
              {mic.supported && (
                <button type="button" onClick={listening ? mic.stop : mic.start} aria-pressed={listening} className={secondary}>
                  {listening ? <Square aria-hidden className="size-[1em]" /> : <Mic aria-hidden className="size-[1em]" />}
                  {listening ? "Stop listening" : "Speak"}
                </button>
              )}
              <button type="submit" disabled={turn?.status === "working"} className={`${button} border-primary bg-primary text-primary-foreground`}>
                Ask
              </button>
            </div>
            <p role="status" className="text-sm empty:hidden">
              {listening ? "Listening... you can correct yourself, for example: food, actually groceries." : (mic.error?.message ?? "")}
            </p>
          </form>
          {process.env.NODE_ENV === "development" && (
            <p className="text-sm text-muted-foreground">
              dev: {session.stats.turns} turns, {session.stats.local} handled on the device, {session.stats.network} backend calls, {session.stats.reused} reused
            </p>
          )}
        </div>
      </dialog>
    </AskContext.Provider>
  );
}
