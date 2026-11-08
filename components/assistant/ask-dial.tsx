"use client";

import { Mic, Square, Volume2, X } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { askDial, intentForQuestion, offlineFacts, SUGGESTED_QUESTIONS } from "@/lib/assistant/client";
import { canSpeak, pickVoice } from "@/lib/assistant/speech";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { usePreferences } from "@/lib/preferences/provider";
import { dialStyle } from "@/lib/preferences/schema";
import type { Utterance } from "@/lib/voice/types";
import { needsSpeechChoice, useMicButton, useVoice } from "@/lib/voice/use-voice";
import { paymentReply } from "@/lib/payments/dial";
import { spendPauseReply, type SpendPauseReply } from "@/lib/spend-pause/dial";
import { liveState } from "@/lib/assistant/live-state";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { useAccount } from "@/lib/state/account-context";
import type { AskResponse, Fact } from "@/lib/types";
import { SpeechConsent, type SpeechChoice } from "../voice/speech-consent";
import { VoiceMode } from "../voice/voice-mode";
import { DialMark } from "../wordmark";
import type { ExperienceTemplate } from "@/lib/assistant/experience";
import { ExperienceCard } from "../experience/templates";
import { EvidenceList } from "./evidence-list";

type Answer =
  | { status: "idle" }
  | { status: "loading"; question: string }
  | { status: "answered"; question: string; text: string; evidenceIds: string[]; source: AskResponse["source"]; template: ExperienceTemplate; action?: SpendPauseReply["action"] }
  | { status: "offline"; question: string; facts: Fact[]; evidenceIds: string[] }
  | { status: "invalid"; question: string; message: string }
  | { status: "unavailable"; question: string };

const AskContext = createContext<{ openAsk: (question?: string) => void; openVoice: () => void }>({ openAsk: () => {}, openVoice: () => {} });
export const useAskDial = () => useContext(AskContext);

const button = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-[1.1em] font-bold disabled:opacity-60";
const secondary = `${button} hairline bg-card`;

