// Runs a DialPlan's steps through trusted app code. Pure TypeScript: every effect is an injected dependency, so the
// same runner serves Voice Mode and the Ask sheet, and tests can drive it without React or a router.
//
// Rules:
// - Only steps that pass validateStep() run. Anything else is reported as not done.
// - Navigation and showing things never ask for confirmation. Changes the person keeps (view, display settings,
//   goals) are previewed or offered first, then kept on "yes".
// - Money never moves here. Pay and Spend Pause steps only link to the screen where the person confirms.
// - A step that fails says it failed. Nothing reports success without the effect having happened.
// - Only "ask" steps reach the network, and a newer turn cancels an older one (the caller passes the signal).
import type { AskOutcome } from "../assistant/client";
import type { ExperienceTemplate } from "../assistant/experience";
import { isCantTell } from "../ai/guard";
import { describeActions } from "../preferences/schema";
import { situationById, type Scope } from "../access/catalogue";
import { changesFor } from "../access/understand";
import type { AskResponse, Fact, Mode } from "../types";
import { ROUTE_INFO, stepHref, validateStep } from "./registry";
import type { DialStep, Goal, GoalSpec, Visual, VisualRequest, WhatIfResult, WhatIfScenario } from "./types";

export type ReplyItem =
  | { kind: "say"; text: string }
  | { kind: "visual"; visual: Visual }
  | { kind: "whatIf"; result: WhatIfResult }
  | { kind: "answer"; text: string; evidenceIds: string[]; source: AskResponse["source"]; template: ExperienceTemplate; followUps: string[]; modelBusy?: boolean }
  | { kind: "offline"; facts: Fact[]; evidenceIds: string[] }
  /** A change waiting for "Keep it" or "No". */
  | { kind: "offer"; text: string }
  /** What Dial heard about the person's situation, and each change it is previewing with the reason for it. */
  | { kind: "adapt"; heard: string[]; changes: { text: string; why: string }[]; scope: Scope; tentative: boolean; cloud: boolean }
  | { kind: "link"; label: string; href: string }
  /** Something Dial tried and could not do. Shown as a failure, never as success. */
  | { kind: "failed"; text: string };

/** An offered change. `revert` undoes a live preview if the person says no or moves on. */
export interface PendingOffer {
  step: DialStep;
  description: string;
}

export interface RunnerDeps {
  mode: Mode;
  /** Pushes a route and resolves true once the page shows it, false if it didn't arrive. */
  navigate(href: string): Promise<boolean>;
  back(): boolean;
  previewPreferences(step: Extract<DialStep, { type: "preferences" }>): void;
  /** Shows every change for these situations now (whatever the scope), so the person sees what they'd keep. */
  previewAdapt(step: Extract<DialStep, { type: "adapt" }>): void;
  previewMode(mode: Mode): void;
  /** Keeps (yes) or reverts (no) whatever `offer` previewed. */
  settle(offer: PendingOffer, yes: boolean): string;
  control(command: Extract<DialStep, { type: "control" }>["command"]): string | null;
  visual(req: VisualRequest): Visual;
  whatIf(s: WhatIfScenario): WhatIfResult;
  goals(): Goal[];
  describeGoal(spec: GoalSpec): string;
  ask(question: string, previousQuestion: string | undefined, signal: AbortSignal): Promise<AskOutcome>;
  /** Facts from the deterministic layer when the backend is unavailable, for the demo questions. */
  offline(question: string): { facts: Fact[]; evidenceIds: string[] } | null;
}

export interface RunOutput {
  items: ReplyItem[];
  /** Set when a step is waiting for yes or no. */
  offer: PendingOffer | null;
  /** From the backend, for the next follow-up. */
  resolvedQuestion?: string;
  asked?: string;
  /** Requests that went to the backend in this turn (0 for anything handled on the device). */
  network: number;
  cancelled: boolean;
}

const CONFIRM_LATER = "I can only make one change at a time. Ask me again for the next one once you've decided on this.";

/** How long the changes last, in plain words. */
export const SCOPE_TEXT: Record<Scope, string> = {
  night: "The night look switches on by itself every evening from 7pm to 7am.",
  now: "Just for now: it goes back to normal next time you open the app.",
  always: "I'll keep this for next time too.",
};

