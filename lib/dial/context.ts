// The conversation context: small, local and never sent whole to the backend. Pure updates only.
import type { Mode } from "../types";
import type { DialContext, DialRoute, DialStep, DialSubject } from "./types";

const MAX_QUESTION = 300;

/**
 * After an "ask" step is answered. The backend's resolvedQuestion wins over the person's own words, because it is
 * the full question ("What did I spend on groceries last month?") a later follow-up has to build on.
 */
export function afterAnswer(ctx: DialContext, r: { question: string; resolvedQuestion?: string }): DialContext {
  const q = (r.resolvedQuestion?.trim() || r.question.trim()).slice(0, MAX_QUESTION);
  return q ? { ...ctx, lastQuestion: q } : ctx;
}

/** The page and view the person is on now, as the runner sees them. */
export function withRoute(ctx: DialContext, route: DialRoute | null, mode: Mode): DialContext {
  return ctx.route === route && ctx.mode === mode ? ctx : { ...ctx, route, mode };
}

/** A step waiting for "yes" or "no", or null to clear it. Set by the runner, never by the planner. */
export const withPending = (ctx: DialContext, pending: DialStep | null): DialContext => ({ ...ctx, pending });

/**
 * The subject after a turn. A fresh request that names something replaces the subject; a follow-up ("what about
 * eating out?") keeps what it doesn't change. A category and a shop are two ways of saying what the conversation
 * is about, so naming one drops the other. Nothing named leaves the subject as it was.
 */
export function nextSubject(prev: DialSubject, said: DialSubject, followUp: boolean): DialSubject {
  if (!said.category && !said.merchant && !said.months?.length) return prev;
  const base: DialSubject = followUp ? { ...prev } : {};
  if (said.category) {
    base.category = said.category;
    delete base.merchant;
  }
  if (said.merchant) {
    base.merchant = said.merchant;
    delete base.category;
  }
  if (said.months?.length) base.months = [...said.months];
  return base;
}
