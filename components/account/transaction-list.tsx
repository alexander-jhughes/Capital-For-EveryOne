"use client";

// Successor to Alexander Hughes's TransactionTable (origin/complex-mode, e1ed0e5 / 879ae79): search, category filter,
// sorting and highlight-and-scroll keep his behaviour. Changed: rows grouped by day instead of a sideways-scrolling
// table (no horizontal scrolling at 320px), native selects, the new design tokens.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flagTransactions } from "@/lib/finance";
import { formatDate, formatPence } from "@/lib/format";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "./flag-badges";

type SortKey = "newest" | "oldest" | "highest" | "lowest" | "shop";
const SORTS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "highest", label: "Highest amount" },
  { value: "lowest", label: "Lowest amount" },
  { value: "shop", label: "Shop, A to Z" },
];
const ALL = "all";
const control = "min-h-(--target-min) w-full rounded-xl border border-input bg-card px-3 text-base";

function sortTxns(txns: Transaction[], key: SortKey) {
  const byDate = (a: Transaction, b: Transaction) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);
  const cmp: Record<SortKey, (a: Transaction, b: Transaction) => number> = {
    newest: byDate,
    oldest: (a, b) => -byDate(a, b),
    highest: (a, b) => b.amount - a.amount || byDate(a, b),
    lowest: (a, b) => a.amount - b.amount || byDate(a, b),
    shop: (a, b) => a.merchant.localeCompare(b.merchant, "en-GB") || byDate(a, b),
  };
  return [...txns].sort(cmp[key]);
}

const matches = (t: Transaction, q: string, cat: string) =>
  (cat === ALL || t.category === cat) && (t.merchant.toLowerCase().includes(q.toLowerCase()) || t.category.toLowerCase().includes(q.toLowerCase()));

export function TransactionList({ transactions, highlightIds = [] }: { transactions: Transaction[]; highlightIds?: string[] }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL);
  const [sort, setSort] = useState<SortKey>("newest");
  const ids = { search: useId(), cat: useId(), sort: useId() };
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledKey = useRef("");

  const q = search.trim();
  const flags = useMemo(() => flagTransactions(transactions), [transactions]);
  const categories = useMemo(() => [...new Set(transactions.map((t) => t.category))].sort((a, b) => a.localeCompare(b, "en-GB")), [transactions]);
  const rows = useMemo(() => sortTxns(transactions.filter((t) => matches(t, q, category)), sort), [transactions, q, category, sort]);
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
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduced";
    row.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, [highlightKey, rows]);

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

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
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
            {SORTS.map((s) => (
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
          <p>{transactions.length === 0 ? "There are no transactions on this account yet." : "Nothing matches. Try a different shop or category."}</p>
          {transactions.length > 0 && (
            <button type="button" onClick={() => { setSearch(""); setCategory(ALL); }} className="hairline inline-flex min-h-(--target-min) items-center rounded-full px-5 font-bold">
              Clear search and filter
            </button>
          )}
        </div>
      ) : (
        <div ref={listRef} className="elevated rounded-xl bg-card px-(--space) py-1">
          {groups.map((g, gi) => (
            <section key={g.label ?? gi} aria-label={g.label ?? undefined}>
              {g.label && <h3 className="pb-1 pt-3 text-sm font-bold text-muted-foreground">{g.label}</h3>}
              <ul>
                {g.items.map((t) => {
                  const hl = highlighted.has(t.id);
                  return (
                    <li
                      key={t.id}
                      data-highlighted={hl ? "" : undefined}
                      className={`flex scroll-my-24 items-center gap-3 border-b py-2.5 last:border-0 ${hl ? "-mx-2 rounded-lg bg-accent px-2" : ""}`}
                    >
                      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-accent-foreground">
                        {t.merchant[0]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold">{t.merchant}</span>
                        <span className="text-sm text-muted-foreground">
                          {t.category}
                          {g.label ? "" : `, ${formatDate(t.date)}`}
                        </span>
                        <FlagBadges flags={flags.get(t.id)!} highlighted={hl} />
                      </span>
                      <span className={`shrink-0 font-bold ${t.amount < 0 ? "text-success" : ""}`}>{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
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
