import { describe, expect, it } from "vitest";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "../data/seed";
import { DEMO_TODAY } from "../demo-clock";
import { formatLongDate, formatPence } from "../format";
import type { Account, Category, SpendPauseSettings, Transaction } from "../types";
import {
  INSIGHT_ID,
  INSIGHT_KINDS,
  buildInsights,
  categoryChange,
  insightById,
  monthPeriods,
  periodLabel,
  recurring,
  spendingChange,
  unusual,
  upcomingObligations,
  weekBuckets,
  type Insight,
  type InsightContext,
  type InsightReport,
} from "./index";

const SETTINGS: SpendPauseSettings = { enabled: true, singlePurchaseThreshold: 10000, monthlyBudget: 50000, quietHours: null };
const seed: InsightContext = { account: SEED_ACCOUNT, txns: SEED_TRANSACTIONS, settings: SETTINGS, today: DEMO_TODAY };
const ESTIMATE = "Based on past charges; Dial can't see future bills.";

// Independent arithmetic, straight from the transactions.
const spendTxns = (txns: Transaction[], from: string, to: string, category?: Category, merchant?: string) =>
  txns.filter((t) => t.category !== "Payments" && t.date >= from && t.date <= to && (!category || t.category === category) && (!merchant || t.merchant === merchant));
const spend = (...args: Parameters<typeof spendTxns>) => spendTxns(...args).reduce((s, t) => s + t.amount, 0);
const NOV: [string, string] = ["2026-11-01", "2026-11-08"];
const OCT: [string, string] = ["2026-10-01", "2026-10-08"];

let n = 0;
const tx = (date: string, merchant: string, amount: number, category: Category = "Shopping", status: Transaction["status"] = "posted"): Transaction => ({
  id: `x${++n}`,
  date,
  merchant,
  amount,
  category,
  status,
});
const ctxOf = (txns: Transaction[], over: Partial<InsightContext> = {}): InsightContext => ({ ...seed, txns, ...over });
const ids = (r: InsightReport) => r.insights.map((i) => i.id);
const get = (ctx: InsightContext, id: string) => {
  const found = insightById(ctx, id);
  expect(found, id).not.toBeNull();
  return found as Insight;
};

describe("periods", () => {
  it("labels periods in plain words", () => {
    expect(periodLabel("2026-11-01", "2026-11-08")).toBe("1 to 8 November");
    expect(periodLabel("2026-09-28", "2026-10-04")).toBe("28 September to 4 October");
    expect(periodLabel("2026-11-08", "2026-11-08")).toBe("8 November");
  });

  it("compares this month so far with the same days last month", () => {
    const p = monthPeriods("2026-11-08");
    expect(p.current).toEqual({ from: "2026-11-01", to: "2026-11-08", label: "1 to 8 November" });
    expect(p.previous).toEqual({ from: "2026-10-01", to: "2026-10-08", label: "1 to 8 October" });
    expect(p.previousMonth).toEqual({ from: "2026-10-01", to: "2026-10-31", label: "1 to 31 October" });
    expect(monthPeriods("2026-01-15").previous).toEqual({ from: "2025-12-01", to: "2025-12-15", label: "1 to 15 December" });
    expect(monthPeriods("2026-03-31").previous.to).toBe("2026-02-28");
  });

  it("buckets full Monday to Sunday weeks over the seed history", () => {
    const weeks = weekBuckets(seed);
    expect(weeks.map((w) => w.period.label)).toEqual([
      "28 September to 4 October",
      "5 to 11 October",
      "12 to 18 October",
      "19 to 25 October",
      "26 October to 1 November",
      "2 to 8 November",
    ]);
    for (const w of weeks) expect(w.total).toBe(spend(SEED_TRANSACTIONS, w.period.from, w.period.to));
    expect(weeks.reduce((s, w) => s + w.total, 0)).toBe(spend(SEED_TRANSACTIONS, "2026-09-28", "2026-11-08"));
    // On Saturday the current week isn't full yet, so it's left out.
    expect(weekBuckets({ ...seed, today: "2026-11-07" }).at(-1)?.period.label).toBe("26 October to 1 November");
  });
});