export function describeOffer(step: DialStep, deps: Pick<RunnerDeps, "describeGoal" | "goals">): string {
  switch (step.type) {
    case "adapt": {
      const heard = step.situations.map((id) => situationById(id).heard.toLowerCase());
      const lead = step.tentative ? `Did you mean that ${heard.join(", and ")}?` : `It sounds like ${heard.join(", and ")}.`;
      return `${lead} I can ${describeActions(changesFor(step.situations).map((c) => c.action))}. ${SCOPE_TEXT[step.scope]}`;
    }
    case "preferences":
      return `I can ${describeActions(step.actions)}.`;
    case "setMode":
      return step.mode === "simple" ? "This is Simple view, which shows less on each screen. Your text size and colours stay as they are." : "This is Detailed view, which shows more on each screen. Your text size and colours stay as they are.";
    case "goal":
      if (step.op === "create") return `I can add a goal: ${deps.describeGoal(step.spec)}. It stays on this device.`;
      if (step.op === "remove") {
        const g = deps.goals().find((x) => x.id === step.goalId);
        return g ? `I can remove your goal: ${deps.describeGoal(g.spec)}.` : "That goal isn't there any more.";
      }
      return "";
    default:
      return "";
  }
}

/**
 * Runs the steps in order. `pending` is the offer from the previous turn: a "yes" or "no" settles it, and any other
 * new request withdraws it first (a preview is never left half-applied).
 */