/** Ask Dial: one bottom sheet for the whole app. `openAsk(question)` opens it and asks straight away. */
export function AskDialProvider({ children }: { children: React.ReactNode }) {
  const { account, transactions, settings, payments, spendPauseActivity } = useAccount();
  // Only used to count "opened Voice Mode" for optional display suggestions. No personalisation data goes to /api/ask.
  const { noteVoiceOpened } = usePersonalisation();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);
  /** The last question as the backend understood it (resolvedQuestion), sent as previousQuestion for follow-ups. */
  const lastQuestion = useRef<string | undefined>(undefined);
  const inFlight = useRef<AbortController | null>(null);
  const lastUtterance = useRef(0);
  const inputId = useId();
  const { prefs } = usePreferences();

  const [answer, setAnswer] = useState<Answer>({ status: "idle" });
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [input, setInput] = useState("");
  const [canTalk, setCanTalk] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  // Feature-detect after mount so server and first client render agree.
  useEffect(() => setCanTalk(canSpeak(window)), []);
  // The same engine as Voice Mode. The sheet listens for one question per tap, or while held.
  const voice = useVoice({ speechInput: prefs.speechInput, onUtterance: (u) => onUtterance(u) });
  const sheetMode = prefs.listenMode === "hold" ? "hold" : "tap";

  const stopSpeaking = useCallback(() => {
    if (canSpeak(window)) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const ask = useCallback(
    async (question: string, replaces?: string) => {
      const q = question.trim();
      if (!q) {
        setAnswer({ status: "invalid", question: "", message: "Please type a question first." });
        return;
      }
      stopSpeaking();
      const id = ++requestId.current;
      // A newer question cancels the older one; its answer would be ignored anyway.
      inFlight.current?.abort();
      inFlight.current = null;
      // Spend Pause and payment questions are answered here from live state, so they work with or without the backend.
      const paid = paymentReply(q, { account, transactions, payments });
      const local = spendPauseReply(q, settings, spendPauseActivity) ?? (paid ? { text: paid, action: undefined } : null);
      if (local) {
        setAnswer({ status: "answered", question: q, text: local.text, evidenceIds: [], source: "template", template: "general", action: local.action });
        return;
      }
      setAnswer({ status: "loading", question: q });
      const controller = new AbortController();
      inFlight.current = controller;
      const outcome = await askDial(q, {
        state: liveState(transactions, settings),
        // A spoken self-correction ("Actually, groceries") is resolved against the words it replaced.
        previousQuestion: replaces ?? lastQuestion.current,
        style: dialStyle(prefs),
        signal: controller.signal,
      });
      if (id !== requestId.current || outcome.kind === "cancelled") return; // a newer question replaced this one
      inFlight.current = null;
      lastQuestion.current = (outcome.kind === "answer" && outcome.resolvedQuestion) || q;
      if (outcome.kind === "answer") {
        const { answer: text, evidenceIds, source } = outcome.response;
        setAnswer({ status: "answered", question: q, text, evidenceIds, source, template: outcome.experience.template });
      } else if (outcome.kind === "invalid") {
        setAnswer({ status: "invalid", question: q, message: outcome.message });
      } else {
        const intent = intentForQuestion(q);
        setAnswer(
          intent
            ? { status: "offline", question: q, ...offlineFacts(intent, { account, txns: transactions, settings, today: DEMO_TODAY, now: DEMO_NOW }) }
            : { status: "unavailable", question: q },
        );
      }
    },
    [account, transactions, settings, payments, spendPauseActivity, stopSpeaking, prefs],
  );

  // Each spoken question is asked once, through the same ask() as typed text.
  function onUtterance(u: Utterance) {
    voice.setProcessing(false); // the sheet shows its own "Checking your account..."
    if (u.utteranceId <= lastUtterance.current) return;
    lastUtterance.current = u.utteranceId;
    setInput(u.text);
    void ask(u.text, u.replaces);
  }

  function startListening() {
    stopSpeaking();
    if (voice.listening) return;
    if (needsSpeechChoice(prefs.speechInput) || voice.backend === "none") return setChoosing(true);
    setChoosing(false);
    voice.start(sheetMode);
  }
  const mic = useMicButton({ hold: sheetMode === "hold", listening: voice.listening, onStart: startListening, onStop: voice.stop });

  function chosen(choice: SpeechChoice) {
    setChoosing(false);
    if (choice === "typing" || sheetMode === "hold") return;
    if (choice === prefs.speechInput) voice.start(sheetMode);
    else voice.startWhenReady(sheetMode);
  }

  const openAsk = useCallback(
    (question?: string) => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.open) {
        returnFocus.current = document.activeElement as HTMLElement | null;
        dialog.showModal();
        titleRef.current?.focus();
      }
      if (question) {
        setInput("");
        void ask(question);
      }
    },
    [ask],
  );

  function close() {
    dialogRef.current?.close();
  }

  // Runs for the Close button, Escape and backdrop clicks alike.
  function onClosed() {
    stopSpeaking();
    voice.cancel();
    setChoosing(false);
    returnFocus.current?.focus?.();
  }

  function readAloud(text: string) {
    if (speaking) return stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    const v = pickVoice(window.speechSynthesis.getVoices());
    if (v) u.voice = v;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setSpeaking(true);
  }

  const spoken =
    answer.status === "answered" ? answer.text : answer.status === "offline" ? answer.facts.map((f) => `${f.label}: ${f.value}.`).join(" ") : "";

  const openVoice = () => {
    noteVoiceOpened(); // a count only, and only with suggestions turned on; nothing said is recorded
    dialogRef.current?.close();
    setVoiceOpen(true);
  };

  return (
    <AskContext.Provider value={{ openAsk, openVoice }}>
      {children}
      <VoiceMode open={voiceOpen} onClose={() => setVoiceOpen(false)} />
      <dialog
        ref={dialogRef}
        aria-labelledby={`${inputId}-title`}
        className="ask-sheet"
        onClose={onClosed}
        onClick={(e) => e.target === dialogRef.current && close()}
      >
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
            Ask about your money, or ask Dial to change how the app looks. Or change it yourself in{" "}
            <Link href="/account/settings" onClick={close} className="font-bold text-primary underline underline-offset-4">
              Display and voice
            </Link>
            .
          </p>

          <div aria-live="polite" aria-busy={answer.status === "loading"} className="flex flex-col gap-(--space)">
            {answer.status !== "idle" && answer.question && (
              <p className="text-sm text-muted-foreground">You asked: {answer.question}</p>
            )}
            {answer.status === "loading" && (
              <div>
                <p>Checking your account...</p>
                <div aria-hidden className="mt-2 flex flex-col gap-2">
                  <span className="h-4 w-11/12 animate-pulse rounded bg-muted" />
                  <span className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                </div>
              </div>
            )}
            {answer.status === "answered" && <p className="text-lg font-bold">{answer.text}</p>}
            {answer.status === "answered" && answer.action && (
              <Link href={answer.action.href} onClick={close} className="inline-flex min-h-(--target-min) items-center self-start font-bold text-primary underline underline-offset-4">
                {answer.action.label}
              </Link>
            )}
            {answer.status === "answered" && <ExperienceCard template={answer.template} evidenceIds={answer.evidenceIds} onNavigate={close} />}
            {answer.status === "offline" && (
              <div className="flex flex-col gap-1">
                <p className="text-sm">Dial&apos;s assistant isn&apos;t available right now. This is what your account shows:</p>
                <dl>
                  {answer.facts.map((f) => (
                    <div key={f.key}>
                      <dt className="text-sm text-muted-foreground">{f.label}</dt>
                      <dd className="text-lg font-bold">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            {answer.status === "invalid" && <p className="font-bold">{answer.message}</p>}
            {answer.status === "unavailable" && (
              <p className="font-bold">
                Dial&apos;s assistant isn&apos;t available right now, so it can&apos;t answer typed questions. The suggested questions below still work.
              </p>
            )}
            {spoken && canTalk && (
              <button type="button" onClick={() => readAloud(spoken)} className={`${secondary} self-start`} aria-pressed={speaking}>
                {speaking ? <Square aria-hidden className="size-[1em]" /> : <Volume2 aria-hidden className="size-[1em]" />}
                {speaking ? "Stop reading" : "Read aloud"}
              </button>
            )}
            {/* A financial card already shows its evidence and next step; the plain list is for general answers. */}
            {((answer.status === "answered" && answer.template === "general") || answer.status === "offline") && <EvidenceList ids={answer.evidenceIds} onNavigate={close} />}
            {answer.status === "answered" && process.env.NODE_ENV === "development" && (
              <p className="self-start rounded border border-input px-2 text-sm">dev: source {answer.source}</p>
            )}
          </div>

          <section aria-labelledby={`${inputId}-chips`} className="flex flex-col gap-2">
            <h3 id={`${inputId}-chips`} className="text-sm font-bold">
              Try asking
            </h3>
            <ul className="flex flex-col gap-2">
              {SUGGESTED_QUESTIONS.map(({ question }) => (
                <li key={question}>
                  <button
                    type="button"
                    onClick={() => void ask(question)}
                    className="min-h-(--target-min) w-full rounded-xl hairline bg-background px-4 py-2 text-left font-bold hover:bg-accent"
                  >
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
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={300}
                autoComplete="off"
                className="min-h-(--target-min) min-w-0 flex-1 basis-48 rounded-xl hairline bg-background px-3"
              />
              {voice.recognition && (
                <button type="button" {...mic.props} aria-pressed={voice.listening} className={`${secondary} ${sheetMode === "hold" ? "touch-none select-none" : ""}`}>
                  {voice.listening ? <Square aria-hidden className="size-[1em]" /> : <Mic aria-hidden className="size-[1em]" />}
                  {voice.listening ? "Stop listening" : sheetMode === "hold" ? "Hold to speak" : "Speak"}
                </button>
              )}
              <button type="submit" disabled={answer.status === "loading"} className={`${button} border-primary bg-primary text-primary-foreground`}>
                Ask
              </button>
            </div>
            {/* Interim words show as they arrive but aren't announced word by word; the question is sent once it ends. */}
            {voice.transcript?.text && (
              <p className="text-sm">
                <span className="font-bold">Hearing: </span>
                <span className="italic text-muted-foreground">{voice.transcript.text}</span>
              </p>
            )}
            <p role="status" className="text-sm empty:hidden">
              {voice.error?.message ??
                (voice.state === "requesting-permission"
                  ? "Waiting for the microphone. If your browser asks, choose Allow."
                  : voice.state === "listening" || voice.state === "transcribing"
                    ? "Listening..."
                    : voice.state === "interrupted"
                      ? "Stopped listening."
                      : "")}
            </p>
          </form>
          {choosing && (
            <div className="rounded-xl bg-card p-(--space) hairline">
              <SpeechConsent onDone={chosen} onCancel={() => setChoosing(false)} />
            </div>
          )}
        </div>
      </dialog>
    </AskContext.Provider>
  );
}
