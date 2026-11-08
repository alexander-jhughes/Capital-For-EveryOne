"use client";

import { Check, ChevronDown, ChevronUp, Keyboard, Mic, Pencil, RotateCcw, Save, Square, Undo2, Volume2, VolumeX, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { askDial, evidenceHref, intentForQuestion, knownEvidence, offlineFacts } from "@/lib/assistant/client";
import { canSpeak, pickVoice } from "@/lib/assistant/speech";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { formatLongDate, formatPence } from "@/lib/format";
import { usePreferences } from "@/lib/preferences/provider";
import { describeActions, dialStyle, type UiAction } from "@/lib/preferences/schema";
import { paymentReply } from "@/lib/payments/dial";
import { spendPauseReply } from "@/lib/spend-pause/dial";
import { liveState } from "@/lib/assistant/live-state";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import { interpret, type Route } from "@/lib/voice/interpret";
import type { Utterance, VoiceEngineEvents, VoiceState } from "@/lib/voice/types";
import { needsSpeechChoice, useMicButton, useVoice } from "@/lib/voice/use-voice";
import type { ExperienceTemplate } from "@/lib/assistant/experience";
import { ExperienceCard } from "../experience/templates";
import { DialMark } from "../wordmark";
import { SPEECH_INPUT_LABELS, SpeechConsent, type SpeechChoice } from "./speech-consent";

type Offer = { kind: "ui"; actions: UiAction[] } | { kind: "mode"; to: Mode; from: Mode } | null;
interface Reply {
  text: string;
  evidence?: string[];
  /** Backend-chosen financial card (validated); "general" shows none. */
  template?: ExperienceTemplate;
}

const PAGE_NAMES: Record<Route, string> = {
  "/account": "your home screen",
  "/account/spending": "your spending",
  "/account/pay": "payments",
  "/account/spend-pause": "Spend Pause",
  "/account/settings": "display and voice settings",
};

const HELP =
  "You can ask about your money, like how much do I owe. You can change how the app looks, like make everything bigger, use more contrast, or put my bill at the top. You can also say take me to spending, undo, or stop.";

const btn = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-5 font-bold";

/** What the person sees and hears, one at a time. Announced politely; interim words are not. */
const STATUS: Record<VoiceState, string> = {
  idle: "Ready",
  "requesting-permission": "Waiting for the microphone. If your browser asks, choose Allow.",
  listening: "Listening",
  transcribing: "Hearing you",
  processing: "Thinking",
  responding: "Speaking",
  interrupted: "Interrupted",
  failed: "Stopped listening",
};

/**
 * Full-screen Dial Voice Mode. Listens only after a tap (or while held, or continuously if the person chose that);
 * never in the background. Speech and typing share one pipeline:
 * interpret (local) -> preview -> confirm -> apply, or a money question -> /api/ask.
 */
export function VoiceMode({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLDivElement>(null);
  /** The person's last question (as the backend understood it), sent as previousQuestion to resolve follow-ups. */
  const lastQuestion = useRef<string | undefined>(undefined);
  /** Each request takes a turn; an answer for an older turn is never shown. */
  const turn = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const lastUtterance = useRef(0);
  const speech = useRef<SpeechSynthesisUtterance | null>(null);
  const router = useRouter();
  const inputId = useId();
  const { account, transactions, settings, payments, spendPauseActivity } = useAccount();
  const { mode, setMode } = useMode();
  const prefsApi = usePreferences();
  const { prefs, startPreview, acceptPreview, rejectPreview, undo, save, resetToDefault, canUndo } = prefsApi;

  const [canTalk, setCanTalk] = useState(false);
  const [speaking, setSpeakingNow] = useState(false);
  const [heard, setHeard] = useState("");
  /** A spoken question on its way to Dial, with Edit and Cancel. */
  const [sending, setSending] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [retry, setRetry] = useState<{ text: string; replaces?: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [reply, setReply] = useState<Reply>({ text: "Hello. Tap the microphone and tell me what you need, or type it below." });
  const [offer, setOffer] = useState<Offer>(null);
  const [docked, setDocked] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState("");

  const listenMode = prefs.listenMode;
  const voice = useVoice({ speechInput: prefs.speechInput, onUtterance: (u) => onUtterance(u), onInterrupt: (r) => onInterrupt(r) });
  const { setSpeaking, setProcessing, cancel: cancelListening } = voice;

  useEffect(() => setCanTalk(canSpeak(window)), []);

  const stopSpeaking = useCallback(() => {
    speech.current = null;
    if (canSpeak(window)) window.speechSynthesis.cancel();
    setSpeakingNow(false);
    setSpeaking(null);
  }, [setSpeaking]);

  const say = useCallback(
    (r: Reply) => {
      setReply(r);
      setProcessing(false);
      if (!voiceOn || !canSpeak(window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(r.text);
      u.lang = "en-GB";
      const v = pickVoice(window.speechSynthesis.getVoices());
      if (v) u.voice = v;
      // cancel() ends the previous utterance too; only the current one may clear "speaking".
      const done = () => {
        if (speech.current !== u) return;
        speech.current = null;
        setSpeakingNow(false);
        setSpeaking(null);
      };
      u.onend = done;
      u.onerror = done;
      speech.current = u;
      setSpeakingNow(true);
      setSpeaking(r.text); // for the echo filter: Dial's own words are not the person talking
      window.speechSynthesis.speak(u);
    },
    [voiceOn, setProcessing, setSpeaking],
  );

  /** Cancels whatever Dial was still working on; its answer, if it still arrives, is ignored. */
  const abandon = useCallback(() => {
    turn.current++;
    inFlight.current?.abort();
    inFlight.current = null;
    setSending(null);
    setProcessing(false);
  }, [setProcessing]);

  // Open and close the native modal dialog. Closing with a preview pending discards it: nothing changes silently.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      d.showModal();
      setDocked(false);
      setOffer(null);
      setHeard("");
      setNotice("");
      setSending(null);
      setRetry(null);
      setChoosing(false);
    } else if (!open && d.open) d.close();
  }, [open]);

  function handleClosed() {
    cancelListening();
    abandon();
    stopSpeaking();
    setChoosing(false);
    if (offer?.kind === "ui") rejectPreview();
    if (offer?.kind === "mode") setMode(offer.from);
    setOffer(null);
    onClose();
    returnFocus.current?.focus?.();
  }

  const decide = useCallback(
    (yes: boolean) => {
      if (!offer) return say({ text: "There's nothing waiting for an answer. What would you like to do?" });
      // Accepting a reset also clears saved settings, as Dial said it would.
      if (offer.kind === "ui" && yes && offer.actions.some((a) => a.type === "reset")) resetToDefault();
      else if (offer.kind === "ui") (yes ? acceptPreview : rejectPreview)();
      if (offer.kind === "mode" && !yes) setMode(offer.from);
      setOffer(null);
      say({
        text: yes
          ? "Done. Say save it to keep this for next time, or undo to change it back."
          : "Okay, I've left it as it was.",
      });
    },
    [offer, acceptPreview, rejectPreview, resetToDefault, setMode, say],
  );

  const handle = useCallback(
    async (utterance: string, replaces?: string) => {
      const text = utterance.trim();
      if (!text) return;
      // A newer request always wins: anything still in flight is cancelled and its answer ignored.
      abandon();
      const mine = turn.current;
      setHeard(text);
      setRetry(null);
      const r = interpret(text, { textSize: prefs.textSize });

      if (r.kind === "control" && (r.command === "yes" || r.command === "no")) return decide(r.command === "yes");
      // A new request replaces a pending preview rather than stacking on it.
      if (offer?.kind === "ui") rejectPreview();
      if (offer?.kind === "mode") setMode(offer.from);
      setOffer(null);

      // Spend Pause is answered from live state. A change is only offered: the person confirms it on the Spend Pause page.
      // Payments are answered the same way.
      const asked = r.kind === "question" || r.kind === "unknown";
      const local = asked ? (spendPauseReply(text, settings, spendPauseActivity)?.text ?? paymentReply(text, { account, transactions, payments })) : null;
      if (local) return say({ text: local });

      switch (r.kind) {
        case "ui":
          startPreview(r.actions, { source: "voice" });
          setOffer({ kind: "ui", actions: r.actions });
          setDocked(true);
          return say({ text: `Here's a preview. I can ${describeActions(r.actions)}. Do you want to keep it?` });
        case "mode":
          if (r.mode === mode) return say({ text: `You're already in ${mode === "simple" ? "Simple" : "Detailed"} view.` });
          setOffer({ kind: "mode", to: r.mode, from: mode });
          setMode(r.mode);
          setDocked(true);
          return say({
            text: `This is ${r.mode === "simple" ? "Simple view, which shows less on each screen" : "Detailed view, which shows more on each screen"}. Your text size and colours stay as they are. Keep it?`,
          });
        case "navigate":
          setDocked(true);
          if (r.to === "back") {
            router.back();
            return say({ text: "Gone back." });
          }
          router.push(r.to);
          return say({ text: `Here's ${PAGE_NAMES[r.to]}.` });
        case "control":
          switch (r.command) {
            case "stop":
              cancelListening();
              return stopSpeaking();
            case "undo":
              if (!canUndo) return say({ text: "There's nothing to undo." });
              undo();
              return say({ text: "Undone." });
            case "reset":
              startPreview([{ type: "reset" }]);
              setOffer({ kind: "ui", actions: [{ type: "reset" }] });
              setDocked(true);
              return say({ text: "Here's the original look. Do you want to keep it? Your saved settings will be cleared." });
            case "save":
              save();
              return say({ text: "Saved. It will look like this next time you open the app." });
            case "exit":
              return ref.current?.close();
            case "help":
              return say({ text: HELP });
            case "readBalance":
              return say({
                text: `${account.statementBalance === 0 ? "Your bill is paid." : `Your bill is ${formatPence(account.statementBalance)}, due on ${formatLongDate(account.paymentDueDate)}.`} You owe ${formatPence(account.currentBalance)} in total.`,
              });
            case "readPage": {
              const main = document.querySelector("main")?.innerText.replace(/\s+/g, " ").trim() ?? "";
              return say({ text: main.slice(0, 1200) || "There's nothing to read on this screen." });
            }
          }
          return;
        case "question": {
          const controller = new AbortController();
          inFlight.current = controller;
          setProcessing(true);
          setSending(text);
          setReply({ text: "Checking your account..." });
          const outcome = await askDial(text, {
            state: liveState(transactions, settings),
            // A self-correction ("Actually, groceries") is resolved against the words it replaced.
            previousQuestion: replaces ?? lastQuestion.current,
            style: dialStyle(prefs),
            signal: controller.signal,
          });
          if (mine !== turn.current || outcome.kind === "cancelled") return; // replaced, interrupted or cancelled
          inFlight.current = null;
          setSending(null);
          lastQuestion.current = (outcome.kind === "answer" && outcome.resolvedQuestion) || text;
          if (outcome.kind === "answer") return say({ text: outcome.response.answer, evidence: outcome.response.evidenceIds, template: outcome.experience.template });
          if (outcome.kind === "invalid") return say({ text: outcome.message });
          setRetry({ text, replaces });
          const intent = intentForQuestion(text);
          if (intent) {
            const off = offlineFacts(intent, { account, txns: transactions, settings, today: DEMO_TODAY, now: DEMO_NOW });
            return say({ text: off.facts.map((f) => `${f.label}: ${f.value}.`).join(" "), evidence: off.evidenceIds });
          }
          return say({ text: "I can't answer money questions right now because the assistant is offline. You can still change how the app looks, or try a suggested question." });
        }
        case "unknown":
          return say({ text: "Sorry, I didn't catch that. You could say: make everything bigger, put my bill at the top, or how much do I owe?" });
      }
    },
    [prefs, offer, decide, rejectPreview, setMode, startPreview, say, mode, router, stopSpeaking, cancelListening, abandon, setProcessing, canUndo, undo, save, account, transactions, settings, payments, spendPauseActivity],
  );

  // The engine delivers each utterance once; the id check makes a duplicate harmless anyway.
  function onUtterance(u: Utterance) {
    if (u.utteranceId <= lastUtterance.current) return;
    lastUtterance.current = u.utteranceId;
    setNotice("");
    setAnnounce(`You said: ${u.text}`);
    void handle(u.text, u.replaces);
  }

  // Barge-in: the person spoke over Dial, or said stop. Dial goes quiet, drops what it was doing, keeps listening.
  const onInterrupt: NonNullable<VoiceEngineEvents["onInterrupt"]> = (reason) => {
    stopSpeaking();
    if (reason === "backgrounded") return setNotice("Listening stopped because Dial went into the background. Tap the microphone to carry on.");
    abandon();
    if (reason === "stop-word") setReply({ text: "Okay, I've stopped." });
  };

  useEffect(() => {
    if (voice.error?.code === "not-allowed" || voice.error?.code === "unsupported") setTyping(true);
  }, [voice.error]);

  useEffect(() => {
    if (choosing) consentRef.current?.focus();
  }, [choosing]);

  const listeningNow = voice.listening;
  function startListening() {
    if (speaking) stopSpeaking(); // tapping the microphone while Dial speaks interrupts it
    if (listeningNow) return;
    if (needsSpeechChoice(prefs.speechInput) || voice.backend === "none") return setChoosing(true);
    setNotice("");
    setChoosing(false);
    voice.start(listenMode);
  }
  const mic = useMicButton({ hold: listenMode === "hold", listening: listeningNow && !speaking, onStart: startListening, onStop: voice.stop });

  function chosen(choice: SpeechChoice) {
    setChoosing(false);
    if (choice === "typing") return setTyping(true);
    if (listenMode === "hold") return setReply({ text: "Hold the microphone, or the Space bar, while you talk." });
    if (choice === prefs.speechInput) voice.start(listenMode);
    else voice.startWhenReady(listenMode); // the engine for the new choice is made on the next render
  }

  function editSending() {
    const text = sending ?? "";
    abandon();
    setTyping(true);
    setTyped(text);
    setReply({ text: "Change your question, then press Send." });
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function cancelSending() {
    abandon();
    setReply({ text: "Okay, I didn't send that. What would you like to do?" });
  }

  // Space talks when focus isn't on a text field or another control (those keep their own Space).
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== " " || !voice.recognition || choosing) return;
    if ((e.target as HTMLElement).closest("input, textarea, select, button, a, summary, [contenteditable='true'], [role='button']")) return;
    e.preventDefault();
    if (e.repeat) return;
    if (listenMode === "hold") return mic.press();
    if (listeningNow && !speaking) voice.stop();
    else startListening();
  }
  function onKeyUp(e: React.KeyboardEvent) {
    if (e.key === " " && listenMode === "hold") mic.release();
  }

  const state = voice.state;
  const live = voice.transcript?.text ? voice.transcript : null;
  const interim = live ? (live.text.endsWith(live.interimText) ? live.interimText : live.text) : "";
  const settled = live ? live.text.slice(0, live.text.length - interim.length) : "";
  const problem = voice.error?.message || notice;
  const offerLabel = offer?.kind === "ui" ? describeActions(offer.actions) : offer?.kind === "mode" ? `switch to ${offer.to === "simple" ? "Simple" : "Detailed"} view` : "";
  const status = state === "listening" && offer ? "Listening for your answer" : STATUS[state];
  const waving = state === "listening" || state === "transcribing";
  const evidence = reply.evidence ? knownEvidence(reply.evidence, new Set(transactions.map((t) => t.id))) : [];
  const quote = `text-center font-semibold leading-snug ${docked ? "text-lg" : "text-xl"}`;

  return (
    <dialog ref={ref} tabIndex={-1} className="voice-mode" data-docked={docked} aria-labelledby={`${inputId}-t`} onClose={handleClosed} onKeyDown={onKeyDown} onKeyUp={onKeyUp}>
      <div className={`gutter mx-auto flex h-full w-full max-w-[36rem] flex-col gap-(--space) pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] ${docked ? "max-h-[62dvh] overflow-y-auto" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${inputId}-t`} className="flex items-center gap-2 text-lg font-bold">
            <DialMark tone="onDark" className="size-[1.5em]" />
            Dial Voice
          </h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setDocked((x) => !x)} className={`${btn} border border-[#aab4c8] px-3`} aria-label={docked ? "Expand Voice Mode" : "Show the screen behind"}>
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
            <div aria-hidden className="wave flex h-16 items-center gap-1.5" data-state={waving ? "listening" : state === "responding" ? "speaking" : "idle"}>
              {[14, 28, 46, 62, 40, 56, 30, 50, 60, 28, 16].map((h, i) => (
                <span key={i} className="block w-1.5 rounded-full" style={{ height: waving || state === "responding" ? h : 8, background: i === 5 ? "#a9ddf2" : i % 4 === 0 ? "#4f8db8" : "#6cc4e8" }} />
              ))}
            </div>
          )}
          <p className="flex items-center gap-2 text-center font-bold" data-voice-state={state}>
            {waving && <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-[#ff6b5e]" />}
            {status}
          </p>
        </div>
        <p className="sr-only" aria-live="polite">
          {announce}
        </p>

        {live ? (
          // Interim words show as they arrive (lighter, italic) but are never announced word by word or sent on their own.
          <p className={quote}>
            <span className="sr-only">Hearing: </span>
            {settled}
            <span className="font-normal italic text-[#c9d1df]">{interim}</span>
          </p>
        ) : sending ? (
          <div className="flex flex-col items-center gap-2">
            <p className={quote}>Sending: &ldquo;{sending}&rdquo;</p>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" onClick={editSending} className={`${btn} border border-[#aab4c8]`}>
                <Pencil aria-hidden className="size-[1.1em]" />
                Edit
              </button>
              <button type="button" onClick={cancelSending} className={`${btn} border border-[#aab4c8]`}>
                <X aria-hidden className="size-[1.1em]" />
                Cancel
              </button>
            </div>
          </div>
        ) : (
          heard && <p className={quote}>&ldquo;{heard}&rdquo;</p>
        )}

        {choosing && (
          <div ref={consentRef} tabIndex={-1} className="rounded-2xl bg-[#141d33] p-(--space)">
            <SpeechConsent tone="dark" onDone={chosen} onCancel={() => setChoosing(false)} />
          </div>
        )}

        <section aria-live="polite" className="flex flex-col gap-3 rounded-2xl bg-[#1c2640] p-(--space)">
          <h3 className="text-sm font-bold text-[#9dd8f0]">{offer ? "Dial suggests" : "Dial"}</h3>
          <p className="text-lg leading-snug">{reply.text}</p>
          {offer && (
            <div className="flex flex-col gap-2">
              <p className="sr-only">Proposed change: {offerLabel}.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => decide(true)} className={`${btn} flex-1 bg-[#6cc4e8] text-[#0e1626]`}>
                  <Check aria-hidden className="size-[1.1em]" />
                  Keep it
                </button>
                <button type="button" onClick={() => decide(false)} className={`${btn} flex-1 border border-[#aab4c8]`}>
                  <Undo2 aria-hidden className="size-[1.1em]" />
                  Undo
                </button>
              </div>
              {offer.kind === "ui" && (
                <button
                  type="button"
                  onClick={() => {
                    acceptPreview({ save: true });
                    setOffer(null);
                    say({ text: "Kept and saved. It will look like this next time." });
                  }}
                  className={`${btn} border border-[#aab4c8]`}
                >
                  <Save aria-hidden className="size-[1.1em]" />
                  Keep and save for next time
                </button>
              )}
            </div>
          )}
          {reply.template && reply.template !== "general" && (
            <div className="text-base">
              <ExperienceCard template={reply.template} evidenceIds={reply.evidence ?? []} onNavigate={() => setDocked(true)} />
            </div>
          )}
          {retry && !sending && (
            <button type="button" onClick={() => void handle(retry.text, retry.replaces)} className={`${btn} self-start border border-[#aab4c8]`}>
              <RotateCcw aria-hidden className="size-[1.1em]" />
              Try again
            </button>
          )}
          {evidence.length > 0 && (!reply.template || reply.template === "general") && (
            <Link href={evidenceHref(evidence)} onClick={() => setDocked(true)} className={`${btn} self-start bg-[#27314a] text-[#9dd8f0]`}>
              See the {evidence.length} {evidence.length === 1 ? "transaction" : "transactions"}
            </Link>
          )}
          {!offer && canUndo && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => { undo(); say({ text: "Undone." }); }} className={`${btn} border border-[#aab4c8]`}>
                <Undo2 aria-hidden className="size-[1.1em]" />
                Undo last change
              </button>
              <button type="button" onClick={() => { resetToDefault(); say({ text: "Everything is back to the original look." }); }} className={`${btn} border border-[#aab4c8]`}>
                Reset to default
              </button>
            </div>
          )}
        </section>

        {!docked && !offer && !choosing && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-bold text-[#aab4c8]">You could say</p>
            <ul className="flex flex-wrap gap-2">
              {["Make everything bigger", "Put my bill at the top", "Did I pay Tesco twice?"].map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => void handle(s)} className={`${btn} bg-[#1c2640] font-semibold`}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {problem && (
          <div role="alert" className="flex flex-col gap-2 rounded-xl bg-[#3a1f2a] p-3 text-[#ffb4ad]">
            <p>{problem}</p>
            {voice.error?.recoverable && (
              <button type="button" onClick={startListening} className={`${btn} self-start border border-[#ffb4ad]`}>
                <RotateCcw aria-hidden className="size-[1.1em]" />
                Try again
              </button>
            )}
          </div>
        )}

        {typing && (
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
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              placeholder="Type what you need"
              className="min-h-(--target-min) min-w-0 flex-1 rounded-full border border-[#8592ab] bg-[#1c2640] px-5 text-[#f5f5f2] placeholder:text-[#aab4c8]"
            />
            <button type="submit" className={`${btn} bg-[#6cc4e8] text-[#0e1626]`}>
              Send
            </button>
          </form>
        )}

        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setTyping((t) => !t)} aria-pressed={typing} className={`${btn} border border-[#aab4c8] px-4`}>
              <Keyboard aria-hidden className="size-[1.1em]" />
              <span className="max-[359px]:sr-only">Type</span>
            </button>
            {voice.recognition ? (
              <button
                type="button"
                {...mic.props}
                aria-label={listeningNow && !speaking ? "Stop listening" : listenMode === "hold" ? "Hold to talk" : "Start listening"}
                className={`flex size-20 shrink-0 items-center justify-center rounded-full border-4 border-[#6cc4e8] bg-[#f5f5f2] text-[#004977] ${listenMode === "hold" ? "touch-none select-none" : ""}`}
              >
                {listeningNow && !speaking ? <Square aria-hidden className="size-7 fill-[#d03027] text-[#d03027]" /> : <Mic aria-hidden className="size-8" />}
              </button>
            ) : (
              <p className="text-center text-sm text-[#aab4c8]">Voice input isn&apos;t available in this browser.</p>
            )}
            {canTalk && (
              <button
                type="button"
                onClick={() => {
                  if (speaking) return stopSpeaking();
                  setVoiceOn((v) => !v);
                }}
                aria-pressed={speaking ? undefined : !voiceOn}
                className={`${btn} border border-[#aab4c8] px-4`}
              >
                {speaking ? <Square aria-hidden className="size-[1.1em]" /> : voiceOn ? <Volume2 aria-hidden className="size-[1.1em]" /> : <VolumeX aria-hidden className="size-[1.1em]" />}
                <span className="max-[359px]:sr-only">{speaking ? "Stop speaking" : voiceOn ? "Mute replies" : "Replies muted"}</span>
              </button>
            )}
          </div>
          {voice.recognition && !choosing && (
            <p className="text-center text-sm text-[#c9d1df]">
              Voice input: {SPEECH_INPUT_LABELS[prefs.speechInput]}.{" "}
              <button type="button" onClick={() => setChoosing(true)} className="inline-flex min-h-(--target-min) items-center px-1 font-bold text-[#f5f5f2] underline underline-offset-4">
                Change<span className="sr-only"> voice input</span>
              </button>
            </p>
          )}
          {!docked && (
            <p className="text-center text-sm text-[#aab4c8]">
              {listenMode === "hold"
                ? "Dial only listens while you hold the microphone or the Space bar."
                : listenMode === "continuous"
                  ? "Dial keeps listening until you tap stop, or after 2 minutes of quiet."
                  : "Dial only listens after you tap the microphone."}{" "}
              {voice.backend === "on-device"
                ? "Speech is turned into text on this device. "
                : voice.backend === "cloud"
                  ? "Your browser's online speech service turns speech into text. Dial doesn't keep recordings. "
                  : ""}
              Interface changes stay on this device.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
