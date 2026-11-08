"use client";

import { ChevronDown, ChevronUp, Keyboard, Mic, Pencil, Square, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { spokenText } from "@/lib/dial/runner";
import { usePreferences } from "@/lib/preferences/provider";
import type { Utterance } from "@/lib/voice/types";
import { DialReply } from "../dial/dial-reply";
import { useDialSession } from "../dial/session";
import { useDialVoice } from "../dial/use-dial-voice";
import { useSpeaker } from "../dial/use-speaker";
import { VoiceConsent } from "../dial/voice-consent";
import { DialMark } from "../wordmark";

const btn = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-5 font-bold";

const SUGGESTIONS = ["Take me to my spending", "Where does most of my money go?", "Make everything bigger", "What if I spend £100 less next month?"];

const STATUS: Record<string, string> = {
  idle: "Ready",
  "requesting-permission": "Waiting for microphone permission",
  listening: "Listening",
  transcribing: "Listening",
  processing: "Thinking",
  responding: "Speaking",
  interrupted: "Stopped",
  failed: "Voice input stopped",
};

/**
 * Full-screen Dial Voice Mode. Listens only after a tap; never in the background.
 * speech -> shared voice engine -> the same Dial session as typed text -> reply shown and read aloud.
 * The person can talk over Dial to interrupt it, say "stop", or edit what was heard before it's sent again.
 */
export function VoiceMode({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const session = useDialSession();
  const { prefs } = usePreferences();
  const speaker = useSpeaker();
  const [docked, setDocked] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [heard, setHeard] = useState("");

  // Engine callbacks run outside React's render; refs keep them pointing at the latest functions.
  const handleRef = useRef<(text: string, replaces?: string) => void>(() => {});
  const mic = useDialVoice({
    onUtterance: (u: Utterance) => handleRef.current(u.text, u.replaces),
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
    async (text: string, replaces?: string) => {
      const t = text.trim();
      if (!t) return;
      speaker.cancel();
      mic.setSpeaking(null);
      setHeard(t);
      mic.setProcessing(true);
      const done = await session.submit(t, { replaces });
      mic.setProcessing(false);
      if (done) reply(spokenText(done.items));
    },
    [session, speaker, mic, reply],
  );
  handleRef.current = handle;

  // While Voice Mode is open it decides what happens around navigation, exit and stop.
  useEffect(() => {
    if (!open) return;
    session.setSurface({
      onNavigated: () => setDocked(true),
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
      // Not showModal(): the page behind must stay visible and usable while Dial listens.
      d.show();
      setDocked(false);
      setHeard("");
      titleRef.current?.focus();
    } else if (!open && d.open) d.close();
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

  const hold = prefs.listenMode === "hold" && mic.speechInput !== "unset";
  const begin = () => {
    speaker.cancel();
    mic.setSpeaking(null);
    mic.start();
  };
  const listening = mic.state === "listening" || mic.state === "transcribing" || mic.state === "requesting-permission";
  const live = mic.snapshot && listening ? mic.snapshot : null;
  const turn = session.turn;
  const status = session.offer && listening ? "Listening for your answer" : speaker.speaking ? "Speaking" : turn?.status === "working" ? "Thinking" : STATUS[mic.state] ?? "Ready";
  const wave = listening ? "listening" : speaker.speaking ? "speaking" : "idle";

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
      <div className="flex max-h-[inherit] w-full flex-col gap-3 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${inputId}-t`} ref={titleRef} tabIndex={-1} className="flex items-center gap-2 text-lg font-bold focus:outline-none">
            <DialMark tone="onDark" className="size-[1.5em]" />
            Dial Voice
          </h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDocked((x) => !x)} className={`${btn} border border-[#aab4c8] px-3`} aria-label={docked ? "Make the panel bigger" : "Make the panel smaller"}>
              {docked ? <ChevronUp aria-hidden className="size-[1.1em]" /> : <ChevronDown aria-hidden className="size-[1.1em]" />}
            </button>
            <button type="button" onClick={() => ref.current?.close()} className={`${btn} border border-[#aab4c8]`}>
              <X aria-hidden className="size-[1.1em]" />
              Exit voice
            </button>
          </div>
        </div>

        <div role="status" className="flex flex-col items-center gap-2">
          {!docked && (
            <div aria-hidden className="wave flex h-16 items-center gap-1.5" data-state={wave}>
              {[14, 28, 46, 62, 40, 56, 30, 50, 60, 28, 16].map((h, i) => (
                <span key={i} className="block w-1.5 rounded-full" style={{ height: wave === "idle" ? 8 : h, background: i === 5 ? "#a9ddf2" : i % 4 === 0 ? "#4f8db8" : "#6cc4e8" }} />
              ))}
            </div>
          )}
          <p className="flex items-center gap-2 font-bold">
            {listening && <span aria-hidden className="size-2.5 rounded-full bg-[#ff6b5e]" />}
            {status}
            {mic.backend !== "none" && listening && <span className="text-sm font-normal text-[#aab4c8]">({mic.backend === "on-device" ? "on this device" : "browser speech service"})</span>}
          </p>
        </div>

        {/* Live transcript: interim words are shown lighter and never sent on their own. */}
        {live ? (
          <p className={`text-center font-semibold leading-snug ${docked ? "text-lg" : "text-xl"}`} aria-live="off">
            {live.finalText}
            {live.interimText && <span className="text-[#aab4c8]"> {live.interimText}</span>}
            {!live.text && <span className="text-[#aab4c8]">Go ahead, I&apos;m listening.</span>}
          </p>
        ) : (
          heard && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <p className={`text-center font-semibold leading-snug ${docked ? "text-lg" : "text-xl"}`}>&ldquo;{heard}&rdquo;</p>
              <button
                type="button"
                onClick={() => {
                  setTyping(true);
                  setTyped(heard);
                }}
                className={`${btn} min-h-0 border border-[#aab4c8] px-3 py-1 text-sm`}
              >
                <Pencil aria-hidden className="size-[1em]" />
                Edit
              </button>
            </div>
          )
        )}

        {mic.consent && <VoiceConsent tone="voice" onChoose={mic.consent.choose} onDismiss={mic.consent.dismiss} />}

        <section aria-live="polite" aria-busy={turn?.status === "working"} className="flex flex-col gap-3 rounded-2xl bg-[#1c2640] p-(--space)">
          <h3 className="text-sm font-bold text-[#9dd8f0]">{session.offer ? "Dial suggests" : "Dial"}</h3>
          {turn ? (
            <DialReply turn={turn} tone="voice" offer={session.offer} onDecide={(yes, o) => reply(session.decide(yes, o))} onFollowUp={(q) => void handle(q)} onNavigate={() => setDocked(true)} />
          ) : (
            <p className="text-lg leading-snug">Hello. Tap the microphone and tell me what you need, or type it below. You can ask about your money, move around the app or change how it looks.</p>
          )}
        </section>

        {!docked && !session.offer && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold text-[#aab4c8]">You could say</p>
            <ul className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => void handle(s)} className={`${btn} bg-[#1c2640] font-semibold`}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {mic.error && (
          <p role="alert" className="rounded-xl bg-[#3a1f2a] p-3 text-[#ffb4ad]">
            {mic.error.message}
          </p>
        )}

        {(typing || !mic.supported) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handle(typed);
              setTyped("");
            }}
            className="flex gap-2"
          >
            <label htmlFor={inputId} className="sr-only">
              Type to Dial
            </label>
            <input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={300}
              autoComplete="off"
              placeholder="Type what you need"
              className="min-h-(--target-min) min-w-0 flex-1 rounded-full border border-[#8592ab] bg-[#1c2640] px-5 text-[#f5f5f2] placeholder:text-[#aab4c8]"
            />
            <button type="submit" className={`${btn} bg-[#6cc4e8] text-[#0e1626]`}>
              Send
            </button>
          </form>
        )}

        <div className="sticky bottom-0 -mx-4 mt-auto flex flex-col gap-3 bg-[#0e1626] px-4 pb-1 pt-2 shadow-[0_-8px_12px_-8px_#0e1626]">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setTyping((t) => !t)} aria-pressed={typing} className={`${btn} border border-[#aab4c8] px-4`}>
              <Keyboard aria-hidden className="size-[1.1em]" />
              <span className="max-[359px]:sr-only">Type</span>
            </button>
            {mic.supported ? (
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
                className="flex size-20 items-center justify-center rounded-full border-4 border-[#6cc4e8] bg-[#f5f5f2] text-[#004977]"
              >
                {listening ? <Square aria-hidden className="size-7 fill-[#d03027] text-[#d03027]" /> : <Mic aria-hidden className="size-8" />}
              </button>
            ) : (
              <p className="text-center text-sm text-[#aab4c8]">Voice input isn&apos;t available in this browser. You can type instead.</p>
            )}
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
                className={`${btn} border border-[#aab4c8] px-4`}
              >
                {speaker.speaking ? <Square aria-hidden className="size-[1.1em]" /> : voiceOn ? <Volume2 aria-hidden className="size-[1.1em]" /> : <VolumeX aria-hidden className="size-[1.1em]" />}
                <span className="max-[359px]:sr-only">{speaker.speaking ? "Stop speaking" : voiceOn ? "Mute replies" : "Replies muted"}</span>
              </button>
            )}
          </div>
          {!docked && (
            <p className="text-center text-sm text-[#aab4c8]">
              Dial only listens after you tap the microphone, and never records audio. You can talk over Dial or say stop at any time. Interface changes stay on this device.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
