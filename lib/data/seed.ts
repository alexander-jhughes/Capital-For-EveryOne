import type { Account, Category, Transaction } from "../types";

const STATEMENT_DATE = "2026-10-23";

let n = 0;
const t = (date: string, merchant: string, amount: number, category: Category, status: Transaction["status"] = "posted"): Transaction => ({
  id: `t${String(++n).padStart(3, "0")}`,
  date,
  merchant,
  amount,
  category,
  status,
});

// Six weeks to the demo day (Sun 8 Nov 2026). November net spend is exactly £402.35,
// about 80% of the £500 demo budget, so a £120 purchase crosses it.
// Deliberate duplicate: Tesco £38.62 on 5 and 6 Nov.
export const SEED_TRANSACTIONS: Transaction[] = [
  t("2026-09-28", "Tesco", 5218, "Groceries"),
  t("2026-09-28", "TfL", 290, "Transport"),
  t("2026-09-29", "Greggs", 410, "Eating out"),
  t("2026-09-30", "Deliveroo", 2460, "Eating out"),
  t("2026-10-01", "Spotify", 1199, "Subscriptions"),
  t("2026-10-01", "TfL", 580, "Transport"),
  t("2026-10-02", "Sainsbury's", 3145, "Groceries"),
  t("2026-10-02", "TfL", 290, "Transport"),
  t("2026-10-03", "Amazon", 1899, "Shopping"),
  t("2026-10-04", "Netflix", 1099, "Subscriptions"),
  t("2026-10-05", "Tesco", 2736, "Groceries"),
  t("2026-10-06", "TfL", 290, "Transport"),
  t("2026-10-07", "Greggs", 385, "Eating out"),
  t("2026-10-08", "Deliveroo", 2940, "Eating out"),
  t("2026-10-09", "TfL", 580, "Transport"),
  t("2026-10-10", "Sainsbury's", 4620, "Groceries"),
  t("2026-10-10", "TfL", 470, "Transport"),
  t("2026-10-11", "Amazon", 3450, "Shopping"),
  t("2026-10-12", "Tesco", 1984, "Groceries"),
  t("2026-10-13", "TfL", 290, "Transport"),
  t("2026-10-14", "Greggs", 435, "Eating out"),
  t("2026-10-15", "Payment received", -18000, "Payments"),
  t("2026-10-16", "Trainline", 4210, "Travel"),
  t("2026-10-17", "Deliveroo", 2295, "Eating out"),
  t("2026-10-18", "Tesco", 4107, "Groceries"),
  t("2026-10-19", "TfL", 580, "Transport"),
  t("2026-10-20", "Sainsbury's", 2560, "Groceries"),
  t("2026-10-21", "Amazon", 1499, "Shopping"),
  t("2026-10-22", "Greggs", 360, "Eating out"),
  t("2026-10-23", "TfL", 290, "Transport"),
  t("2026-10-24", "Tesco", 3648, "Groceries"),
  t("2026-10-25", "Deliveroo", 3310, "Eating out"),
  t("2026-10-26", "TfL", 580, "Transport"),
  t("2026-10-27", "Sainsbury's", 2890, "Groceries"),
  t("2026-10-28", "Greggs", 410, "Eating out"),
  t("2026-10-29", "Amazon", -1499, "Shopping"), // refund of 21 Oct
  t("2026-10-29", "TfL", 290, "Transport"),
  t("2026-10-30", "Tesco", 2415, "Groceries"),
  t("2026-10-30", "Deliveroo", 1980, "Eating out"),
  t("2026-10-31", "Sainsbury's", 3725, "Groceries"),
  t("2026-10-31", "Greggs", 385, "Eating out"),
  t("2026-11-01", "Spotify", 1199, "Subscriptions"),
  t("2026-11-01", "Sainsbury's", 2340, "Groceries"),
  t("2026-11-02", "Trainline", 6430, "Travel"),
  t("2026-11-02", "TfL", 290, "Transport"),
  t("2026-11-03", "Greggs", 435, "Eating out"),
  t("2026-11-03", "TfL", 580, "Transport"),
  t("2026-11-04", "Netflix", 1099, "Subscriptions"),
  t("2026-11-04", "Deliveroo", 2785, "Eating out"),
  t("2026-11-04", "Tesco", 2147, "Groceries"),
  t("2026-11-05", "Tesco", 3862, "Groceries"),
  t("2026-11-06", "Tesco", 3862, "Groceries"),
  t("2026-11-06", "TfL", 470, "Transport"),
  t("2026-11-06", "Amazon", 4599, "Shopping"),
  t("2026-11-07", "Greggs", 385, "Eating out"),
  t("2026-11-07", "Deliveroo", 3120, "Eating out"),
  t("2026-11-07", "Sainsbury's", 4467, "Groceries"),
  t("2026-11-08", "TfL", 290, "Transport", "pending"),
  t("2026-11-08", "Sainsbury's", 1875, "Groceries", "pending"),
];

const STATEMENT_BALANCE = 48620;

export const SEED_ACCOUNT: Account = {
  holderName: "Sam Taylor",
  cardLast4: "4821",
  creditLimit: 150000,
  statementBalance: STATEMENT_BALANCE,
  // Derived so the current balance always matches the transactions after the statement.
  currentBalance:
    STATEMENT_BALANCE + SEED_TRANSACTIONS.filter((x) => x.date > STATEMENT_DATE).reduce((s, x) => s + x.amount, 0),
  minimumPayment: 2500,
  paymentDueDate: "2026-11-13",
  apr: 24.9,
  lastPayment: { amount: 18000, date: "2026-10-15" },
};