describe("seed insights", () => {
  const nov = spend(SEED_TRANSACTIONS, ...NOV);
  const oct = spend(SEED_TRANSACTIONS, ...OCT);

  it("supports every kind, in a fixed order, with nothing left unexplained", () => {
    const report = buildInsights(seed);
    expect(ids(report)).toEqual([
      "spending_change",
      "category_change:Groceries",
      "category_change:Travel",
      "category_change:Eating out",
      "category_change:Shopping",
      "category_change:Transport",
      "category_change:Subscriptions",
      "top_categories",
      "recurring:Spotify",
      "recurring:Netflix",
      "unusual:Argos",
      "weekly_trend",
      "budget_progress",
      "position_after_payments",
      "upcoming_obligation",
      "saving_observation:Regular charges",
      "saving_observation:Eating out",
      "saving_observation:Shopping",
    ]);
    expect(report.cannotEstablish).toEqual([]);
  });

  it("spending_change: November so far against the same days of October, by contribution", () => {
    const i = get(seed, "spending_change");
    const groceries = spend(SEED_TRANSACTIONS, ...NOV, "Groceries") - spend(SEED_TRANSACTIONS, ...OCT, "Groceries");
    const travel = spend(SEED_TRANSACTIONS, ...NOV, "Travel") - spend(SEED_TRANSACTIONS, ...OCT, "Travel");
    expect(i.statement).toBe(
      `You've spent ${formatPence(nov)} from 1 to 8 November, ${formatPence(nov - oct)} more than the ${formatPence(oct)} you spent from 1 to 8 October; ` +
        `most of the increase came from Groceries (${formatPence(groceries)} more) and Travel (${formatPence(travel)} more).`,
    );
    expect(i.title).toBe("Spending is up");
    expect(i.confidence).toBe("medium");
    expect(i.limitations).toEqual(["November so far covers 8 days.", "Includes 3 pending items."]);
    expect(new Set(i.evidenceIds)).toEqual(new Set([...spendTxns(SEED_TRANSACTIONS, ...NOV), ...spendTxns(SEED_TRANSACTIONS, ...OCT)].map((t) => t.id)));
    expect(i.periods?.current.label).toBe("1 to 8 November");
    expect(i.periods?.previous?.label).toBe("1 to 8 October");
  });

  it("category_change: the shops behind a category's change, and a category that's new", () => {
    const g = get(seed, "category_change:Groceries");
    const tesco = spend(SEED_TRANSACTIONS, ...NOV, "Groceries", "Tesco") - spend(SEED_TRANSACTIONS, ...OCT, "Groceries", "Tesco");
    expect(g.statement).toContain(`£183.53 on Groceries`);
    expect(g.statement).toContain(`most of the increase came from Tesco (${formatPence(tesco)} more)`);
    expect(g.subject).toBe("Groceries");

    const travel = get(seed, "category_change:Travel");
    expect(travel.statement).toBe(`You've spent ${formatPence(spend(SEED_TRANSACTIONS, ...NOV, "Travel"))} on Travel from 1 to 8 November, and nothing on it from 1 to 8 October.`);
    expect(travel.title).toBe("New spending on Travel");

    expect(categoryChange(seed, "Payments")).toEqual({ insights: [], cannotEstablish: ["Card payments aren't counted as spending."] });
  });

  it("top_categories: the three biggest this month", () => {
    const totals = new Map<string, number>();
    for (const t of spendTxns(SEED_TRANSACTIONS, ...NOV)) totals.set(t.category, (totals.get(t.category) ?? 0) + t.amount);
    const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 3);
    expect(get(seed, "top_categories").statement).toBe(
      `Of the ${formatPence(nov)} you've spent from 1 to 8 November, the most went on ${top[0][0]} (${formatPence(top[0][1])}), ${top[1][0]} (${formatPence(top[1][1])}) and ${top[2][0]} (${formatPence(top[2][1])}).`,
    );
  });

  it("recurring: Spotify and Netflix, with Netflix's rise and estimated next dates", () => {
    const netflix = get(seed, "recurring:Netflix");
    expect(netflix.statement).toBe("Netflix charges £12.99 about once a month, up from £10.99 (2 charges so far); the next charge is estimated around Friday 4 December.");
    expect(netflix.title).toBe("Netflix price went up");
    expect(netflix.figures.find((f) => f.unit === "date")?.value).toBe("2026-12-04");
    expect(netflix.evidenceIds).toEqual(SEED_TRANSACTIONS.filter((t) => t.merchant === "Netflix").map((t) => t.id));
    expect(netflix.confidence).toBe("medium");
    expect(netflix.limitations).toContain(ESTIMATE);
    expect(get(seed, "recurring:Spotify").statement).toContain("£11.99 about once a month (2 charges so far)");
  });

  it("unusual: only Argos, against the person's own usual Shopping charge", () => {
    const others = SEED_TRANSACTIONS.filter((t) => t.category === "Shopping" && t.amount > 0 && t.merchant !== "Argos").map((t) => t.amount).sort((a, b) => a - b);
    expect(others).toHaveLength(5);
    const i = get(seed, "unusual:Argos");
    expect(i.statement).toBe(`The £249.00 charge at Argos on Saturday 10 October is larger than your usual in Shopping (about ${formatPence(others[2])}).`);
    expect(i.evidenceIds[0]).toBe("t060");
    expect(ids(unusual(seed))).toEqual(["unusual:Argos"]);
  });

  it("weekly_trend: the latest full week against the one before", () => {
    const last = spend(SEED_TRANSACTIONS, "2026-11-02", "2026-11-08");
    const prev = spend(SEED_TRANSACTIONS, "2026-10-26", "2026-11-01");
    expect(get(seed, "weekly_trend").statement).toContain(`You spent ${formatPence(last)} from 2 to 8 November, ${formatPence(last - prev)} more than the week before (${formatPence(prev)})`);
  });

  it("budget_progress, position_after_payments and upcoming_obligation come from the account and budget", () => {
    expect(get(seed, "budget_progress").statement).toBe(`You've spent ${formatPence(nov)} of your £500.00 monthly budget from 1 to 8 November (80%), leaving ${formatPence(50000 - nov)}.`);
    const position = get(seed, "position_after_payments");
    expect(position.statement).toBe(
      `Your balance is ${formatPence(SEED_ACCOUNT.currentBalance)}, with ${formatPence(SEED_ACCOUNT.creditLimit - SEED_ACCOUNT.currentBalance)} of credit available; £486.20 of your statement balance is left to pay, and your last payment was £180.00 on Thursday 15 October.`,
    );
    expect(position.evidenceIds).toEqual(["t022"]);
    expect(get(seed, "upcoming_obligation").statement).toBe("Your statement balance of £486.20 is due on Friday 13 November, in 5 days, and the minimum payment is £25.00.");
    // Spotify and Netflix next charge in December, after the bill.
    expect(ids(upcomingObligations(seed))).toEqual(["upcoming_obligation"]);
  });

  it("saving_observation: regular charges and discretionary rises, as facts", () => {
    const latest = (m: string) => SEED_TRANSACTIONS.filter((t) => t.merchant === m).at(-1)!.amount;
    expect(get(seed, "saving_observation:Regular charges").statement).toBe(`Your 2 regular monthly charges, from Spotify and Netflix, come to ${formatPence(latest("Spotify") + latest("Netflix"))} a month.`);
    const eating = spend(SEED_TRANSACTIONS, ...NOV, "Eating out") - spend(SEED_TRANSACTIONS, ...OCT, "Eating out");
    expect(get(seed, "saving_observation:Eating out").statement).toContain(`${formatPence(eating)} more than the same days in October`);
  });
});

