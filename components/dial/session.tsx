"use client";

// One Dial conversation for the whole app. Voice Mode and the Ask sheet both submit here, so a question typed in
// the sheet and a follow-up spoken in Voice Mode share the same context, planner, runner and request guard.
//
// typed or spoken text -> plan() (local, deterministic) -> runSteps() (trusted app code) -> reply items
// Only "ask" steps reach /api/ask; a newer turn aborts the older one and stale results are dropped by turn id.
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { askDial, intentForQuestion, offlineFacts } from "@/lib/assistant/client";
import { askModelForSteps } from "@/lib/assistant/command-client";
import { brainWithin, loadBrain } from "@/lib/access/brain";
import { adaptationFor, offeredAdaptation, type Adaptation } from "@/lib/access/pipeline";
import { changesFor, planKeep } from "@/lib/access/understand";
import { prefersReducedMotion, reveal } from "@/lib/access/reveal";
import { clarify } from "@/lib/access/clarify";
import { PROTECTED_NOTE, withoutProtectedHides } from "@/lib/access/safety";
import { liveState } from "@/lib/assistant/live-state";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { createAskCache, askKey } from "@/lib/dial/ask-cache";
import { afterAnswer, withRoute } from "@/lib/dial/context";
import { plan } from "@/lib/dial/plan";
import { runSteps, type PendingOffer, type ReplyItem } from "@/lib/dial/runner";
import { DIAL_ROUTES, EMPTY_CONTEXT, type DialContext, type DialRoute, type DialStep } from "@/lib/dial/types";
import { buildVisual } from "@/lib/dial/visuals";
import { simulate } from "@/lib/dial/what-if";
import { describeGoal } from "@/lib/goals/describe";
import { useGoals } from "@/lib/goals/provider";
import { formatLongDate, formatPence } from "@/lib/format";
import { paymentReply } from "@/lib/payments/dial";
import { usePreferences } from "@/lib/preferences/provider";
import { dialStyle } from "@/lib/preferences/schema";
import { spendPauseReply } from "@/lib/spend-pause/dial";
import { splitCorrection } from "@/lib/voice/correction";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";

export interface DialTurn {
  id: number;
  input: string;
  /** What Dial understood after corrections, e.g. "Groceries in October". */
  understood: string;
  corrected: boolean;
  status: "working" | "done";
  items: ReplyItem[];
  /** True when nothing in this turn needed the backend. */
  local: boolean;
}

/** What the surface showing Dial (Voice Mode or the Ask sheet) does around the conversation. */
export interface DialSurface {
  /** Called after Dial navigated, so the surface can get out of the way (dock or close). */
  onNavigated?(): void;
  onExit?(): void;
  /** Stop reading aloud and listening. */
  onStop?(): void;
}

interface SessionApi {
  turn: DialTurn | null;
  offer: PendingOffer | null;
  submit(text: string, opts?: { replaces?: string }): Promise<DialTurn | null>;
  /** Answers the pending offer. `save` also keeps display changes for next time. */
  decide(yes: boolean, opts?: { save?: boolean }): string;
  cancel(): void;
  setSurface(surface: DialSurface | null): void;
  /** For the dev badge and tests: how many turns needed the network. */
  stats: { turns: number; local: number; network: number; reused: number };
}

const SessionContext = createContext<SessionApi | null>(null);

const HELP =
  "I'm Dial, the assistant for this card. I use Groq to understand you, but every figure comes from your account, checked on this device. You can ask about your money, like where does most of my money go, or compare October with September. You can say take me to spending or show my groceries for October. You can change how the app looks, like make everything bigger or use fewer numbers. You can ask what if I spend 100 pounds less next month, or set a goal. Say undo, stop, or exit at any time.";

const sameUrl = (href: string) => `${window.location.pathname}${window.location.search}` === href;

