"use client";

import { ChevronDown, ChevronUp, Mic, Pencil, Send, Square, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { spokenText } from "@/lib/dial/runner";
import { usePreferences } from "@/lib/preferences/provider";
import type { Utterance } from "@/lib/voice/types";
import { DialReply } from "../dial/dial-reply";
import { useDialSession } from "../dial/session";
import { useDialVoice } from "../dial/use-dial-voice";
import { useSpeaker } from "../dial/use-speaker";
import { VoiceConsent } from "../dial/voice-consent";
import { VoiceDiagnostics } from "../dial/voice-diagnostics";
import { DialMark } from "../wordmark";

const btn = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-4 font-bold";
const outline = `${btn} border border-[#5a6782] hover:bg-white/5`;

const SUGGESTIONS = ["Take me to my spending", "Where does most of my money go?", "Make everything bigger", "When is my bill due?", "What if I spend £100 less next month?"];

const STATUS: Record<string, string> = {
  "requesting-permission": "Allow the microphone in your browser",
  listening: "Listening",
  transcribing: "Listening",
  interrupted: "Stopped",
};

type AiStatus = "checking" | "on" | "off";

/**
 * Dial: one panel for typing and talking. It is a non-modal dialog, so the page behind stays visible and usable.
 * Typed text and speech go through the same Dial session (rules first, Groq when needed, the same validation).
 * Replies are read aloud only when the question was spoken. Listening starts only from the microphone button.
 */
export function VoiceMode({ open, onClose, request }: { open: boolean; onClose: () => void; request: { text: string; id: number } | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const session = useDialSession();
  const { prefs } = usePreferences();
  const speaker = useSpeaker();
  const [docked, setDocked] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [typed, setTyped] = useState("");
  const [heard, setHeard] = useState<{ text: string; spoken: boolean } | null>(null);
  const [ai, setAi] = useState<AiStatus>("checking");

  // Engine callbacks run outside React's render; refs keep them pointing at the latest functions.
  const handleRef = useRef<(text: string, replaces?: string, spoken?: boolean) => void>(() => {});
  const mic = useDialVoice({
    onUtterance: (u: Utterance) => handleRef.current(u.text, u.replaces, true),
    onInterrupt: (reason) => {
      speaker.cancel();
      mic.setSpeaking(null);
      if (reason === "stop-word" || reason === "backgrounded") session.cancel();
    },
  });

  const reply = useCallback(
    (text: string) => {
      if (!voiceOn || !speaker.supported || !text) return;
      mic.setSpeaking(text);
      speaker.speak(text, () => mic.setSpeaking(null));
    },
    [voiceOn, speaker, mic],
  );

  const handle = useCallback(
    async (text: string, replaces?: string, spoken = false) => {
      const t = text.trim();
      if (!t) return;
      speaker.cancel();
      mic.setSpeaking(null);
      setHeard({ text: t, spoken });
      mic.setProcessing(true);
      const done = await session.submit(t, { replaces });
      mic.setProcessing(false);
      // A spoken question gets a spoken answer; a typed one is only shown.
      if (done && spoken) reply(spokenText(done.items));
    },
    [session, speaker, mic, reply],
  );
  handleRef.current = handle;

  // While the panel is open it decides what happens around navigation, exit and stop.
  useEffect(() => {
    if (!open) return;
    session.setSurface({
      // On phones the panel covers the page, so it gets smaller to show where Dial went. On desktop it sits beside it.
      onNavigated: () => window.innerWidth < 1024 && setDocked(true),
      onExit: () => ref.current?.close(),
      onStop: () => {
        speaker.cancel();
        mic.setSpeaking(null);
        mic.stop();
      },
    });
    return () => session.setSurface(null);
  }, [open, session, speaker, mic]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      // Not showModal(): the page behind must stay visible and usable while Dial is open.
      d.show();
      setDocked(false);
      inputRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  // A question asked from elsewhere in the app (a button on Home, a suggestion) is answered here.
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!open || !request || request.id === lastRequest.current) return;
    lastRequest.current = request.id;
    void handle(request.text);
  }, [open, request, handle]);

  // Whether Groq is set up on the server, shown in the header. Never shows the key.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch("/api/ask", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: { groq?: string }) => live && setAi(s.groq === "configured" ? "on" : "off"))
      .catch(() => live && setAi("off"));
    return () => {
      live = false;
    };
  }, [open]);

  // Tell the page how tall the panel is, so its last content can scroll clear of it.
  useEffect(() => {
    const d = ref.current;
    if (!open || !d) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--voice-h", `${Math.ceil(d.getBoundingClientRect().height)}px`);
    root.dataset.voiceOpen = "true";
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(d);
    return () => {
      ro.disconnect();
      delete root.dataset.voiceOpen;
      root.style.removeProperty("--voice-h");
    };
  }, [open]);

  // Closing with a preview showing withdraws it: nothing changes silently.
  function handleClosed() {
    mic.cancel();
    speaker.cancel();
    if (session.offer) session.decide(false);
    onClose();
    returnFocus.current?.focus?.();
  }

  const hold = prefs.listenMode === "hold" && mic.speechInput !== "unset" && mic.speechInput !== "typing";
  const begin = () => {
    speaker.cancel();
    mic.setSpeaking(null);
    mic.start();
  };
  const listening = mic.state === "listening" || mic.state === "transcribing" || mic.state === "requesting-permission";
  const live = mic.snapshot && listening ? mic.snapshot : null;
  const turn = session.turn;
  const status = listening
    ? session.offer
      ? "Listening for your answer"
      : STATUS[mic.state]
    : speaker.speaking
      ? "Speaking"
      : turn?.status === "working"
        ? "Thinking"
        : null;

  return (
    <dialog
      ref={ref}
      className="voice-mode"
      data-docked={docked}
      aria-labelledby={`${inputId}-t`}
      onClose={handleClosed}
      onKeyDown={(e) => {
        // Non-modal dialogs don't close on Escape by themselves.
        if (e.key === "Escape") {
          e.stopPropagation();
          ref.current?.close();
        }
      }}
    >
      <div className="flex max-h-[inherit] w-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
          <h2 id={`${inputId}-t`} ref={titleRef} tabIndex={-1} className="flex min-w-0 items-center gap-2 text-lg font-bold focus:outline-none">
            <DialMark tone="onDark" className="size-[1.4em] shrink-0" />
            Dial
            <span
              className={`ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ${ai === "on" ? "bg-[#14402a] text-[#86e0a6]" : "bg-[#27314a] text-[#aab4c8]"}`}
              title={ai === "on" ? "Groq is set up on the server" : "GROQ_API_KEY isn't set on the server, so answers come from the account checks only"}
            >
              <span aria-hidden className={`size-1.5 rounded-full ${ai === "on" ? "bg-[#86e0a6]" : "bg-[#aab4c8]"}`} />
              <span className="max-[479px]:sr-only">{ai === "checking" ? "Checking AI" : ai === "on" ? "Groq on" : "Groq off"}</span>
            </span>
          </h2>
          <div className="flex shrink-0 gap-1.5">
            <button type="button" onClick={() => setDocked((x) => !x)} className={`${outline} px-3`} aria-label={docked ? "Make the panel bigger" : "Make the panel smaller"}>
              {docked ? <ChevronUp aria-hidden className="size-[1.1em]" /> : <ChevronDown aria-hidden className="size-[1.1em]" />}
            </button>
            <button type="button" onClick={() => ref.current?.close()} className={`${outline} px-3`} aria-label="Close Dial">
              <X aria-hidden className="size-[1.1em]" />
            </button>
          </div>
        </div>

        {/* Conversation */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3">
          {status && (
            <p role="status" className="flex items-center gap-2 text-sm font-bold text-[#9dd8f0]">
              {listening && <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-[#ff6b5e]" />}
              {status}
              {listening && mic.backend !== "none" && <span className="font-normal text-[#aab4c8]">({mic.backend === "on-device" ? "on this device" : "browser speech service"})</span>}
            </p>
          )}

          {/* Live transcript: interim words are shown lighter and never sent on their own. */}
          {live ? (
            <p className="self-end rounded-2xl rounded-br-md bg-[#004977] px-4 py-2 text-lg font-semibold leading-snug" aria-live="off">
              {live.finalText}
              {live.interimText && <span className="text-[#cfe0f0]"> {live.interimText}</span>}
              {!live.text && <span className="text-[#cfe0f0]">Go ahead, I&apos;m listening.</span>}
            </p>
          ) : (
            heard && (
              <div className="flex items-center justify-end gap-2 self-end">
                <button
                  type="button"
                  onClick={() => {
                    setTyped(heard.text);
                    inputRef.current?.focus();
                  }}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-sm text-[#aab4c8] hover:bg-white/5"
                  aria-label={`Edit: ${heard.text}`}
                >
                  <Pencil aria-hidden className="size-[0.9em]" />
                  Edit
                </button>
                <p className="rounded-2xl rounded-br-md bg-[#004977] px-4 py-2 text-lg font-semibold leading-snug">{heard.text}</p>
              </div>
            )
          )}

          {mic.consent && <VoiceConsent tone="voice" notice={mic.consent.notice} onChoose={mic.consent.choose} onDismiss={mic.consent.dismiss} />}

          <section aria-live="polite" aria-busy={turn?.status === "working"} className="flex flex-col gap-3 rounded-2xl rounded-bl-md bg-[#1c2640] p-4">
            <h3 className="text-sm font-bold text-[#9dd8f0]">{session.offer ? "Dial suggests" : "Dial"}</h3>
            {turn ? (
              <DialReply turn={turn} tone="voice" offer={session.offer} onDecide={(yes, o) => { const said = session.decide(yes, o); if (heard?.spoken) reply(said); }} onFollowUp={(q) => void handle(q)} onNavigate={() => window.innerWidth < 1024 && setDocked(true)} />
            ) : (
              <p className="text-lg leading-snug">Hi. Type or tap the microphone. You can ask about your money, go anywhere in the app, or change how it looks.</p>
            )}
          </section>

          {!turn && !docked && (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-bold text-[#aab4c8]">Try</p>
              <ul className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button type="button" onClick={() => void handle(s)} className={`${btn} min-h-10 border border-[#3a4766] bg-[#1c2640] text-sm font-semibold hover:bg-[#27314a]`}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mic.error && !mic.consent && (
            <p role="alert" className="rounded-xl bg-[#3a1f2a] p-3 text-[#ffb4ad]">
              {mic.error.message}
            </p>
          )}
          {mic.supported && <VoiceDiagnostics tone="voice" open={!!mic.error} state={mic.state} backend={mic.backend} error={mic.error} speechInput={mic.speechInput} />}
        </div>

        {/* Composer: always visible, type or talk */}
        <div className="flex flex-col gap-2 border-t border-white/10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handle(typed);
              setTyped("");
            }}
            className="flex items-center gap-2"
          >
            <label htmlFor={inputId} className="sr-only">
              Type to Dial
            </label>
            <input
              id={inputId}
              ref={inputRef}
              value={listening && live ? live.text : typed}
              onChange={(e) => setTyped(e.target.value)}
              readOnly={listening}
              maxLength={300}
              autoComplete="off"
              placeholder={listening ? "Listening..." : "Ask or tell Dial anything"}
              className="min-h-(--target-min) min-w-0 flex-1 rounded-full border border-[#5a6782] bg-[#1c2640] px-4 text-[#f5f5f2] placeholder:text-[#aab4c8] focus:border-[#6cc4e8] focus:outline-none"
            />
            {mic.supported && (
              <button
                type="button"
                {...(hold
                  ? {
                      // Push to talk: listen while pressed (pointer or Space/Enter held), send on release.
                      onPointerDown: begin,
                      onPointerUp: mic.stop,
                      onPointerCancel: mic.cancel,
                      onKeyDown: (e: React.KeyboardEvent) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), begin()),
                      onKeyUp: (e: React.KeyboardEvent) => (e.key === " " || e.key === "Enter") && mic.stop(),
                    }
                  : { onClick: listening ? mic.stop : begin })}
                aria-label={hold ? "Hold to talk" : listening ? "Stop listening" : "Start listening"}
                aria-pressed={listening}
                className={`flex size-(--target-min) shrink-0 items-center justify-center rounded-full ${listening ? "bg-[#d03027] text-white" : "bg-[#f5f5f2] text-[#004977]"}`}
              >
                {listening ? <Square aria-hidden className="size-[1.1em] fill-current" /> : <Mic aria-hidden className="size-[1.25em]" />}
              </button>
            )}
            <button type="submit" aria-label="Send" disabled={!typed.trim() || listening} className="flex size-(--target-min) shrink-0 items-center justify-center rounded-full bg-[#6cc4e8] text-[#0e1626] disabled:opacity-40">
              <Send aria-hidden className="size-[1.1em]" />
            </button>
          </form>
          <div className="flex items-center justify-between gap-2 text-xs text-[#aab4c8]">
            <p>
              {mic.supported
                ? mic.speechInput === "on-device"
                  ? "Speech is turned into text on this device. Dial never records audio."
                  : "Speech is turned into text by your browser's speech service (Google in Chrome). Dial never records audio."
                : "Voice input isn't available in this browser. Typing works."}
            </p>
            {speaker.supported && (
              <button
                type="button"
                onClick={() => {
                  if (speaker.speaking) {
                    speaker.cancel();
                    return mic.setSpeaking(null);
                  }
                  setVoiceOn((v) => !v);
                }}
                aria-pressed={speaker.speaking ? undefined : !voiceOn}
                className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-bold hover:bg-white/5"
              >
                {speaker.speaking ? <Square aria-hidden className="size-[1.1em]" /> : voiceOn ? <Volume2 aria-hidden className="size-[1.1em]" /> : <VolumeX aria-hidden className="size-[1.1em]" />}
                {speaker.speaking ? "Stop speaking" : voiceOn ? "Replies spoken" : "Replies muted"}
              </button>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
