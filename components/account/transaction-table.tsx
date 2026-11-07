"use client";

// Adapted from Alexander Hughes's TransactionTable (origin/complex-mode, e1ed0e5 / 879ae79): sorting, search,
// category filter, scroll region and highlight-and-scroll are his. Changed here: lib/types, lib/format and
// lib/finance flags instead of local types, helpers and mock data; Dial tokens; text + icon flags.

import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { flagTransactions, type TransactionFlags } from "@/lib/finance";
import { formatPence, formatShortDate } from "@/lib/format";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "./flag-badges";

type SortKey = "date" | "merchant" | "category" | "amount";
type SortDirection = "ascending" | "descending";
type Sort = { key: SortKey; direction: SortDirection };

const ALL_CATEGORIES = "all";
const DEFAULT_SORT: Sort = { key: "date", direction: "descending" };
const COLUMN_LABELS: Record<SortKey, string> = { date: "Date", merchant: "Shop", category: "Category", amount: "Amount" };

const control = "h-auto min-h-(--target-min) rounded-lg border-input text-base md:text-base";
const cell = "px-[calc(var(--space)*0.5)] py-[calc(var(--space)*0.33)]";
const stickyColumn = "sticky left-0 border-r border-border";
// Inset so the focus ring is not clipped by the scroll container.
const insetFocus = "focus-visible:-outline-offset-[3px]";

function compare(a: Transaction, b: Transaction, key: SortKey) {
  switch (key) {
    case "date":
      return a.date.localeCompare(b.date);
    case "merchant":
      return a.merchant.localeCompare(b.merchant, "en-GB");
    case "category":
      return a.category.localeCompare(b.category, "en-GB");
    case "amount":
      return a.amount - b.amount;
  }
}

function sortTransactions(txns: Transaction[], sort: Sort) {
  const direction = sort.direction === "ascending" ? 1 : -1;
  return [...txns].sort((a, b) => direction * compare(a, b, sort.key) || compare(b, a, "date") || b.id.localeCompare(a.id));
}

function matchesFilters(t: Transaction, query: string, category: string) {
  if (category !== ALL_CATEGORIES && t.category !== category) return false;
  const needle = query.toLowerCase();
  return t.merchant.toLowerCase().includes(needle) || t.category.toLowerCase().includes(needle);
}

function describeResults(count: number, query: string, category: string) {
  const filtered = query !== "" || category !== ALL_CATEGORIES;
  if (!filtered) return `${count} ${count === 1 ? "transaction" : "transactions"}`;
  const lead = count === 0 ? "No results" : `${count} ${count === 1 ? "result" : "results"}`;
  return `${lead}${query ? ` for ${query}` : ""}${category !== ALL_CATEGORIES ? ` in ${category}` : ""}`;
}

