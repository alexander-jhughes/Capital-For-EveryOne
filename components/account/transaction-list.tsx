"use client";

// Successor to Alexander Hughes's TransactionTable (origin/complex-mode, e1ed0e5 / 879ae79): search, category filter,
// sorting and highlight-and-scroll keep his behaviour. Changed: rows grouped by day instead of a sideways-scrolling
// table (no horizontal scrolling at 320px), native selects, the new design tokens. Dial 2.0: the category and sort
// can start from the URL, and ?txn= opens one row with its details.

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { SORT_OPTIONS, sortTransactions, type SortKey } from "@/lib/dial/spending-view";
import { flagTransactions, type TransactionFlags } from "@/lib/finance";
import { formatDate, formatPence } from "@/lib/format";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "./flag-badges";
import { TransactionDetail } from "./transaction-detail";

const ALL = "all";
const control = "min-h-(--target-min) w-full rounded-xl border border-input bg-card px-3 text-base";

const matches = (t: Transaction, q: string, cat: string) =>
  (cat === ALL || t.category === cat) && (t.merchant.toLowerCase().includes(q.toLowerCase()) || t.category.toLowerCase().includes(q.toLowerCase()));

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";

interface Props {
  transactions: Transaction[];
  highlightIds?: string[];
  /** Starting category and sort, e.g. from the URL. Give the list a new `key` when they change. */
  initialCategory?: string;
  initialSort?: SortKey;
  /** Flags worked out over the whole account, so a price change or duplicate across a month boundary still shows. */
  flags?: Map<string, TransactionFlags>;
  /** Every transaction on the account (for the detail panel). Defaults to `transactions`. */
  allTransactions?: Transaction[];
  /** One transaction to open: scrolled to, highlighted, focused and described. */
  openId?: string;
  /** Where the detail panel's Close goes. */
  closeHref?: string;
  /** Said when the list starts empty because of the URL's filters, e.g. "No Groceries purchases in September." */
  emptyMessage?: string;
  /** Where to go to drop the URL's filters when the list is empty. */
  clearHref?: string;
}

