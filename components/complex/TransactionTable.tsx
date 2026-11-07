"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { formatFullDate, formatPence, formatShortDate } from "./format"
import {
  gap,
  padding,
  rounded,
  targetHeight,
  textBase,
  textSmall,
} from "./tokens"
import type { Transaction } from "./types"

type TransactionTableProps = {
  transactions: Transaction[]
  highlightIds?: string[]
}

type SortKey = "date" | "merchant" | "category" | "amount"
type SortDirection = "ascending" | "descending"
type Sort = { key: SortKey; direction: SortDirection }

const ALL_CATEGORIES = "all"
const DEFAULT_SORT: Sort = { key: "date", direction: "descending" }

const COLUMN_LABELS: Record<SortKey, string> = {
  date: "Date",
  merchant: "Merchant",
  category: "Category",
  amount: "Amount",
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
const focusRingInset =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
const controlOverrides = `h-auto ${targetHeight} ${rounded} ${textBase} md:text-[length:var(--text-base,16px)] border-foreground/60 focus-visible:border-foreground focus-visible:ring-foreground/40`
const cellSpacing =
  "px-[calc(var(--density,12px)*0.5)] py-[calc(var(--density,12px)*0.33)]"
const stickyColumn = "sticky left-0 border-r border-border"

function compare(a: Transaction, b: Transaction, key: SortKey) {
  switch (key) {
    case "date":
      return Date.parse(a.date) - Date.parse(b.date)
    case "merchant":
      return a.merchant.localeCompare(b.merchant, "en-GB")
    case "category":
      return a.category.localeCompare(b.category, "en-GB")
    case "amount":
      return a.amountPence - b.amountPence
  }
}

function sortTransactions(transactions: Transaction[], sort: Sort) {
  const direction = sort.direction === "ascending" ? 1 : -1
  return [...transactions].sort(
    (a, b) =>
      direction * compare(a, b, sort.key) ||
      compare(b, a, "date") ||
      a.id.localeCompare(b.id),
  )
}

function matchesFilters(
  transaction: Transaction,
  query: string,
  category: string,
) {
  if (category !== ALL_CATEGORIES && transaction.category !== category) {
    return false
  }
  const needle = query.toLowerCase()
  return (
    transaction.merchant.toLowerCase().includes(needle) ||
    transaction.category.toLowerCase().includes(needle)
  )
}

function describeResults(count: number, query: string, category: string) {
  const filtered = query !== "" || category !== ALL_CATEGORIES
  if (!filtered) {
    return `${count} ${count === 1 ? "transaction" : "transactions"}`
  }
  const lead =
    count === 0 ? "No results" : `${count} ${count === 1 ? "result" : "results"}`
  const forQuery = query ? ` for ${query}` : ""
  const inCategory = category !== ALL_CATEGORIES ? ` in ${category}` : ""
  return `${lead}${forQuery}${inCategory}`
}

export function TransactionTable({
  transactions,
  highlightIds,
}: TransactionTableProps) {
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)

  const searchId = useId()
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const scrolledKeyRef = useRef("")

  const query = search.trim()
  const categories = useMemo(
    () =>
      [...new Set(transactions.map((transaction) => transaction.category))].sort(
        (a, b) => a.localeCompare(b, "en-GB"),
      ),
    [transactions],
  )
  const categoryItems = useMemo(
    () => [
      { value: ALL_CATEGORIES, label: "All categories" },
      ...categories.map((name) => ({ value: name, label: name })),
    ],
    [categories],
  )
  const rows = useMemo(
    () =>
      sortTransactions(
        transactions.filter((transaction) =>
          matchesFilters(transaction, query, category),
        ),
        sort,
      ),
    [transactions, query, category, sort],
  )

  const highlighted = useMemo(() => new Set(highlightIds), [highlightIds])
  const highlightKey = (highlightIds ?? []).join(",")

  // A new highlight has to be reachable, so drop any filter that hides it.
  useEffect(() => {
    if (highlightKey === "") return
    const ids = highlightKey.split(",")
    const hidden = transactions.some(
      (transaction) =>
        ids.includes(transaction.id) &&
        !matchesFilters(transaction, query, category),
    )
    if (hidden) {
      setSearch("")
      setCategory(ALL_CATEGORIES)
    }
    // Only a change of highlight should clear filters, not typing afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightKey])

  // Runs on rows too, so it still scrolls once the effect above has cleared
  // the filters. The ref keeps it to one scroll per change of highlight.
  useEffect(() => {
    if (highlightKey === "") {
      scrolledKeyRef.current = ""
      return
    }
    if (scrolledKeyRef.current === highlightKey) return
    const row = scrollRegionRef.current?.querySelector<HTMLElement>(
      "[data-highlighted]",
    )
    if (!row) return
    scrolledKeyRef.current = highlightKey
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches
    row.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
      inline: "start",
    })
  }, [highlightKey, rows])

  function toggleSort(key: SortKey) {
    setSort((current) => {
      if (current.key === key) {
        return {
          key,
          direction:
            current.direction === "ascending" ? "descending" : "ascending",
        }
      }
      const numeric = key === "date" || key === "amount"
      return { key, direction: numeric ? "descending" : "ascending" }
    })
  }

  function clearFilters() {
    setSearch("")
    setCategory(ALL_CATEGORIES)
    searchRef.current?.focus()
  }

  const results = describeResults(rows.length, query, category)
  const sortDescription = `Sorted by ${COLUMN_LABELS[sort.key].toLowerCase()}, ${sort.direction}.`

  return (
    <div className={`flex flex-col ${gap}`}>
      <div className={`grid sm:grid-cols-[1fr_auto] ${gap}`}>
        <div className="flex flex-col gap-1">
          <label htmlFor={searchId} className={`${textSmall} font-medium`}>
            Search transactions
          </label>
          <Input
            ref={searchRef}
            id={searchId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Merchant or category"
            autoComplete="off"
            className={controlOverrides}
          />
        </div>
        <Select
          items={categoryItems}
          value={category}
          onValueChange={(value) => setCategory(value ?? ALL_CATEGORIES)}
        >
          <div className="flex flex-col gap-1">
            <SelectPrimitive.Label className={`${textSmall} font-medium`}>
              Category
            </SelectPrimitive.Label>
            <SelectTrigger
              className={`w-full sm:min-w-[calc(var(--text-base,16px)*12)] data-[size=default]:h-auto ${controlOverrides}`}
            >
              <SelectValue />
            </SelectTrigger>
          </div>
          <SelectContent alignItemWithTrigger={false} className={rounded}>
            {categoryItems.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className={`${targetHeight} ${textBase}`}
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p role="status" aria-live="polite" className={textSmall}>
        {results}
      </p>

      {rows.length === 0 ? (
        <div
          className={`flex flex-col items-start ${gap} ${padding} ${rounded} border border-border`}
        >
          <p className={textBase}>
            {transactions.length === 0
              ? "There are no transactions on this account yet."
              : "Nothing matches your search. Try a different merchant or category."}
          </p>
          {transactions.length > 0 ? (
            <Button
              variant="outline"
              onClick={clearFilters}
              className={`h-auto ${targetHeight} ${rounded} ${textBase} border-foreground/60 ${focusRing}`}
            >
              Clear search and filter
            </Button>
          ) : null}
        </div>
      ) : (
        // The shadcn Table adds its own scroll container, which cannot take
        // focus. It is switched off so this labelled one does the scrolling.
        <div
          ref={scrollRegionRef}
          role="region"
          aria-label="Transactions table, scrolls sideways on small screens"
          tabIndex={0}
          data-scroll-region
          className={`scroll-pl-[calc(var(--text-base,16px)*12)] overflow-x-auto ${rounded} border border-border [&>[data-slot=table-container]]:overflow-visible ${focusRing}`}
        >
          <Table className={textSmall}>
            <TableCaption className="sr-only">
              Transactions. {sortDescription}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortableHead
                  column="merchant"
                  sort={sort}
                  onSort={toggleSort}
                  className={`z-20 bg-card ${stickyColumn}`}
                />
                <SortableHead column="date" sort={sort} onSort={toggleSort} />
                <SortableHead
                  column="category"
                  sort={sort}
                  onSort={toggleSort}
                />
                <SortableHead
                  column="amount"
                  sort={sort}
                  onSort={toggleSort}
                  alignEnd
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((transaction) => (
                <TransactionRow
                  key={transaction.id}
                  transaction={transaction}
                  highlighted={highlighted.has(transaction.id)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function SortableHead({
  column,
  sort,
  onSort,
  alignEnd = false,
  className = "",
}: {
  column: SortKey
  sort: Sort
  onSort: (key: SortKey) => void
  alignEnd?: boolean
  className?: string
}) {
  const active = sort.key === column
  const Icon = !active
    ? ArrowUpDownIcon
    : sort.direction === "ascending"
      ? ArrowUpIcon
      : ArrowDownIcon

  return (
    <TableHead
      scope="col"
      aria-sort={active ? sort.direction : "none"}
      className={`h-auto p-0 ${alignEnd ? "text-right" : ""} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex w-full items-center gap-1 ${targetHeight} ${cellSpacing} ${textSmall} font-medium ${alignEnd ? "justify-end" : ""} ${focusRingInset}`}
      >
        {COLUMN_LABELS[column]}
        <Icon
          aria-hidden="true"
          className={`size-[1em] shrink-0 ${active ? "" : "text-muted-foreground"}`}
        />
      </button>
    </TableHead>
  )
}

function TransactionRow({
  transaction,
  highlighted,
}: {
  transaction: Transaction
  highlighted: boolean
}) {
  const { date, merchant, category, amountPence, pending } = transaction
  const isCredit = amountPence < 0
  const rowBackground = highlighted
    ? "bg-amber-100 dark:bg-amber-950"
    : "bg-card"

  return (
    <TableRow
      data-highlighted={highlighted ? "" : undefined}
      className={`${rowBackground} ${highlighted ? "scroll-my-[var(--target-min,44px)] hover:bg-amber-100 dark:hover:bg-amber-950" : "hover:bg-card"}`}
    >
      <th
        scope="row"
        className={`z-10 min-w-[calc(var(--text-base,16px)*6)] max-w-[calc(var(--text-base,16px)*12)] whitespace-normal text-left font-medium ${cellSpacing} ${stickyColumn} ${rowBackground} ${highlighted ? "border-l-4 border-l-amber-700" : ""}`}
      >
        <span className="block">{merchant}</span>
        {pending || highlighted ? (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {pending ? <RowBadge>Pending</RowBadge> : null}
            {highlighted ? <RowBadge strong>Highlighted</RowBadge> : null}
          </span>
        ) : null}
      </th>
      <TableCell className={`${cellSpacing} tabular-nums`}>
        <time dateTime={date} title={formatFullDate(date)}>
          {formatShortDate(date)}
        </time>
      </TableCell>
      <TableCell className={cellSpacing}>{category}</TableCell>
      <TableCell className={`${cellSpacing} text-right tabular-nums`}>
        <span
          className={`block font-medium ${isCredit ? "text-emerald-800 dark:text-emerald-300" : ""}`}
        >
          {isCredit ? `+${formatPence(-amountPence)}` : formatPence(amountPence)}
        </span>
        {isCredit ? <RowBadge>Credit</RowBadge> : null}
      </TableCell>
    </TableRow>
  )
}

function RowBadge({
  strong = false,
  children,
}: {
  strong?: boolean
  children: React.ReactNode
}) {
  return (
    <Badge
      variant={strong ? "default" : "outline"}
      className={`h-auto font-medium ${textSmall} leading-tight ${strong ? "" : "border-foreground/60"}`}
    >
      {children}
    </Badge>
  )
}
