// Goal kinds added by the product workstream: pay_down, utilisation, save_up, pay_on_time.
import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_NOW, DEMO_TODAY } from "../demo-clock";
import { INITIAL_SPEND_PAUSE } from "../demo-config";
import type { Goal, GoalSpec } from "../dial/types";
import type { InsightContext } from "../insights";
import { accountAfterPayments, paymentTransaction } from "../payments/rules";
import { decodeSession, emptySession, encodeSession } from "../server/session";
import type { Payment } from "../types";
import { describeGoal } from "./describe";
import { goalHistory, goalMilestones, goalProgress } from "./progress";
import { MAX_GOAL_LOG, sanitizeGoals, sanitizeSpec, updateGoal, withSaved } from "./store";

const seed: InsightContext = { account: SEED_ACCOUNT, txns: SEED_TRANSACTIONS, settings: INITIAL_SPEND_PAUSE, today: DEMO_TODAY };
const goal = (spec: GoalSpec, createdOn = DEMO_TODAY): Goal => ({ id: "g-1", spec, createdOn });
const START = SEED_ACCOUNT.currentBalance;
/** The seed account after paying `amount` in the app today. */
function afterPaying(amount: number): InsightContext {
  const p: Payment = { id: "pay-test-0001", amount, date: DEMO_TODAY, kind: "custom" };
  return { ...seed, account: accountAfterPayments(SEED_ACCOUNT, [p]), txns: [...SEED_TRANSACTIONS, paymentTransaction(p)] };
}

const payDown: GoalSpec = { kind: "pay_down", target: 50000, by: "2027-01", startBalance: START };
const util: GoalSpec = { kind: "utilisation", percent: 30, by: "2027-03", startBalance: START };
const fund: GoalSpec = { kind: "save_up", purpose: "emergency", target: 100000, by: "2027-04", saved: 25000, log: [["2026-11-08", 25000]] };
const laptop: GoalSpec = { kind: "save_up", purpose: "purchase", target: 60000, by: "2027-02", saved: 0, log: [], label: "A new laptop" };

describe("sanitizeSpec for the new kinds", () => {
  it("keeps valid specs exactly", () => {
    for (const s of [payDown, util, fund, laptop, { kind: "pay_on_time" } as GoalSpec, { ...payDown, target: 0 }]) expect(sanitizeSpec(s)).toEqual(s);
  });
  it("refuses impossible or unsafe values", () => {
    const bad: unknown[] = [
      { ...payDown, target: START },
      { ...payDown, target: -1 },
      { ...payDown, by: "2027-13" },
      { ...util, percent: 0 },
      { ...util, percent: 101 },
      { ...util, percent: 12.5 },
      { ...fund, purpose: "holiday" },
      { ...fund, target: 0 },
      { ...fund, saved: -5 },
      { ...fund, log: Array.from({ length: MAX_GOAL_LOG + 1 }, () => ["2026-11-08", 1]) },
      { ...fund, log: [["yesterday", 1]] },
      { ...laptop, label: "<script>alert(1)</script>" },
      { ...laptop, label: "x".repeat(25) },
    ];
    for (const b of bad) expect(sanitizeSpec(b)).toBeNull();
  });
  it("drops unknown fields and an empty label", () => {
    expect(sanitizeSpec({ ...laptop, label: "  ", extra: 1 })).toEqual({ kind: "save_up", purpose: "purchase", target: 60000, by: "2027-02", saved: 0, log: [] });
  });
});

describe("editing goals", () => {
  it("replaces a spec in place, keeping the id and start date", () => {
    const goals = [goal(payDown, "2026-11-01")];
    const r = updateGoal(goals, "g-1", { ...payDown, target: 40000 });
    expect(r.ok && r.goals).toEqual([{ id: "g-1", createdOn: "2026-11-01", spec: { ...payDown, target: 40000 } }]);
    expect(updateGoal(goals, "g-2", payDown).ok).toBe(false);
    expect(updateGoal(goals, "g-1", { ...payDown, target: -1 }).ok).toBe(false);
  });
  it("logs saved-amount updates, one per day, keeping the last few", () => {
    let s = fund as Extract<GoalSpec, { kind: "save_up" }>;
    s = withSaved(s, 30000, "2026-11-08") as typeof s;
    expect(s.log).toEqual([["2026-11-08", 30000]]);
    for (let d = 10; d < 20; d++) s = withSaved(s, 30000 + d, `2026-11-${d}`) as typeof s;
    expect(s.log).toHaveLength(MAX_GOAL_LOG);
    expect(s.log.at(-1)).toEqual(["2026-11-19", 30019]);
    expect(sanitizeSpec(s)).toEqual(s);
  });
});

