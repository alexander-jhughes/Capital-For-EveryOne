import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT } from "../data/seed";
import type { Account, Payment } from "../types";
import { creditHealth, creditSummary, isCreditBuildingQuestion, percentOf, UTILISATION_GUIDE } from "./credit";

const today = "2026-11-08";
const pay = (amount: number): Payment => ({ id: `p${amount}`, amount, date: today, kind: "custom" });
const after = (paid: number): Account => ({ ...SEED_ACCOUNT, currentBalance: SEED_ACCOUNT.currentBalance - paid });

describe("credit health from the demo account", () => {
  const h = creditHealth(SEED_ACCOUNT, [], today);

  it("works out use of the limit exactly", () => {
    expect(h.limit).toBe(150000);
    expect(h.balance).toBe(106989);
    expect(h.usedPercent).toBe(71); // 1,069.89 / 1,500
    expect(h.payToGuide).toBe(106989 - 37500); // down to 25% = £375.00
    expect(h.usedAfterBill).toBe(39); // (1,069.89 - 486.20) / 1,500 = 38.9%
  });

  it("lists the four habits with plain, exact sentences", () => {
    expect(h.habits.map((x) => [x.id, x.status])).toEqual([
      ["on-time", "to-do"],
      ["low-use", "to-do"],
      ["more-than-minimum", "to-do"],
      ["under-limit", "on-track"],
    ]);
    expect(h.habits[0].detail).toContain("£25.00 is due in 5 days");
    expect(h.habits[1].next).toBe("Paying your full bill of £486.20 would bring it to 39%. Paying £694.89 would bring it to 25%.");
    expect(h.habits[3].detail).toBe("You have £430.11 of your limit left.");
    expect(h.onTrack).toBe(1);
  });

  it("gives Dial one next step, from these figures only", () => {
    expect(creditSummary(h)).toBe("You're on track with 1 of 4 credit-building habits. Next: Pay at least £25.00 before the due date.");
  });
});

describe("the coach updates as soon as someone pays", () => {
  it("minimum paid: on time is done", () => {
    const h = creditHealth(after(2500), [pay(2500)], today);
    expect(h.habits[0].status).toBe("done");
    expect(h.habits[2].status).toBe("to-do");
  });
  it("more than the minimum: on track", () => {
    const h = creditHealth(after(10000), [pay(10000)], today);
    expect(h.habits[2].status).toBe("on-track");
  });
  it("full bill paid: no interest on it, and use drops", () => {
    const h = creditHealth(after(48620), [pay(48620)], today);
    expect(h.habits[2].status).toBe("done");
    expect(h.usedPercent).toBe(39);
    expect(h.onTrack).toBe(3);
  });
  it("paid down to the guide: low use is done", () => {
    const h = creditHealth(after(69489), [pay(69489)], today);
    expect(h.usedPercent).toBe(UTILISATION_GUIDE);
    expect(h.habits[1].status).toBe("done");
    expect(h.onTrack).toBe(4);
  });
});

describe("edge cases", () => {
  it("flags a missed due date and an over-limit balance, calmly", () => {
    const h = creditHealth({ ...SEED_ACCOUNT, currentBalance: 160000 }, [], "2026-11-15");
    expect(h.habits[0]).toMatchObject({ status: "needs-attention" });
    expect(h.habits[0].detail).toContain("was due 2 days ago");
    expect(h.habits[3]).toMatchObject({ status: "needs-attention", next: "Paying £100.00 would bring you back under it." });
  });
  it("never divides by zero or goes negative", () => {
    expect(percentOf(100, 0)).toBe(0);
    expect(percentOf(-5, 100)).toBe(0);
  });
  it("never predicts or mentions a credit score number", () => {
    for (const x of creditHealth(SEED_ACCOUNT, [], today).habits) expect(`${x.detail} ${x.next ?? ""}`).not.toMatch(/score|points/i);
  });
});

describe("which questions the credit coach answers", () => {
  it("answers credit-building questions, and leaves limit and balance questions to the money code", () => {
    for (const q of ["How can I build my credit?", "how's my credit", "how do I improve my credit score?", "how much of my limit am I using"]) expect(isCreditBuildingQuestion(q), q).toBe(true);
    for (const q of ["what's my credit limit", "what's my available credit", "how much do I owe", "did I pay Tesco twice"]) expect(isCreditBuildingQuestion(q), q).toBe(false);
  });
});
