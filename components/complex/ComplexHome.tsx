import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

import {
  daysUntil,
  formatDaysRemaining,
  formatFullDate,
  formatMonth,
  formatPence,
  monthKey,
} from "./format"
import {
  card,
  gap,
  rounded,
  textBase,
  textDisplay,
  textLarge,
  textSmall,
} from "./tokens"
import type { Account, Transaction } from "./types"

type ComplexHomeProps = {
  account: Account
  transactions: Transaction[]
  /** The moment to count the days remaining from. Defaults to the current time. */
  now?: Date
}

type CategoryTotal = {
  category: string
  totalPence: number
}

export function ComplexHome({ account, transactions, now }: ComplexHomeProps) {
  const days = daysUntil(account.dueDate, now)

  return (
    <div className={`grid lg:grid-cols-2 ${gap}`}>
      <Card className={card}>
        <CardHeader>
          <CardTitle>
            <h2 className={textLarge}>Balance</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className={`flex flex-col ${gap}`}>
          <p className={`${textDisplay} leading-tight font-semibold tabular-nums`}>
            {formatPence(account.balancePence)}
          </p>
          <CreditUsage account={account} />
          <dl className={`grid grid-cols-2 ${gap} ${textBase}`}>
            <Detail label="Credit limit">
              {formatPence(account.limitPence)}
            </Detail>
            <Detail label="Available credit">
              {formatPence(Math.max(account.limitPence - account.balancePence, 0))}
            </Detail>
            <Detail label="APR">{account.apr}%</Detail>
            <Detail label="Minimum payment">
              {formatPence(account.minimumPaymentPence)}
            </Detail>
            <Detail label="Payment due" wide>
              {formatFullDate(account.dueDate)}{" "}
              <span
                className={
                  days < 0 ? "font-semibold text-destructive" : "font-normal"
                }
              >
                ({formatDaysRemaining(days)})
              </span>
            </Detail>
          </dl>
        </CardContent>
      </Card>
      <CategorySpending transactions={transactions} />
    </div>
  )
}

function Detail({
  label,
  wide = false,
  children,
}: {
  label: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={wide ? "col-span-2" : undefined}>
      <dt className={`${textSmall} text-muted-foreground`}>{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function CreditUsage({ account }: { account: Account }) {
  const { balancePence, limitPence } = account
  const percent =
    limitPence > 0
      ? Math.min(Math.max(Math.round((balancePence * 100) / limitPence), 0), 100)
      : 0
  const summary = `${formatPence(balancePence)} of ${formatPence(limitPence)} used (${percent}%)`

  return (
    <div>
      <p className={`${textSmall} pb-[calc(var(--density,12px)*0.33)] tabular-nums`}>
        {summary}
      </p>
      <div
        role="meter"
        aria-label="Credit used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={summary}
        className={`h-[calc(var(--density,12px)*0.75)] overflow-hidden ${rounded} border border-foreground/60 bg-muted`}
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

/** Totals settled spending per category for the newest month in the data. */
function categoryTotals(transactions: Transaction[]) {
  if (transactions.length === 0) return null

  const newest = transactions.reduce((latest, transaction) =>
    transaction.date > latest.date ? transaction : latest,
  )
  const month = monthKey(newest.date)
  const totals = new Map<string, number>()

  for (const transaction of transactions) {
    if (transaction.pending || monthKey(transaction.date) !== month) continue
    totals.set(
      transaction.category,
      (totals.get(transaction.category) ?? 0) + transaction.amountPence,
    )
  }

  const rows: CategoryTotal[] = [...totals]
    .map(([category, totalPence]) => ({ category, totalPence }))
    .filter((row) => row.totalPence > 0)
    .sort((a, b) => b.totalPence - a.totalPence)

  return { monthLabel: formatMonth(newest.date), rows }
}

function CategorySpending({ transactions }: { transactions: Transaction[] }) {
  const summary = categoryTotals(transactions)
  const title = summary ? `Spending in ${summary.monthLabel}` : "Spending"

  return (
    <Card className={card}>
      <CardHeader>
        <CardTitle>
          <h2 className={textLarge}>{title}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className={`flex flex-col ${gap}`}>
        {summary && summary.rows.length > 0 ? (
          <>
            <CategoryChart title={title} rows={summary.rows} />
            <p className={`${textSmall} text-muted-foreground`}>
              Settled transactions only, with refunds taken off. Pending items
              are not included.
            </p>
          </>
        ) : (
          <p className={textBase}>No settled spending this month.</p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Bars are sized in em and percent rather than a viewBox, so the labels keep
 * the token font size at any width instead of scaling with the drawing.
 */
function CategoryChart({
  title,
  rows,
}: {
  title: string
  rows: CategoryTotal[]
}) {
  const ROW_EM = 3.1
  const BAR_TOP_EM = 1.5
  const BAR_EM = 0.8
  const largest = rows[0].totalPence
  const description = rows
    .map((row) => `${row.category} ${formatPence(row.totalPence)}`)
    .join(", ")

  return (
    <svg
      role="img"
      aria-label={`${title}: ${description}`}
      width="100%"
      className={`block ${textSmall}`}
      style={{ height: `${rows.length * ROW_EM}em` }}
    >
      {rows.map((row, index) => {
        const top = index * ROW_EM
        const widthPercent = (row.totalPence * 100) / largest
        return (
          <g key={row.category}>
            <text x="0" y={`${top + 1.1}em`} className="fill-foreground">
              {row.category}
            </text>
            <text
              x="100%"
              y={`${top + 1.1}em`}
              textAnchor="end"
              className="fill-foreground font-medium tabular-nums"
            >
              {formatPence(row.totalPence)}
            </text>
            <rect
              x="0"
              y={`${top + BAR_TOP_EM}em`}
              width="100%"
              height={`${BAR_EM}em`}
              className="fill-muted"
            />
            <rect
              x="0"
              y={`${top + BAR_TOP_EM}em`}
              width={`${widthPercent.toFixed(2)}%`}
              height={`${BAR_EM}em`}
              className="fill-primary"
            />
          </g>
        )
      })}
    </svg>
  )
}