describe("edge cases", () => {
  const payment = (id: string, date: string, amount: number): Transaction => ({ id, date, merchant: "Payment received", amount: -amount, category: "Payments", status: "pending" });

  it("an empty account still has its balance and bill, and explains the rest", () => {
    const r = buildInsights(ctxOf([]));
    expect(ids(r)).toEqual(["budget_progress", "position_after_payments", "upcoming_obligation"]);
    expect(r.cannotEstablish).toEqual([
      "There's no spending from 1 to 8 November or 1 to 8 October to compare.",
      "There's no spending from 1 to 8 November yet.",
      "No regular charges were found.",
      "There isn't enough history yet to tell what's usual for you.",
      "There isn't enough history yet for a week-by-week view.",
    ]);
    expect(get(ctxOf([]), "budget_progress").statement).toContain("You've spent £0.00 of your £500.00");
  });

  it("an account with only payments has no spending", () => {
    const ctx = ctxOf([payment("p1", "2026-10-02", 5000), payment("p2", "2026-11-03", 9000)]);
    expect(spendingChange(ctx).insights).toEqual([]);
    expect(get(ctx, "budget_progress").statement).toContain("You've spent £0.00");
  });

  it("a refund reduces spending", () => {
    const ctx = ctxOf([tx("2026-10-01", "Amazon", 3000), tx("2026-11-02", "Amazon", 5000), tx("2026-11-04", "Amazon", -2000)]);
    const i = get(ctx, "spending_change");
    expect(i.statement).toBe("You've spent £30.00 from 1 to 8 November, the same as the £30.00 you spent from 1 to 8 October.");
    expect(i.title).toBe("Spending is the same");
  });

  it("pending items count and are labelled", () => {
    const ctx = ctxOf([tx("2026-10-01", "Tesco", 1000, "Groceries"), tx("2026-11-03", "Tesco", 1500, "Groceries", "pending")]);
    const i = get(ctx, "spending_change");
    expect(i.statement).toContain("You've spent £15.00 from 1 to 8 November, £5.00 more");
    expect(i.limitations).toContain("Includes 1 pending item.");
  });

  it("a partial payment and a full payment, from the account figures", () => {
    const paid = (amount: number): InsightContext => {
      const account: Account = {
        ...SEED_ACCOUNT,
        currentBalance: SEED_ACCOUNT.currentBalance - amount,
        statementBalance: SEED_ACCOUNT.statementBalance - amount,
        minimumPayment: Math.min(SEED_ACCOUNT.minimumPayment, SEED_ACCOUNT.statementBalance - amount),
        lastPayment: { amount, date: "2026-11-08" },
      };
      return { ...seed, account, txns: [...SEED_TRANSACTIONS, payment("pay-1", "2026-11-08", amount)] };
    };
    const partial = paid(10000);
    const position = get(partial, "position_after_payments");
    expect(position.statement).toContain("£386.20 of your statement balance is left to pay, and your last payment was £100.00 on Sunday 8 November");
    expect(position.evidenceIds).toEqual(["pay-1"]);
    expect(position.limitations).toEqual(["Includes 1 pending item."]);
    expect(get(partial, "upcoming_obligation").statement).toContain("Your statement balance of £386.20 is due");

    const full = paid(SEED_ACCOUNT.statementBalance);
    expect(get(full, "position_after_payments").statement).toContain("your statement balance is paid in full");
    expect(get(full, "upcoming_obligation").statement).toBe("Your statement balance is paid, so nothing more is due on Friday 13 November.");
  });

  it("a category with no spending in the previous period doesn't divide by zero", () => {
    const ctx = ctxOf([tx("2026-10-01", "Tesco", 2000, "Groceries"), tx("2026-11-03", "Trainline", 5000, "Travel")]);
    const i = only(categoryChange(ctx, "Travel"));
    expect(i.statement).toBe("You've spent £50.00 on Travel from 1 to 8 November, and nothing on it from 1 to 8 October.");
    expect(i.figures.every((f) => typeof f.value !== "number" || Number.isFinite(f.value))).toBe(true);
    expect(categoryChange(ctx, "Shopping").cannotEstablish).toEqual(["There's no Shopping spending from 1 to 8 November or 1 to 8 October to compare."]);
  });

  it("history that doesn't reach the previous period can't be compared", () => {
    expect(spendingChange(ctxOf([tx("2026-11-03", "Tesco", 2000, "Groceries")])).cannotEstablish).toEqual(["There's no history from 1 to 8 October to compare with."]);
  });

  it("a full month against a shorter one says so", () => {
    const ctx = ctxOf([tx("2026-02-01", "Tesco", 2000, "Groceries"), tx("2026-03-30", "Tesco", 3000, "Groceries")], { today: "2026-03-31" });
    const i = only(spendingChange(ctx));
    expect(i.confidence).toBe("high");
    expect(i.limitations).toEqual(["February has only 28 days."]);
  });

  it("no monthly budget: no budget insight, and the reason", () => {
    const ctx = { ...seed, settings: { ...SETTINGS, monthlyBudget: null } };
    expect(insightById(ctx, "budget_progress")).toBeNull();
    expect(buildInsights(ctx).cannotEstablish).toEqual(["You haven't set a monthly budget."]);
  });

  it("over budget, and a budget Spend Pause isn't checking", () => {
    const over = get({ ...seed, settings: { ...SETTINGS, monthlyBudget: 30000, enabled: false } }, "budget_progress");
    expect(over.title).toBe("Over your monthly budget");
    expect(over.statement).toBe("You've spent £402.35 from 1 to 8 November, £102.35 over your £300.00 monthly budget.");
    expect(over.limitations).toContain("Spend Pause is off, so purchases aren't checked against this budget.");
  });

  it("recurring needs a repeat: one charge, a lapsed pattern and an irregular one are not recurring", () => {
    expect(recurring(ctxOf([tx("2026-11-01", "Spotify", 1199, "Subscriptions")]))).toEqual({ insights: [], cannotEstablish: ["No regular charges were found."] });
    expect(ids(recurring(ctxOf([tx("2026-08-01", "Gym", 3000), tx("2026-09-01", "Gym", 3000)])))).toEqual([]);
    expect(ids(recurring(ctxOf([tx("2026-10-01", "Gym", 3000), tx("2026-10-12", "Gym", 3000), tx("2026-11-01", "Gym", 3000)])))).toEqual([]);
    expect(ids(recurring(ctxOf([tx("2026-10-01", "Gym", 3000), tx("2026-11-01", "Gym", 9000)])))).toEqual([]);
  });

  it("weekly recurring charges, and a charge expected before the bill", () => {
    const weekly = ctxOf([tx("2026-10-20", "Gym", 500), tx("2026-10-27", "Gym", 500), tx("2026-11-03", "Gym", 500)]);
    expect(get(weekly, "recurring:Gym").statement).toBe("Gym charges £5.00 about once a week (3 charges so far); the next charge is estimated around Tuesday 10 November.");
    const soon = get(weekly, "upcoming_obligation:Gym");
    expect(soon.statement).toBe("From past charges, Gym may charge about £5.00 around Tuesday 10 November, before your bill is due on Friday 13 November.");
    expect(soon.confidence).toBe("medium");
    expect(soon.limitations).toEqual([ESTIMATE]);
    // Weekly charges aren't added up as a monthly figure.
    expect(insightById(weekly, "saving_observation:Regular charges")).toBeNull();
  });

  it("unusual needs history, and compares with the shop first", () => {
    const thin = ctxOf([tx("2026-10-02", "Amazon", 1500), tx("2026-10-09", "Amazon", 2000), tx("2026-10-10", "Argos", 24900)]);
    expect(unusual(thin)).toEqual({ insights: [], cannotEstablish: ["There isn't enough history yet to tell what's usual for you."] });

    const shop = ctxOf(["2026-10-01", "2026-10-08", "2026-10-15"].map((d, i) => tx(d, "Tesco", [2000, 2100, 1900][i], "Groceries")).concat(tx("2026-11-03", "Tesco", 9000, "Groceries", "pending")));
    const i = get(shop, "unusual:Tesco");
    expect(i.statement).toBe("The £90.00 charge at Tesco on Tuesday 3 November is larger than your usual at Tesco (about £20.00).");
    expect(i.limitations).toEqual(["Compared only with your own 3 other charges at Tesco.", "This charge is still pending."]);
  });

  it("payments never change spending figures", () => {
    const withPayments = ctxOf([...SEED_TRANSACTIONS, payment("p-big", "2026-11-02", 50000), payment("p-oct", "2026-10-03", 1000)]);
    const spendingKinds = new Set(["spending_change", "category_change", "top_categories", "recurring", "unusual", "weekly_trend", "budget_progress", "saving_observation"]);
    const pick = (ctx: InsightContext) => buildInsights(ctx).insights.filter((i) => spendingKinds.has(i.kind));
    expect(pick(withPayments)).toEqual(pick(seed));
  });
});

