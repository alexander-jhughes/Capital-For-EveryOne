import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

import { ComplexHome } from "./ComplexHome"
import { TransactionTable } from "./TransactionTable"
import { card, gap, rounded, textDisplay, textLarge } from "./tokens"
import type { Account, Transaction } from "./types"

type ComplexScreenProps = {
  account: Account
  transactions: Transaction[]
  highlightIds?: string[]
}

export function ComplexScreen({
  account,
  transactions,
  highlightIds,
}: ComplexScreenProps) {
  return (
    <div className={`flex flex-col ${gap}`}>
      <h1 className={`${textDisplay} leading-tight font-semibold`}>
        Your credit card
      </h1>
      <ComplexHome account={account} transactions={transactions} />
      <section aria-labelledby="complex-transactions-heading">
        <h2
          id="complex-transactions-heading"
          className={`${textLarge} mb-[var(--density,12px)] font-medium`}
        >
          Transactions
        </h2>
        <TransactionTable
          transactions={transactions}
          highlightIds={highlightIds}
        />
      </section>
    </div>
  )
}

/** Loading state for ComplexScreen, laid out to match it. */
export function ComplexScreenSkeleton() {
  return (
    <div className={`flex flex-col ${gap}`}>
      <h1 className="sr-only">Your credit card</h1>
      <p role="status" className="sr-only">
        Loading your account
      </p>
      <div aria-hidden="true" className={`flex flex-col ${gap}`}>
        <Block className="h-[calc(var(--text-lg,20px)*2)] w-3/5" />
        <div className={`grid lg:grid-cols-2 ${gap}`}>
          <SummaryCard />
          <SummaryCard />
        </div>
        <Block className="h-[var(--target-min,44px)] w-full" />
        <Block className="h-[calc(var(--target-min,44px)*6)] w-full" />
      </div>
    </div>
  )
}

function SummaryCard() {
  return (
    <Card className={card}>
      <CardContent className={`flex flex-col ${gap}`}>
        <Block className="h-[var(--text-lg,20px)] w-1/3" />
        <Block className="h-[calc(var(--text-lg,20px)*1.6)] w-1/2" />
        <Block className="h-[var(--density,12px)] w-full" />
        <Block className="h-[calc(var(--text-base,16px)*5)] w-full" />
      </CardContent>
    </Card>
  )
}

function Block({ className }: { className: string }) {
  return (
    <Skeleton
      className={`${rounded} motion-reduce:animate-none ${className}`}
    />
  )
}