describe("progress for the new kinds", () => {
  it("pay_down: measured from the real balance, and it moves with a payment", () => {
    const before = goalProgress(goal(payDown), seed);
    expect(before.percent).toBe(0);
    expect(before.status).toBe("on_track");
    const after = goalProgress(goal(payDown), afterPaying(20000));
    // Paid £200 of the £569.89 between £1,069.89 and £500.
    expect(after.percent).toBe(Math.round((20000 * 100) / (START - 50000)));
    expect(after.statement).toContain("down £200.00");
    expect(goalProgress(goal(payDown), afterPaying(START - 40000)).status).toBe("met");
  });
  it("pay_down: a missed date says so without blame, and a rising balance needs a look", () => {
    expect(goalProgress(goal({ ...payDown, by: "2026-10" }), seed).status).toBe("missed");
    expect(goalProgress(goal({ ...payDown, startBalance: START - 10000 }), seed).status).toBe("at_risk");
  });
  it("utilisation: says the share used and the balance to aim for", () => {
    const p = goalProgress(goal(util), seed);
    expect(p.statement).toContain("You're using 71% of your limit.");
    expect(p.statement).toContain("£450.00");
    expect(goalProgress(goal(util), afterPaying(START - 45000)).status).toBe("met");
  });
  it("save_up: uses the amount the person entered, and the monthly figure always gets there", () => {
    const p = goalProgress(goal(fund), seed);
    expect(p.percent).toBe(25);
    expect(p.limitations[0]).toMatch(/can't see your savings account/);
    // £750 over Nov to Apr (6 months) = £125 a month.
    expect(p.statement).toContain("about £125.00 a month");
    expect(goalProgress(goal({ ...fund, saved: 100000 }), seed).status).toBe("met");
    expect(goalProgress(goal({ ...fund, by: "2026-10" }), seed).status).toBe("missed");
  });
  it("pay_on_time: the minimum is covered by a payment made in the app, and not before", () => {
    expect(goalProgress(goal({ kind: "pay_on_time" }), seed).status).toBe("on_track");
    expect(goalProgress(goal({ kind: "pay_on_time" }), afterPaying(1000)).statement).toContain("£15.00 is due");
    expect(goalProgress(goal({ kind: "pay_on_time" }), afterPaying(SEED_ACCOUNT.minimumPayment)).status).toBe("met");
  });
  it("every new kind has a plain title and whole-number percent", () => {
    for (const s of [payDown, util, fund, laptop, { kind: "pay_on_time" } as GoalSpec]) {
      const p = goalProgress(goal(s), seed);
      expect(p.title).toBe(describeGoal(s, DEMO_TODAY));
      if (p.percent !== null) expect(Number.isInteger(p.percent)).toBe(true);
    }
    expect(describeGoal({ ...payDown, target: 0 })).toBe("Pay off your card balance by the end of January 2027");
    expect(describeGoal(laptop)).toBe("Save £600 for A new laptop by the end of February 2027");
  });
});

describe("milestones and history", () => {
  it("marks the quarter milestones reached", () => {
    expect(goalMilestones(null)).toEqual([]);
    expect(goalMilestones(60).filter((m) => m.reached).map((m) => m.at)).toEqual([25, 50]);
    expect(goalMilestones(100).every((m) => m.reached)).toBe(true);
  });
  it("lists payments since the goal was set, and saving updates newest first", () => {
    expect(goalHistory(goal(payDown, DEMO_TODAY), afterPaying(5000))).toEqual([{ date: DEMO_TODAY, text: "Payment of £50.00" }]);
    // The seed's October payment is before the goal, so it isn't progress towards it.
    expect(goalHistory(goal(payDown, DEMO_TODAY), seed)).toEqual([]);
    const s = withSaved(fund as Extract<GoalSpec, { kind: "save_up" }>, 30000, "2026-11-09");
    expect(goalHistory(goal(s), seed).map((h) => h.date)).toEqual(["2026-11-09", "2026-11-08"]);
  });
});

describe("the session cookie keeps the new kinds", () => {
  it("round-trips every new kind, and the server's goal check accepts them", () => {
    const secret = Buffer.from("a-test-secret-that-is-long-enough-to-count");
    const now = DEMO_NOW.getTime();
    const goals: Goal[] = [payDown, util, fund, laptop, { kind: "pay_on_time" }].map((spec, i) => ({ id: `g-${i}`, spec: spec as GoalSpec, createdOn: DEMO_TODAY }));
    const session = { ...emptySession(), goals };
    expect(sanitizeGoals(goals)).toEqual(goals);
    expect(decodeSession(encodeSession(session, secret, now), secret, now)).toEqual(session);
  });
});