const only = (r: InsightReport) => {
  expect(r.insights).toHaveLength(1);
  return r.insights[0];
};

describe("every insight follows the contract", () => {
  const BANNED = /\b(because|due to|caus\w*|suspicious\w*|fraud\w*|risk\w*|should|must|ought|credit scores?|credit rating|eligib\w*|approv\w*|scam\w*|accus\w*|recommend\w*|advi[sc]e\w*|why)\b/i;
  const upTo = (today: string) => SEED_TRANSACTIONS.filter((t) => t.date <= today);
  const contexts: [string, InsightContext][] = [
    ["seed", seed],
    ["seed, no budget", { ...seed, settings: { ...SETTINGS, monthlyBudget: null } }],
    ["seed, over budget", { ...seed, settings: { ...SETTINGS, monthlyBudget: 30000 } }],
    ["seed on 1 November", ctxOf(upTo("2026-11-01"), { today: "2026-11-01" })],
    ["seed on 31 October", ctxOf(upTo("2026-10-31"), { today: "2026-10-31" })],
    ["seed on 20 October", ctxOf(upTo("2026-10-20"), { today: "2026-10-20" })],
    ["empty", ctxOf([])],
    ["weekly gym", ctxOf([tx("2026-10-20", "Gym", 500), tx("2026-10-27", "Gym", 500), tx("2026-11-03", "Gym", 500)])],
    ["spending down", ctxOf([tx("2026-10-01", "Tesco", 9000, "Groceries"), tx("2026-10-03", "Deliveroo", 3000, "Eating out"), tx("2026-11-02", "Tesco", 1000, "Groceries")])],
    ["paid in full", { ...seed, account: { ...SEED_ACCOUNT, statementBalance: 0, minimumPayment: 0, currentBalance: SEED_ACCOUNT.currentBalance - 48620 } }],
  ];

  it.each(contexts)("%s", (_, ctx) => {
    const report = buildInsights(ctx);
    const known = new Set(ctx.txns.map((t) => t.id));
    expect(new Set(ids(report)).size).toBe(report.insights.length);
    expect(report.insights.map((i) => INSIGHT_KINDS.indexOf(i.kind))).toEqual(report.insights.map((i) => INSIGHT_KINDS.indexOf(i.kind)).sort((a, b) => a - b));

    for (const i of report.insights) {
      expect(i.id, i.id).toMatch(INSIGHT_ID);
      expect(i.id).toBe(i.subject ? `${i.kind}:${i.subject}` : i.kind);
      for (const f of i.figures) {
        expect(i.statement, `${i.id}: ${f.display}`).toContain(f.display);
        if (f.unit === "pence") expect(f.display).toBe(formatPence(f.value as number));
        if (f.unit === "date") expect(f.display).toBe(formatLongDate(f.value as string));
        if (f.unit === "percent") expect(f.display).toBe(`${f.value}%`);
      }
      const displays = new Set(i.figures.map((f) => f.display));
      for (const m of i.statement.match(/-?£[\d,]+\.\d{2}|\d+%/g) ?? []) expect(displays, `${i.id}: ${m}`).toContain(m);
      for (const d of i.statement.match(/(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2} [A-Z][a-z]+/g) ?? []) expect(displays, `${i.id}: ${d}`).toContain(d);

      expect(new Set(i.evidenceIds).size).toBe(i.evidenceIds.length);
      for (const e of i.evidenceIds) expect(known, `${i.id}: ${e}`).toContain(e);
      // Account-level facts, and a budget with nothing spent yet, have no transactions behind them.
      if (!["position_after_payments", "upcoming_obligation"].includes(i.id) && !i.statement.includes("spent £0.00")) expect(i.evidenceIds.length, i.id).toBeGreaterThan(0);

      for (const text of [i.title, i.statement, ...i.limitations]) {
        expect(text, i.id).not.toMatch(BANNED);
        expect(text, i.id).not.toMatch(/NaN|Infinity|undefined|null/);
      }
      expect(insightById(ctx, i.id)).toEqual(i);
    }
    for (const reason of report.cannotEstablish) expect(reason).not.toMatch(BANNED);
    expect(insightById(ctx, "category_change:Payments")).toBeNull();
    expect(insightById(ctx, "no_such_insight")).toBeNull();
    expect(insightById(ctx, "__proto__")).toBeNull();
    expect(insightById(ctx, "category_change:Nothing here")).toBeNull();
  });

  it("is deterministic: the same input gives the same output", () => {
    expect(buildInsights(seed)).toEqual(buildInsights(structuredClone(seed)));
    expect(buildInsights(seed)).toEqual(buildInsights(seed));
  });
});
