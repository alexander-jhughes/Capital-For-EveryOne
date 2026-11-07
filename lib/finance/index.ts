// Deterministic finance layer. Pure functions, integer pence. The AI never does maths: every figure comes from here.
import { londonDate, londonTime } from "../demo-clock";
import { daysBetween } from "../format";
import type {
  Account,
  Category,
  ISODate,
  PauseDecision,
  PauseReason,
  Pence,
  PendingPurchase,
  SpendPauseSettings,
  Transaction,
} from "../types";

/** Purchases and refunds count as spending; card payments don't. */
const isSpending = (t: Transaction) => t.category !== "Payments";
const sum = (ts: Transaction[]) => ts.reduce((s, t) => s + t.amount, 0);

export const availableCredit = (a: Account): Pence => a.creditLimit - a.currentBalance;

export function billSummary(account: Account, today: ISODate) {
  return {
    statementBalance: account.statementBalance,
    minimumPayment: account.minimumPayment,
    paymentDueDate: account.paymentDueDate,
    daysUntilDue: daysBetween(today, account.paymentDueDate),
    currentBalance: account.currentBalance,
    creditLimit: account.creditLimit,
    availableCredit: availableCredit(account),
    apr: account.apr,
  };
}

/** Net spending between two dates, inclusive. Refunds reduce the total. */
export function spendingSummary(txns: Transaction[], from: ISODate, to: ISODate) {
  const inRange = txns.filter((t) => isSpending(t) && t.date >= from && t.date <= to);
  const byCat = new Map<Category, Pence>();
  for (const t of inRange) byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
  return {
    from,
    to,
    total: sum(inRange),
    count: inRange.filter((t) => t.amount > 0).length,
    refunds: -sum(inRange.filter((t) => t.amount < 0)),
    byCategory: [...byCat].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total),
  };
}

export function biggestItems(txns: Transaction[], n: number): Transaction[] {
  return txns
    .filter((t) => isSpending(t) && t.amount > 0)
    .sort((a, b) => b.amount - a.amount || b.date.localeCompare(a.date))
    .slice(0, n);
}

/** Net spend at one merchant (case-insensitive), refunds included. */
export function totalByMerchant(txns: Transaction[], merchant: string) {
  const m = merchant.toLowerCase();
  const matches = txns.filter((t) => isSpending(t) && t.merchant.toLowerCase() === m);
  return { merchant, total: sum(matches), count: matches.filter((t) => t.amount > 0).length };
}

/** Same merchant and same amount within 3 days. */
export function findPossibleDuplicates(txns: Transaction[]) {
  const spends = txns.filter((t) => isSpending(t) && t.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const out: { first: Transaction; second: Transaction; daysApart: number }[] = [];
  for (let i = 0; i < spends.length; i++) {
    for (let j = i + 1; j < spends.length; j++) {
      const daysApart = daysBetween(spends[i].date, spends[j].date);
      if (daysApart > 3) break;
      if (spends[i].merchant === spends[j].merchant && spends[i].amount === spends[j].amount)
        out.push({ first: spends[i], second: spends[j], daysApart });
    }
  }
  return out;
}

/** Months to clear the balance at a fixed monthly payment, plus total interest. An estimate: interest is monthly APR/12, no new spending. */
export function payoffEstimate(balance: Pence, apr: number, monthlyPayment: Pence) {
  const rate = apr / 100 / 12;
  let bal = balance;
  let months = 0;
  let totalInterest = 0;
  while (bal > 0) {
    const interest = Math.round(bal * rate);
    if (monthlyPayment <= interest || months >= 600) return { label: "estimate" as const, months: null, totalInterest: null };
    bal += interest - Math.min(monthlyPayment, bal + interest);
    totalInterest += interest;
    months++;
  }
  return { label: "estimate" as const, months, totalInterest };
}

export function monthToDateSpend(txns: Transaction[], today: ISODate): Pence {
  return spendingSummary(txns, `${today.slice(0, 8)}01`, today).total;
}

/** Time is "HH:MM"; quiet hours may wrap midnight. */
export function inQuietHours(time: string, q: { start: string; end: string }) {
  return q.start <= q.end ? time >= q.start && time < q.end : time >= q.start || time < q.end;
}

export function evaluatePurchase(
  account: Account,
  txns: Transaction[],
  settings: SpendPauseSettings,
  purchase: PendingPurchase,
  now: Date,
): PauseDecision {
  const mtd = monthToDateSpend(txns, londonDate(now));
  const balanceAfter = account.currentBalance + purchase.amount;
  const budgetRemainingAfter = settings.monthlyBudget === null ? null : settings.monthlyBudget - mtd - purchase.amount;

  const reasons: PauseReason[] = [];
  if (settings.enabled) {
    if (settings.singlePurchaseThreshold !== null && purchase.amount > settings.singlePurchaseThreshold) reasons.push("over_threshold");
    if (budgetRemainingAfter !== null && budgetRemainingAfter < 0) reasons.push("over_budget");
    if (settings.quietHours && inQuietHours(londonTime(now), settings.quietHours)) reasons.push("quiet_hours");
  }

  return {
    shouldPause: reasons.length > 0,
    reasons,
    balanceAfter,
    availableCreditAfter: account.creditLimit - balanceAfter,
    budgetRemainingAfter,
  };
}
