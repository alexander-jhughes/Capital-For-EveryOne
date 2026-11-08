// Turns a synthetic demo user into the two things the server stores: an account session and a profile record.
// Every event goes through the same validated functions the API routes use, so a demo user can't hold anything a real
// visitor couldn't. Throws if any event is refused: that is a bug in the seed file, caught by its tests.
import { DEMO_TODAY } from "../demo-clock";
import { applyGoals, applyPayment, applyPurchase, applySettings, deriveState, type Change } from "../server/account";
import { emptySession, type Session } from "../server/session";
import { emptyProfile, type ProfileRecord } from "../server/profile";
import { emptyUsage, USAGE_CAP } from "../profile/features";
import type { DemoUser } from "./users";

const must = <T extends object>(change: Change<T>, what: string): Session => {
  if (!change.ok) throw new Error(`Demo user event refused (${what}): ${change.message}`);
  return change.session;
};

export function buildDemoUser(user: DemoUser): { session: Session; profile: ProfileRecord } {
  let session = emptySession();
  const { payments = [], purchases = [], goals = [], spendPause } = user.events;

  purchases.forEach((p, i) => {
    session = must(applyPurchase(session, { id: `demo-${user.id}-buy-${i}`, merchant: p.merchant, item: p.item, amount: p.amount, createdAt: `${DEMO_TODAY}T09:00:00.000Z` }), "purchase");
  });
  payments.forEach((p, i) => {
    const { account } = deriveState(session);
    const amount = p.amount ?? (p.kind === "minimum" ? account.minimumPayment : p.kind === "statement" ? account.statementBalance : 0);
    session = must(applyPayment(session, { id: `demo-${user.id}-pay-${i}`, amount, kind: p.kind }), "payment");
  });
  if (goals.length) session = must(applyGoals(session, goals.map((spec, i) => ({ id: `demo-${user.id}-goal-${i}`, createdOn: DEMO_TODAY, spec }))), "goals");
  if (spendPause) session = must(applySettings(session, spendPause), "spend pause");

  const usage = { ...emptyUsage(), ...user.usage };
  for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] = Math.min(USAGE_CAP, Math.max(0, Math.floor(usage[k])));
  return {
    session,
    profile: { ...emptyProfile(), consent: true, sensitiveConsent: user.profile.sensitiveConsent, needs: user.profile.needs, usage },
  };
}