export function TransactionTable({ transactions, highlightIds }: { transactions: Transaction[]; highlightIds?: string[] }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const scrolledKeyRef = useRef("");

  const query = search.trim();
  const flags = useMemo(() => flagTransactions(transactions), [transactions]);
  const categoryItems = useMemo(
    () => [
      { value: ALL_CATEGORIES, label: "All categories" },
      ...[...new Set(transactions.map((t) => t.category))].sort((a, b) => a.localeCompare(b, "en-GB")).map((c) => ({ value: c, label: c })),
    ],
    [transactions],
  );
  const rows = useMemo(
    () => sortTransactions(transactions.filter((t) => matchesFilters(t, query, category)), sort),
    [transactions, query, category, sort],
  );

  const highlighted = useMemo(() => new Set(highlightIds), [highlightIds]);
  const highlightKey = (highlightIds ?? []).join(",");

  // A new highlight has to be reachable, so drop any filter that hides it.
  useEffect(() => {
    if (highlightKey === "") return;
    const ids = highlightKey.split(",");
    if (transactions.some((t) => ids.includes(t.id) && !matchesFilters(t, query, category))) {
      setSearch("");
      setCategory(ALL_CATEGORIES);
    }
    // Only a change of highlight should clear filters, not typing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey]);

  // Runs on rows too, so it still scrolls once the effect above has cleared the filters. One scroll per highlight.
  useEffect(() => {
    if (highlightKey === "") {
      scrolledKeyRef.current = "";
      return;
    }
    if (scrolledKeyRef.current === highlightKey) return;
    const row = scrollRegionRef.current?.querySelector<HTMLElement>("[data-highlighted]");
    if (!row) return;
    scrolledKeyRef.current = highlightKey;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center", inline: "start" });
  }, [highlightKey, rows]);

  function toggleSort(key: SortKey) {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "ascending" ? "descending" : "ascending" }
        : { key, direction: key === "date" || key === "amount" ? "descending" : "ascending" },
    );
  }

  function clearFilters() {
    setSearch("");
    setCategory(ALL_CATEGORIES);
    searchRef.current?.focus();
  }

  const results = describeResults(rows.length, query, category);
  const sortDescription = `Sorted by ${COLUMN_LABELS[sort.key].toLowerCase()}, ${sort.direction}.`;

  return (
    <div className="flex flex-col gap-(--space)">
      <div className="grid gap-(--space) sm:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-1">
          <label htmlFor={searchId} className="text-sm font-bold">
            Search transactions
          </label>
          <Input
            ref={searchRef}
            id={searchId}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Shop or category"
            autoComplete="off"
            className={control}
          />
        </div>
        <Select items={categoryItems} value={category} onValueChange={(v) => setCategory(v ?? ALL_CATEGORIES)}>
          <div className="flex flex-col gap-1">
            <SelectPrimitive.Label className="text-sm font-bold">Category</SelectPrimitive.Label>
            <SelectTrigger className={`w-full data-[size=default]:h-auto sm:min-w-[12em] ${control}`}>
              <SelectValue />
            </SelectTrigger>
          </div>
          <SelectContent alignItemWithTrigger={false} className="rounded-lg">
            {categoryItems.map((item) => (
              <SelectItem key={item.value} value={item.value} className="min-h-(--target-min) text-base">
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p role="status" aria-live="polite" className="text-sm">
        {results}
      </p>

      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-(--space) rounded-lg border border-border p-(--space)">
          <p>
            {transactions.length === 0
              ? "There are no transactions on this account yet."
              : "Nothing matches your search. Try a different shop or category."}
          </p>
          {transactions.length > 0 && (
            <Button variant="outline" onClick={clearFilters} className={`${control} px-4`}>
              Clear search and filter
            </Button>
          )}
        </div>
      ) : (
        // The shadcn Table adds its own scroll container, which cannot take focus. This labelled one scrolls instead.
        <div
          ref={scrollRegionRef}
          role="region"
          aria-label="Transactions table, scrolls sideways on small screens"
          tabIndex={0}
          className="scroll-pl-[8em] overflow-x-auto rounded-lg border border-border bg-card [&>[data-slot=table-container]]:overflow-visible"
        >
          <Table className="text-sm">
            <TableCaption className="sr-only">Transactions. {sortDescription}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableHead column="merchant" sort={sort} onSort={toggleSort} className={`z-20 bg-card ${stickyColumn}`} />
                {/* Amount sits next to Shop so it stays visible at phone width; date and category scroll. */}
                <SortableHead column="amount" sort={sort} onSort={toggleSort} alignEnd />
                <SortableHead column="date" sort={sort} onSort={toggleSort} />
                <SortableHead column="category" sort={sort} onSort={toggleSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TransactionRow key={t.id} transaction={t} flags={flags.get(t.id)!} highlighted={highlighted.has(t.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function SortableHead({
  column,
  sort,
  onSort,
  alignEnd = false,
  className = "",
}: {
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  alignEnd?: boolean;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDownIcon : sort.direction === "ascending" ? ArrowUpIcon : ArrowDownIcon;
  return (
    <TableHead scope="col" aria-sort={active ? sort.direction : "none"} className={`h-auto p-0 ${alignEnd ? "text-right" : ""} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        // Keeps a tabbed-to column in view, clear of the sticky first column.
        onFocus={(e) => e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })}
        className={`inline-flex min-h-(--target-min) w-full items-center gap-1 text-sm font-bold ${cell} ${alignEnd ? "justify-end" : ""} ${insetFocus}`}
      >
        {COLUMN_LABELS[column]}
        <Icon aria-hidden className={`size-[1em] shrink-0 ${active ? "" : "text-muted-foreground"}`} />
      </button>
    </TableHead>
  );
}

function TransactionRow({ transaction: t, flags, highlighted }: { transaction: Transaction; flags: TransactionFlags; highlighted: boolean }) {
  const isCredit = t.amount < 0;
  const rowBg = highlighted ? "bg-warning-surface" : "bg-card";
  return (
    <TableRow
      data-highlighted={highlighted ? "" : undefined}
      className={`${rowBg} ${highlighted ? "scroll-my-(--target-min) hover:bg-warning-surface" : "hover:bg-card"}`}
    >
      <th
        scope="row"
        className={`z-10 min-w-[11em] whitespace-normal text-left font-bold ${cell} ${stickyColumn} ${rowBg} ${highlighted ? "border-l-4 border-l-warning" : ""}`}
      >
        <span className="block">{t.merchant}</span>
        <FlagBadges flags={flags} highlighted={highlighted} />
      </th>
      <TableCell className={`${cell} text-right font-bold tabular-nums`}>
        {isCredit ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}
      </TableCell>
      <TableCell className={`${cell} tabular-nums`}>
        <time dateTime={t.date}>{formatShortDate(t.date)}</time>
      </TableCell>
      <TableCell className={cell}>{t.category}</TableCell>
    </TableRow>
  );
}
