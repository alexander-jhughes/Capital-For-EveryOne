// The Spending screen's URL filters. Parsed defensively: anything not allowlisted is dropped, never trusted.
// Shared by the Dial planner (to build links) and the Spending page (to read them).
import type { Category } from "../types";
import { MONTH_KEY, type SpendingFilters } from "./types";

export const SPENDING_CATEGORIES: Exclude<Category, "Payments">[] = ["Groceries", "Transport", "Eating out", "Subscriptions", "Shopping", "Travel"];
const SORTS = ["newest", "oldest", "highest", "lowest", "shop"] as const;
const TXN_ID = /^[a-z0-9-]{1,40}$/i;
const MERCHANT = /^[A-Za-z0-9 '&.-]{1,40}$/;

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function get(params: Params, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export function parseSpendingFilters(params: Params): SpendingFilters {
  const f: SpendingFilters = {};
  const category = get(params, "category");
  if (category && (SPENDING_CATEGORIES as string[]).includes(category)) f.category = category as SpendingFilters["category"];
  const month = get(params, "month");
  if (month && MONTH_KEY.test(month)) f.month = month;
  const merchant = get(params, "merchant")?.trim();
  if (merchant && MERCHANT.test(merchant)) f.merchant = merchant;
  const txn = get(params, "txn");
  if (txn && TXN_ID.test(txn)) f.txn = txn;
  const sort = get(params, "sort");
  if (sort && (SORTS as readonly string[]).includes(sort)) f.sort = sort as SpendingFilters["sort"];
  const highlight = get(params, "highlight");
  if (highlight) {
    const ids = highlight.split(",").filter((id) => TXN_ID.test(id)).slice(0, 50);
    if (ids.length) f.highlight = ids;
  }
  return f;
}

/** `/account/spending` with the filters as a query string, in a stable order. */
export function spendingHref(f: SpendingFilters = {}): string {
  const q = new URLSearchParams();
  if (f.category) q.set("category", f.category);
  if (f.month) q.set("month", f.month);
  if (f.merchant) q.set("merchant", f.merchant);
  if (f.txn) q.set("txn", f.txn);
  if (f.sort) q.set("sort", f.sort);
  if (f.highlight?.length) q.set("highlight", f.highlight.join(","));
  const s = q.toString().replace(/%2C/g, ",");
  return s ? `/account/spending?${s}` : "/account/spending";
}

export const hasFilters = (f: SpendingFilters) => !!(f.category || f.month || f.merchant || f.txn || f.sort || f.highlight?.length);
