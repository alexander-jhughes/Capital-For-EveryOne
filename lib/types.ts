// Frozen after Phase 1. Ask before changing.

/** Integer pence. Never floats. */
export type Pence = number;
/** Calendar date, YYYY-MM-DD (Europe/London). */
export type ISODate = string;

export type Mode = "simple" | "complex";

export interface Account {
  holderName: string;
  cardLast4: string;
  creditLimit: Pence;
  currentBalance: Pence;
  statementBalance: Pence;
  minimumPayment: Pence;
  paymentDueDate: ISODate;
  /** Annual percentage rate, e.g. 24.9 */
  apr: number;
  lastPayment: { amount: Pence; date: ISODate };
}

export type Category =
  | "Groceries"
  | "Transport"
  | "Eating out"
  | "Subscriptions"
  | "Shopping"
  | "Travel"
  | "Payments";

export interface Transaction {
  id: string;
  date: ISODate;
  merchant: string;
  /** Positive = spend, negative = refund or payment. */
  amount: Pence;
  category: Category;
  status: "pending" | "posted";
}

export interface Payment {
  id: string;
  amount: Pence;
  date: ISODate;
  kind: "minimum" | "statement" | "custom";
}

export interface SpendPauseSettings {
  enabled: boolean;
  singlePurchaseThreshold: Pence | null;
  monthlyBudget: Pence | null;
  /** 24h "HH:MM", may wrap midnight (22:00 to 06:00). */
  quietHours: { start: string; end: string } | null;
}

export interface PendingPurchase {
  id: string;
  merchant: string;
  item: string;
  amount: Pence;
  /** Full ISO datetime. */
  createdAt: string;
}

export type PauseReason = "over_threshold" | "over_budget" | "quiet_hours";

export interface PauseDecision {
  shouldPause: boolean;
  reasons: PauseReason[];
  balanceAfter: Pence;
  availableCreditAfter: Pence;
  /** null when no monthly budget is set. */
  budgetRemainingAfter: Pence | null;
}