export function TransactionList({
  transactions,
  highlightIds = [],
  initialCategory = ALL,
  initialSort = "newest",
  flags: givenFlags,
  allTransactions,
  openId,
  closeHref = "/account/spending",
  emptyMessage,
  clearHref,
}: Props) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(initialCategory);
  const [sort, setSort] = useState<SortKey>(initialSort);
  const ids = { search: useId(), cat: useId(), sort: useId() };
  const listRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const scrolledKey = useRef("");
  const openedKey = useRef("");
  const lastOpen = useRef<string | undefined>(undefined);

  const q = search.trim();
  const ownFlags = useMemo(() => givenFlags ?? flagTransactions(transactions), [givenFlags, transactions]);
  const categories = useMemo(
    () => [...new Set([...transactions.map((t) => t.category as string), ...(initialCategory === ALL ? [] : [initialCategory])])].sort((a, b) => a.localeCompare(b, "en-GB")),
    [transactions, initialCategory],
  );
  const rows = useMemo(() => sortTransactions(transactions.filter((t) => matches(t, q, category)), sort), [transactions, q, category, sort]);
  const highlighted = useMemo(() => new Set(highlightIds), [highlightIds]);
  const highlightKey = highlightIds.join(",");

  // A new highlight has to be reachable, so drop any filter that hides it.
  useEffect(() => {
    if (!highlightKey) return;
    if (transactions.some((t) => highlighted.has(t.id) && !matches(t, q, category))) {
      setSearch("");
      setCategory(ALL);
    }
    // Only a change of highlight should clear filters, not typing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey]);

  useEffect(() => {
    if (!highlightKey) {
      scrolledKey.current = "";
      return;
    }
    if (scrolledKey.current === highlightKey) return;
    const row = listRef.current?.querySelector<HTMLElement>("[data-highlighted]");
    if (!row) return;
    scrolledKey.current = highlightKey;
    row.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  }, [highlightKey, rows]);

  // The same for an opened transaction: never hidden by a search typed earlier.
  useEffect(() => {
    const t = openId && transactions.find((x) => x.id === openId);
    if (t && !matches(t, q, category)) {
      setSearch("");
      setCategory(ALL);
    }
    // Only a change of the opened transaction should clear filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  // Scroll to and focus the opened transaction once it has rendered; when it closes, return focus to its row.
  useEffect(() => {
    if (!openId) {
      openedKey.current = "";
      const prev = lastOpen.current;
      lastOpen.current = undefined;
      const active = document.activeElement;
      if (prev && (!active || active === document.body)) listRef.current?.querySelector<HTMLElement>(`[data-txn="${prev}"]`)?.focus({ preventScroll: true });
      return;
    }
    lastOpen.current = openId;
    if (openedKey.current === openId || !detailRef.current) return;
    openedKey.current = openId;
    detailRef.current.closest("li")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    detailRef.current.focus({ preventScroll: true });
  }, [openId, rows]);

  const groups = useMemo(() => {
    if (sort !== "newest" && sort !== "oldest") return [{ label: null as string | null, items: rows }];
    const out: { label: string | null; items: Transaction[] }[] = [];
    for (const t of rows) {
      const label = formatDate(t.date);
      if (out.at(-1)?.label === label) out.at(-1)!.items.push(t);
      else out.push({ label, items: [t] });
    }
    return out;
  }, [rows, sort]);

  const filtered = q !== "" || category !== ALL;
  const results = filtered
    ? `${rows.length === 0 ? "No results" : `${rows.length} ${rows.length === 1 ? "result" : "results"}`}${q ? ` for ${q}` : ""}${category !== ALL ? ` in ${category}` : ""}`
    : `${rows.length} transactions`;
  // Empty because of the URL, not because of anything typed here.
  const emptyFromUrl = rows.length === 0 && q === "" && category === initialCategory && emptyMessage;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 @xl:grid-cols-[2fr_1fr_1fr]">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.search} className="text-sm font-bold">
            Search
          </label>
          <input id={ids.search} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Shop or category" autoComplete="off" className={control} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.cat} className="text-sm font-bold">
            Category
          </label>
          <select id={ids.cat} value={category} onChange={(e) => setCategory(e.target.value)} className={control}>
            <option value={ALL}>All categories</option>
            {categories.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.sort} className="text-sm font-bold">
            Sort
          </label>
          <select id={ids.sort} value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={control}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {results}
      </p>

      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl bg-card p-(--space)">
          {emptyFromUrl ? (
            <>
              <p className="font-bold">{emptyMessage}</p>
              {clearHref && (
                <Link href={clearHref} scroll={false} className="hairline inline-flex min-h-(--target-min) items-center rounded-full px-5 font-bold">
                  Show all spending
                </Link>
              )}
            </>
          ) : (
            <>
              <p>{transactions.length === 0 ? "There are no transactions on this account yet." : "Nothing matches. Try a different shop or category."}</p>
              {transactions.length > 0 && (
                <button type="button" onClick={() => { setSearch(""); setCategory(ALL); }} className="hairline inline-flex min-h-(--target-min) items-center rounded-full px-5 font-bold">
                  Clear search and filter
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div ref={listRef} className="elevated @container rounded-xl bg-card px-(--space) py-1">
          {groups.map((g, gi) => (
            <section key={g.label ?? gi} aria-label={g.label ?? undefined}>
              {g.label && <h3 className="pb-1 pt-3 text-sm font-bold text-muted-foreground">{g.label}</h3>}
              <ul>
                {g.items.map((t) => {
                  const hl = highlighted.has(t.id);
                  const open = t.id === openId;
                  return (
                    <li
                      key={t.id}
                      data-txn={t.id}
                      tabIndex={-1}
                      data-highlighted={hl ? "" : undefined}
                      data-open={open ? "" : undefined}
                      className={`scroll-my-24 border-b py-2.5 last:border-0 ${hl || open ? "-mx-2 rounded-lg bg-accent px-2" : ""} ${open ? "pb-2" : ""}`}
                    >
                      {/* In a narrow column (320px, large text) the initial goes and the amount can wrap under the shop. */}
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span aria-hidden className="flex size-10 shrink-0 items-center @max-[16em]:hidden justify-center rounded-full bg-accent font-bold text-accent-foreground shadow-[0_0_0_1px_var(--border)]">
                          {t.merchant[0]}
                        </span>
                        <span className="min-w-[min(100%,6em)] flex-1">
                          <span className="block font-bold">{t.merchant}</span>
                          <span className="text-sm text-muted-foreground">
                            {t.category}
                            {g.label ? "" : `, ${formatDate(t.date)}`}
                          </span>
                          <FlagBadges flags={ownFlags.get(t.id)!} highlighted={hl} />
                        </span>
                        <span className={`ml-auto shrink-0 font-bold ${t.amount < 0 ? "text-success" : ""}`}>{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
                      </span>
                      {open && (
                        <div className="mt-2.5">
                          <TransactionDetail ref={detailRef} transaction={t} flags={ownFlags.get(t.id)!} transactions={allTransactions ?? transactions} closeHref={closeHref} level={g.label ? 4 : 3} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
