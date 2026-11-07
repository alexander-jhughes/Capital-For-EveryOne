"use client";

import { Mic, Square, Volume2, X } from "lucide-react";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { askDial, intentForQuestion, offlineFacts, SUGGESTED_QUESTIONS } from "@/lib/assistant/client";
import { canSpeak, getRecognition, pickVoice, voiceErrorMessage, type Recognition } from "@/lib/assistant/speech";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { useAccount } from "@/lib/state/account-context";
import type { AskResponse, Fact } from "@/lib/types";
import { VoiceMode } from "../voice/voice-mode";
import { DialMark } from "../wordmark";
import { EvidenceList } from "./evidence-list";

type Answer =
  | { status: "idle" }
  | { status: "loading"; question: string }
  | { status: "answered"; question: string; text: string; evidenceIds: string[]; source: AskResponse["source"] }
  | { status: "offline"; question: string; facts: Fact[]; evidenceIds: string[] }
  | { status: "invalid"; question: string; message: string }
  | { status: "unavailable"; question: string };

const AskContext = createContext<{ openAsk: (question?: string) => void; openVoice: () => void }>({ openAsk: () => {}, openVoice: () => {} });
export const useAskDial = () => useContext(AskContext);

const button = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-[1.1em] font-bold disabled:opacity-60";
const secondary = `${button} hairline bg-card`;

/** Ask Dial: one bottom sheet for the whole app. `openAsk(question)` opens it and asks straight away. */
export function AskDialProvider({ children }: { children: React.ReactNode }) {
  const { account, transactions, settings } = useAccount();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestId = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const inputId = useId();

  const [answer, setAnswer] = useState<Answer>({ status: "idle" });
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [input, setInput] = useState("");
  const [voice, setVoice] = useState<{ Rec: ReturnType<typeof getRecognition>; speak: boolean }>({ Rec: null, speak: false });
  const [listening, setListening] = useState(false);
  const [voiceMessage, setVoiceMessage] = useState("");
  const [speaking, setSpeaking] = useState(false);

  // Feature-detect after mount so server and first client render agree.
  useEffect(() => setVoice({ Rec: getRecognition(window), speak: canSpeak(window) }), []);

  const stopSpeaking = useCallback(() => {
    if (canSpeak(window)) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q) {
        setAnswer({ status: "invalid", question: "", message: "Please type a question first." });
        return;
      }
      stopSpeaking();
      const id = ++requestId.current;
      setAnswer({ status: "loading", question: q });
      const outcome = await askDial(q);
      if (id !== requestId.current) return; // a newer question replaced this one
      if (outcome.kind === "answer") {
        const { answer: text, evidenceIds, source } = outcome.response;
        setAnswer({ status: "answered", question: q, text, evidenceIds, source });
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
    [account, transactions, settings, stopSpeaking],
  );

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
    recognition.current?.stop();
    returnFocus.current?.focus?.();
  }

  function startListening() {
    if (!voice.Rec) return;
    stopSpeaking();
    setVoiceMessage("");
    const r = new voice.Rec();
    r.lang = "en-GB";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const text = e.results[0]?.[0]?.transcript ?? "";
      setInput(text);
      void ask(text);
    };
    r.onerror = (e) => setVoiceMessage(voiceErrorMessage(e.error));
    r.onend = () => setListening(false);
    recognition.current = r;
    setListening(true);
    r.start();
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
          <div className="flex items-center justify-between gap-(--space)">
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
            {spoken && voice.speak && (
              <button type="button" onClick={() => readAloud(spoken)} className={`${secondary} self-start`} aria-pressed={speaking}>
                {speaking ? <Square aria-hidden className="size-[1em]" /> : <Volume2 aria-hidden className="size-[1em]" />}
                {speaking ? "Stop reading" : "Read aloud"}
              </button>
            )}
            {(answer.status === "answered" || answer.status === "offline") && <EvidenceList ids={answer.evidenceIds} onNavigate={close} />}
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
              {voice.Rec && (
                <button
                  type="button"
                  onClick={listening ? () => recognition.current?.stop() : startListening}
                  aria-pressed={listening}
                  className={secondary}
                >
                  {listening ? <Square aria-hidden className="size-[1em]" /> : <Mic aria-hidden className="size-[1em]" />}
                  {listening ? "Stop listening" : "Speak"}
                </button>
              )}
              <button type="submit" disabled={answer.status === "loading"} className={`${button} border-primary bg-primary text-primary-foreground`}>
                Ask
              </button>
            </div>
            <p role="status" className="text-sm empty:hidden">
              {listening ? "Listening..." : voiceMessage}
            </p>
          </form>
        </div>
      </dialog>
    </AskContext.Provider>
  );
}