export function DialSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { account, transactions, settings, payments, spendPauseActivity } = useAccount();
  const { mode, setMode } = useMode();
  const prefsApi = usePreferences();
  const goalsApi = useGoals();

  const [turn, setTurn] = useState<DialTurn | null>(null);
  const [offer, setOffer] = useState<PendingOffer | null>(null);
  const [stats, setStats] = useState({ turns: 0, local: 0, network: 0, reused: 0 });
  const context = useRef<DialContext>(EMPTY_CONTEXT);
  const turnId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const surface = useRef<DialSurface | null>(null);
  const offerRef = useRef<PendingOffer | null>(null);
  /** The mode before a view preview, so "no" can put it back. */
  const modeBefore = useRef<Mode | null>(null);
  /** Stops an adaptation that is still revealing itself, one change at a time. */
  const stopReveal = useRef<() => void>(() => {});
  const cache = useMemo(() => createAskCache(), []);

  // Latest values for callbacks that outlive a render (async steps, the voice engine).
  const live = useRef({ account, transactions, settings, payments, spendPauseActivity, mode, prefsApi, goalsApi, pathname });
  live.current = { account, transactions, settings, payments, spendPauseActivity, mode, prefsApi, goalsApi, pathname };

  useEffect(() => {
    const route = (DIAL_ROUTES as readonly string[]).includes(pathname) ? (pathname as DialRoute) : null;
    context.current = withRoute(context.current, route, mode);
  }, [pathname, mode]);

  const setPending = (o: PendingOffer | null) => {
    offerRef.current = o;
    context.current = { ...context.current, pending: o?.step ?? null };
    setOffer(o);
  };

  const settle = useCallback((o: PendingOffer, yes: boolean, save = false): string => settleNowRef.current(o, yes, save), []);

  const settleNow = (o: PendingOffer, yes: boolean, save = false): string => {
    const { prefsApi: p, goalsApi: g } = live.current;
    const step = o.step;
    setPending(null);
    if (step.type === "preferences") {
      if (yes && step.actions.some((a) => a.type === "reset")) p.resetToDefault();
      else if (yes) p.acceptPreview({ save });
      else p.rejectPreview();
    }
    if (step.type === "adapt") {
      // Answering before the last change has landed stops the sequence; what's kept is always the full set.
      stopReveal.current();
      if (!yes) {
        p.rejectPreview();
        return "Okay, I've left it as it was. You can tell me more about what's hard, or change anything in Settings.";
      }
      const keep = planKeep(changesFor(step.situations), step.scope);
      if (step.scope === "night") {
        // The preview showed the night look now. Keep the schedule (saved, so it comes back every evening) and
        // anything that isn't about the light; the screen returns to the day look until 7pm.
        p.rejectPreview();
        p.apply([...keep.now, { type: "nightLook", actions: keep.night }], { save: true, source: "voice" });
        return "Done. Your night look switches on by itself from 7pm to 7am. You can change it in Settings, or say undo.";
      }
      // Applied from the plan, not from the preview, so it's complete even if "Keep it" came mid-animation.
      p.rejectPreview();
      p.apply(keep.now, { save: step.scope === "always" || save, source: "voice" });
      return step.scope === "now" ? "Done, just for now. It goes back to normal next time, or say undo." : "Done, and saved for next time. Say undo to change it back.";
    }
    if (step.type === "setMode") {
      if (!yes && modeBefore.current) setMode(modeBefore.current);
      modeBefore.current = null;
    }
    if (step.type === "goal" && yes) {
      if (step.op === "create") g.add(step.spec);
      if (step.op === "remove") g.remove(step.goalId);
      return step.op === "create" ? "Goal added. You can see how it's going on the Goals screen." : "Goal removed.";
    }
    if (!yes) return "Okay, I've left it as it was.";
    if (step.type === "preferences" && save) return "Kept and saved. It will look like this next time.";
    return step.type === "preferences" ? "Done. Say save it to keep this for next time, or undo to change it back." : "Done.";
  };
  const settleNowRef = useRef(settleNow);
  settleNowRef.current = settleNow;

  const submit = useCallback(
    async (text: string, opts: { replaces?: string } = {}): Promise<DialTurn | null> => {
      const input = text.trim();
      if (!input) return null;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const id = ++turnId.current;
      const L = live.current;

      // A contradictory or vague request gets a question back, never a guess (lib/access/clarify.ts). A correction
      // ("no, I meant bigger") is already a clear choice, so it skips this.
      const question = opts.replaces || splitCorrection(input) ? null : clarify(input);
      if (question) {
        const asked: DialTurn = { id, input, understood: "", corrected: false, status: "done", items: [{ kind: "say", text: question }], local: true };
        setStats((s) => ({ ...s, turns: s.turns + 1, local: s.local + 1 }));
        setTurn(asked);
        return asked;
      }

      // Someone describing their situation ("I have trouble seeing at night") is understood on this device by meaning,
      // before the precise rules run. Commands, page names and money questions skip this (lib/access/route.ts).
      // The model is given up to 4 seconds the first time it loads; after that it answers in milliseconds.
      let found: Adaptation | null = null;
      try {
        const brain = await brainWithin(4000);
        if (id !== turnId.current) return null;
        if (brain) found = await adaptationFor(input, brain);
        if (id !== turnId.current) return null;
      } catch {
        // The rules below still run; nothing about the sentence is logged.
      }

      const months = [...new Set(L.transactions.map((t) => t.date.slice(0, 7)))].sort();
      const merchants = [...new Set(L.transactions.map((t) => t.merchant))];
      const planned = plan(
        { text: input, replaces: opts.replaces },
        {
          context: context.current,
          textSize: L.prefsApi.prefs.textSize,
          merchants,
          transactionIds: L.transactions.map((t) => t.id),
          months,
          today: DEMO_TODAY,
          localReply: (q) => {
            const sp = spendPauseReply(q, L.settings, L.spendPauseActivity);
            if (sp) return { text: sp.text, link: sp.action ? { label: sp.action.label, href: sp.action.href } : undefined };
            const paid = paymentReply(q, { account: L.account, transactions: L.transactions, payments: L.payments });
            return paid ? { text: paid, link: { label: "Open Pay", href: "/account/pay" } } : null;
          },
        },
      );
      context.current = planned.context;
      // The on-device rules come first. Groq is only asked when they found nothing they could do with the request,
      // so common commands never cost a call. Its answer is a list of steps that pass the same validation as ours.
      const adaptStep = (a: Adaptation): DialStep => ({ type: "adapt", situations: a.situations, scope: a.scope, ...(a.tentative ? { tentative: true } : {}) });
      // "Probably" only wins when the rules had nothing else to do with the sentence, and it is offered as a question.
      const rulesGaveUp = planned.steps.length > 0 && planned.steps.every((s) => s.type === "unsupported");
      const adaptation = offeredAdaptation(found, rulesGaveUp);
      let steps: DialStep[] = adaptation ? [adaptStep(adaptation)] : planned.steps;
      let usedModel = false;
      const gaveUp = steps.length > 0 && steps.every((s) => s.type === "unsupported");
      const corrected = !!opts.replaces || splitCorrection(input) !== null;
      // When the situation layer took the sentence, its card says what it heard, so the rules' reading isn't shown too.
      const working: DialTurn = { id, input, understood: gaveUp || adaptation ? "" : planned.understood, corrected, status: "working", items: [], local: adaptation ? true : planned.local };
      setTurn(gaveUp ? { ...working, local: false } : working);
      if (gaveUp) {
        const route = (DIAL_ROUTES as readonly string[]).includes(L.pathname) ? L.pathname : null;
        const fromModel = await askModelForSteps(input, { route, mode: L.mode, textSize: L.prefsApi.prefs.textSize }, { signal: controller.signal });
        if (id !== turnId.current) return null; // a newer turn replaced this one
        if (fromModel === "busy") steps = [{ type: "unsupported", say: "Groq is busy right now (its request limit), so I couldn't work that out. Try again in a few seconds, or use a plain command like make everything bigger." }];
        else if (fromModel && fromModel.length > 0) {
          // A model may suggest "less on screen" by hiding sections; the bill, Spend Pause and warnings are never hidden that way.
          const safe = withoutProtectedHides(fromModel);
          steps = safe.steps.length > 0 ? safe.steps : [{ type: "unsupported", say: PROTECTED_NOTE }];
          usedModel = true;
        }
      }

      const insightCtx = () => ({ account: live.current.account, txns: live.current.transactions, settings: live.current.settings, today: DEMO_TODAY });
      const state = liveState(L.transactions, L.settings);
      const stateKey = JSON.stringify(state);
      const style = dialStyle(L.prefsApi.prefs);
      const reusedBefore = cache.stats.reused + cache.stats.joined;

      const out = await runSteps(
        steps,
        {
          mode: L.mode,
          navigate: async (href) => {
            if (sameUrl(href)) return true;
            router.push(href);
            // The page has arrived when the address bar shows it. Give up after 4 seconds and say so.
            for (let waited = 0; waited < 4000; waited += 50) {
              await new Promise((r) => setTimeout(r, 50));
              if (sameUrl(href)) {
                surface.current?.onNavigated?.();
                return true;
              }
            }
            return false;
          },
          back: () => {
            if (window.history.length <= 1) return false;
            router.back();
            surface.current?.onNavigated?.();
            return true;
          },
          previewPreferences: (step) => live.current.prefsApi.startPreview(step.actions, { source: "voice" }),
          // Each change lands on its own, a beat apart, in step with its line in Dial's card (lib/access/reveal.ts).
          previewAdapt: (step) => {
            const actions = changesFor(step.situations).map((c) => c.action);
            stopReveal.current();
            stopReveal.current = reveal(actions.length, (n) => live.current.prefsApi.startPreview(actions.slice(0, n), { source: "voice" }), {
              reduced: prefersReducedMotion(live.current.prefsApi.prefs.motion),
            });
          },
          previewMode: (m) => {
            modeBefore.current = live.current.mode;
            setMode(m);
          },
          settle,
          control: (command) => {
            const p = live.current.prefsApi;
            switch (command) {
              case "stop":
                surface.current?.onStop?.();
                return null;
              case "undo":
                if (!p.canUndo) return "There's nothing to undo.";
                p.undo();
                return "Undone.";
              case "save":
                p.save();
                return "Saved. It will look like this next time you open the app.";
              case "exit":
                surface.current?.onExit?.();
                return null;
              case "help":
                return HELP;
              case "readBalance": {
                const a = live.current.account;
                return `${a.statementBalance === 0 ? "Your bill is paid." : `Your bill is ${formatPence(a.statementBalance)}, due on ${formatLongDate(a.paymentDueDate)}.`} You owe ${formatPence(a.currentBalance)} in total.`;
              }
              case "readPage": {
                const main = document.querySelector("main")?.innerText.replace(/\s+/g, " ").trim() ?? "";
                return main.slice(0, 1200) || "There's nothing to read on this screen.";
              }
              default:
                return null;
            }
          },
          visual: (req) => buildVisual(req, insightCtx()),
          whatIf: (s) => simulate(s, insightCtx()),
          goals: () => live.current.goalsApi.goals,
          describeGoal,
          ask: (question, previousQuestion, signal) =>
            cache.run(askKey({ question, previousQuestion, style, state: stateKey }), () => askDial(question, { state, previousQuestion, style, signal })),
          offline: (question) => {
            const intent = intentForQuestion(question);
            return intent ? offlineFacts(intent, { account: live.current.account, txns: live.current.transactions, settings: live.current.settings, today: DEMO_TODAY, now: DEMO_NOW }) : null;
          },
        },
        offerRef.current,
        controller.signal,
        context.current.lastQuestion ?? undefined,
      );

      if (id !== turnId.current || out.cancelled) return null; // a newer turn replaced this one
      if (out.asked) context.current = afterAnswer(context.current, { question: out.asked, resolvedQuestion: out.resolvedQuestion });
      if (out.offer) setPending(out.offer);
      const reused = cache.stats.reused + cache.stats.joined - reusedBefore;
      const network = out.network + (gaveUp ? 1 : 0);
      setStats((s) => ({ turns: s.turns + 1, local: s.local + (network === 0 ? 1 : 0), network: s.network + network - reused, reused: s.reused + reused }));
      const done: DialTurn = { ...working, local: working.local && !gaveUp && !usedModel, status: "done", items: out.items };
      setTurn(done);
      return done;
    },
    [router, setMode, settle, cache],
  );

  const decide = useCallback(
    (yes: boolean, opts: { save?: boolean } = {}) => {
      const o = offerRef.current;
      if (!o) return "";
      const text = settle(o, yes, opts.save);
      setTurn((t) => (t ? { ...t, items: [{ kind: "say", text }] } : t));
      return text;
    },
    [settle],
  );

  const cancel = useCallback(() => {
    abort.current?.abort();
    turnId.current++;
    setTurn((t) => (t?.status === "working" ? { ...t, status: "done", items: [{ kind: "say", text: "Stopped." }] } : t));
  }, []);

  const setSurface = useCallback((s: DialSurface | null) => {
    surface.current = s;
    // Opening Dial starts loading the on-device model, so it is usually ready by the time the person has spoken.
    // Nothing is downloaded for people who never open Dial.
    if (s) void loadBrain();
  }, []);

  // Leaving with a preview showing withdraws it: nothing changes silently.
  useEffect(() => () => abort.current?.abort(), []);

  const api = useMemo(() => ({ turn, offer, submit, decide, cancel, setSurface, stats }), [turn, offer, submit, decide, cancel, setSurface, stats]);
  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useDialSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useDialSession must be used inside DialSessionProvider");
  return ctx;
}
