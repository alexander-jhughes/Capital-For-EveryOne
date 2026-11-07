"use client";

import { Check, ChevronDown, ChevronUp, Keyboard, Mic, Save, Square, Undo2, Volume2, VolumeX, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { askDial, evidenceHref, intentForQuestion, knownEvidence, offlineFacts } from "@/lib/assistant/client";
import { canSpeak, getRecognition, pickVoice, voiceErrorMessage, type Recognition } from "@/lib/assistant/speech";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { formatLongDate, formatPence } from "@/lib/format";
import { usePreferences } from "@/lib/preferences/provider";
import { describeActions, type UiAction } from "@/lib/preferences/schema";
import { paymentReply } from "@/lib/payments/dial";
import { spendPauseReply } from "@/lib/spend-pause/dial";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import { interpret, type Route } from "@/lib/voice/interpret";
import type { ExperienceTemplate } from "@/lib/assistant/experience";
import { ExperienceCard } from "../experience/templates";
import { DialMark } from "../wordmark";

type Phase = "ready" | "listening" | "thinking" | "speaking";
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

/**
 * Full-screen Dial Voice Mode. Listens only after a tap; never in the background.
 * speech -> interpret (local) -> preview -> confirm -> apply, or a money question -> /api/ask.
 */
export function VoiceMode({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const recognition = useRef<Recognition | null>(null);
  const router = useRouter();
  const inputId = useId();
  const { account, transactions, settings, payments, spendPauseActivity, dialState } = useAccount();
  const { mode, setMode } = useMode();
  const prefsApi = usePreferences();
  const { prefs, startPreview, acceptPreview, rejectPreview, undo, save, resetToDefault, canUndo } = prefsApi;

  const [support, setSupport] = useState({ listen: false, speak: false });
  const [phase, setPhase] = useState<Phase>("ready");
  const [heard, setHeard] = useState("");
  const [reply, setReply] = useState<Reply>({ text: "Hello. Tap the microphone and tell me what you need, or type it below." });
  const [offer, setOffer] = useState<Offer>(null);
  const [docked, setDocked] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => setSupport({ listen: !!getRecognition(window), speak: canSpeak(window) }), []);

  const stopSpeaking = useCallback(() => {
    if (canSpeak(window)) window.speechSynthesis.cancel();
    setPhase((p) => (p === "speaking" ? "ready" : p));
  }, []);

  const say = useCallback(
    (r: Reply) => {
      setReply(r);
      if (!voiceOn || !canSpeak(window)) return setPhase("ready");
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(r.text);
      u.lang = "en-GB";
      const v = pickVoice(window.speechSynthesis.getVoices());
      if (v) u.voice = v;
      u.onend = () => setPhase((p) => (p === "speaking" ? "ready" : p));
      u.onerror = () => setPhase((p) => (p === "speaking" ? "ready" : p));
      setPhase("speaking");
      window.speechSynthesis.speak(u);
    },
    [voiceOn],
  );

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
    } else if (!open && d.open) d.close();
  }, [open]);

  function handleClosed() {
    recognition.current?.stop();
    stopSpeaking();
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
    async (utterance: string) => {
      const text = utterance.trim();
      if (!text) return;
      setHeard(text);
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
          startPreview(r.actions);
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
              recognition.current?.stop();
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
          setPhase("thinking");
          setReply({ text: "Checking your account..." });
          const outcome = await askDial(text, { state: dialState });
          if (outcome.kind === "answer") return say({ text: outcome.response.answer, evidence: outcome.response.evidenceIds, template: outcome.experience.template });
          if (outcome.kind === "invalid") return say({ text: outcome.message });
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
    [prefs.textSize, offer, decide, rejectPreview, setMode, startPreview, say, mode, router, stopSpeaking, canUndo, undo, save, account, transactions, settings, payments, spendPauseActivity, dialState],
  );

  function listen() {
    const Rec = getRecognition(window);
    if (!Rec) {
      setTyping(true);
      return setNotice("Voice input isn't available in this browser. You can type instead.");
    }
    stopSpeaking();
    setNotice("");
    setHeard("");
    const r = new Rec();
    r.lang = "en-GB";
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const results = Array.from(e.results as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>);
      const textSoFar = results.map((x) => x[0]?.transcript ?? "").join(" ");
      setHeard(textSoFar);
      const last = results.at(-1);
      if (last?.isFinal) {
        setPhase("thinking");
        void handle(textSoFar);
      }
    };
    r.onerror = (e) => {
      const m = voiceErrorMessage(e.error);
      if (m) setNotice(m);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setTyping(true);
    };
    r.onend = () => setPhase((p) => (p === "listening" ? "ready" : p));
    recognition.current = r;
    setPhase("listening");
    r.start();
  }

  const offerLabel = offer?.kind === "ui" ? describeActions(offer.actions) : offer?.kind === "mode" ? `switch to ${offer.to === "simple" ? "Simple" : "Detailed"} view` : "";
  const status =
    phase === "listening" ? (offer ? "Listening for your answer" : "Listening") : phase === "thinking" ? "Thinking" : phase === "speaking" ? "Speaking" : "Ready";
  const evidence = reply.evidence ? knownEvidence(reply.evidence, new Set(transactions.map((t) => t.id))) : [];

  return (
    <dialog ref={ref} className="voice-mode" data-docked={docked} aria-labelledby={`${inputId}-t`} onClose={handleClosed}>
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
            <div aria-hidden className="wave flex h-16 items-center gap-1.5" data-state={phase === "listening" ? "listening" : phase === "speaking" ? "speaking" : "idle"}>
              {[14, 28, 46, 62, 40, 56, 30, 50, 60, 28, 16].map((h, i) => (
                <span key={i} className="block w-1.5 rounded-full" style={{ height: phase === "ready" || phase === "thinking" ? 8 : h, background: i === 5 ? "#a9ddf2" : i % 4 === 0 ? "#4f8db8" : "#6cc4e8" }} />
              ))}
            </div>
          )}
          <p className="flex items-center gap-2 font-bold">
            {phase === "listening" && <span aria-hidden className="size-2.5 rounded-full bg-[#ff6b5e]" />}
            {status}
          </p>
        </div>

        {heard && <p className={`text-center font-semibold leading-snug ${docked ? "text-lg" : "text-xl"}`}>&ldquo;{heard}&rdquo;</p>}

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

        {!docked && !offer && (
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

        {notice && (
          <p role="alert" className="rounded-xl bg-[#3a1f2a] p-3 text-[#ffb4ad]">
            {notice}
          </p>
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
            {support.listen ? (
              <button
                type="button"
                onClick={phase === "listening" ? () => recognition.current?.stop() : listen}
                aria-label={phase === "listening" ? "Stop listening" : "Start listening"}
                className="flex size-20 items-center justify-center rounded-full border-4 border-[#6cc4e8] bg-[#f5f5f2] text-[#004977]"
              >
                {phase === "listening" ? <Square aria-hidden className="size-7 fill-[#d03027] text-[#d03027]" /> : <Mic aria-hidden className="size-8" />}
              </button>
            ) : (
              <p className="text-center text-sm text-[#aab4c8]">Voice input isn&apos;t available in this browser.</p>
            )}
            {support.speak && (
              <button
                type="button"
                onClick={() => {
                  if (phase === "speaking") return stopSpeaking();
                  setVoiceOn((v) => !v);
                }}
                aria-pressed={phase === "speaking" ? undefined : !voiceOn}
                className={`${btn} border border-[#aab4c8] px-4`}
              >
                {phase === "speaking" ? <Square aria-hidden className="size-[1.1em]" /> : voiceOn ? <Volume2 aria-hidden className="size-[1.1em]" /> : <VolumeX aria-hidden className="size-[1.1em]" />}
                <span className="max-[359px]:sr-only">{phase === "speaking" ? "Stop speaking" : voiceOn ? "Mute replies" : "Replies muted"}</span>
              </button>
            )}
          </div>
          {!docked && (
            <p className="text-center text-sm text-[#aab4c8]">
              Dial only listens after you tap the microphone. Your browser&apos;s speech service turns speech into text. Interface changes stay on this device.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