export async function runSteps(rawSteps: unknown[], deps: RunnerDeps, pending: PendingOffer | null, signal: AbortSignal, previousQuestion?: string): Promise<RunOutput> {
  const out: RunOutput = { items: [], offer: null, network: 0, cancelled: false };
  const steps: DialStep[] = [];
  for (const raw of rawSteps) {
    const s = validateStep(raw);
    // "Reset" is a display change like any other: previewed, then kept on "yes" (it also clears saved settings).
    if (s?.type === "control" && s.command === "reset") steps.push({ type: "preferences", actions: [{ type: "reset" }] });
    else if (s) steps.push(s);
    else out.items.push({ kind: "failed", text: "I couldn't do part of that." });
  }

  // "Undo" (or "I've changed my mind") with a preview showing means "no": only the preview goes, not the change before it.
  const answersPending = steps.length === 1 && steps[0].type === "control" && (steps[0].command === "yes" || steps[0].command === "no" || (steps[0].command === "undo" && !!pending));
  if (pending && !answersPending) deps.settle(pending, false);

  for (const step of steps) {
    if (signal.aborted) return { ...out, cancelled: true };
    switch (step.type) {
      case "navigate": {
        const href = stepHref(step);
        if (!href) {
          out.items.push({ kind: "failed", text: "I can't open that page." });
          break;
        }
        const ok = await deps.navigate(href);
        if (signal.aborted) return { ...out, cancelled: true };
        out.items.push(ok ? { kind: "say", text: step.say ?? `Here's ${ROUTE_INFO[step.to].spoken}.` } : { kind: "failed", text: `I couldn't open ${ROUTE_INFO[step.to].spoken}. Try the menu instead.` });
        break;
      }
      case "back":
        out.items.push(deps.back() ? { kind: "say", text: "Gone back." } : { kind: "failed", text: "There's no earlier page to go back to." });
        break;
      case "setMode":
      case "preferences":
      case "adapt":
      case "goal": {
        if (step.type === "goal" && step.op === "list") {
          const goals = deps.goals();
          out.items.push({ kind: "say", text: goals.length ? `You have ${goals.length} ${goals.length === 1 ? "goal" : "goals"}: ${goals.map((g) => deps.describeGoal(g.spec)).join("; ")}.` : "You haven't set any goals yet." });
          out.items.push({ kind: "link", label: "Open Goals", href: "/account/goals" });
          break;
        }
        if (out.offer) {
          out.items.push({ kind: "say", text: CONFIRM_LATER });
          break;
        }
        if (step.type === "setMode" && step.mode === deps.mode) {
          out.items.push({ kind: "say", text: `You're already in ${step.mode === "simple" ? "Simple" : "Detailed"} view.` });
          break;
        }
        if (step.type === "goal" && step.op === "remove" && !deps.goals().some((g) => g.id === step.goalId)) {
          out.items.push({ kind: "failed", text: "That goal isn't there any more." });
          break;
        }
        if (step.type === "preferences") deps.previewPreferences(step);
        if (step.type === "setMode") deps.previewMode(step.mode);
        const description = describeOffer(step, deps);
        out.offer = { step, description };
        if (step.type === "adapt") {
          out.items.push({
            kind: "adapt",
            heard: step.situations.map((id) => situationById(id).heard),
            changes: changesFor(step.situations).map((c) => ({ text: describeActions([c.action]), why: c.why })),
            scope: step.scope,
            tentative: !!step.tentative,
            cloud: !!step.cloud,
          });
          deps.previewAdapt(step);
          out.items.push({ kind: "offer", text: `${step.tentative ? "Here's a preview, in case it helps." : "Here's a preview."} Do you want to keep it?` });
          break;
        }
        out.items.push({ kind: "offer", text: `${step.type === "goal" ? description : `Here's a preview. ${description}`} Do you want to keep it?` });
        break;
      }
      case "control": {
        if (step.command === "yes" || step.command === "no" || (step.command === "undo" && answersPending)) {
          if (!pending) {
            out.items.push({ kind: "say", text: "There's nothing waiting for an answer. What would you like to do?" });
            break;
          }
          out.items.push({ kind: "say", text: deps.settle(pending, step.command === "yes") });
          break;
        }
        const text = deps.control(step.command);
        if (text) out.items.push({ kind: "say", text });
        break;
      }
      case "visual": {
        try {
          out.items.push({ kind: "visual", visual: deps.visual(step.request) });
        } catch {
          out.items.push({ kind: "failed", text: "I couldn't build that chart from your account." });
        }
        break;
      }
      case "whatIf": {
        try {
          out.items.push({ kind: "whatIf", result: deps.whatIf(step.scenario) });
        } catch {
          out.items.push({ kind: "failed", text: "I couldn't work that out from your account." });
        }
        break;
      }
      case "local":
        out.items.push({ kind: "say", text: step.text });
        if (step.link) out.items.push({ kind: "link", ...step.link });
        break;
      case "unsupported":
        out.items.push({ kind: "say", text: step.say });
        break;
      case "ask": {
        out.network++;
        const prev = step.previousQuestion ?? previousQuestion;
        const outcome = await deps.ask(step.question, prev, signal);
        if (outcome.kind === "cancelled" || signal.aborted) return { ...out, cancelled: true };
        out.asked = step.question;
        if (outcome.kind === "answer") {
          const { evidenceIds, source } = outcome.response;
          // "I can't tell that from your transactions" is the safe answer to anything the account can't support. On its
          // own it reads like a failure, so say what Dial can answer instead (same safety: no figure is invented).
          const answer = isCantTell(outcome.response.answer)
            ? "I can only answer questions about this card: your bill, spending, shops, subscriptions and payments. Try asking where your money goes, or if a subscription has gone up."
            : outcome.response.answer;
          out.resolvedQuestion = outcome.resolvedQuestion;
          out.items.push({ kind: "answer", text: answer, evidenceIds, source, template: outcome.experience.template, followUps: outcome.followUps, ...(outcome.modelBusy ? { modelBusy: true } : {}) });
        } else if (outcome.kind === "invalid") {
          out.items.push({ kind: "failed", text: outcome.message });
        } else {
          const off = deps.offline(step.question);
          out.items.push(off ? { kind: "offline", ...off } : { kind: "failed", text: "Dial's assistant isn't available right now, so I can't answer that one. Navigation, charts and display changes still work." });
        }
        break;
      }
    }
  }
  return out;
}

/** What Voice Mode reads aloud for a turn: every sentence shown, in order, charts as their summaries. */
export function spokenText(items: ReplyItem[]): string {
  return items
    .map((i) => {
      switch (i.kind) {
        case "say":
        case "failed":
        case "answer":
        case "offer":
          return i.text;
        case "adapt":
          return `${i.tentative ? "Did you mean that" : "It sounds like"} ${i.heard.map((h) => h.toLowerCase()).join(", and ")}${i.tentative ? "?" : "."} ${i.changes.map((c) => `I can ${c.text}. ${c.why}`).join(" ")} ${SCOPE_TEXT[i.scope]}`;
        case "visual":
          return i.visual.summary;
        case "whatIf":
          return `${i.result.statement} This is an estimate, not a forecast.`;
        case "offline":
          return i.facts.map((f) => `${f.label}: ${f.value}.`).join(" ");
        case "link":
          return "";
      }
    })
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}
