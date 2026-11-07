"use client";

import Link from "next/link";
import { availableCredit, budgetStatus, daysUntilDue, flagTransactions, spendingSummary } from "@/lib/finance";
import { formatLongDate, formatPence, formatShortDate } from "@/lib/format";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { useAccount } from "@/lib/state/account-context";
import { FlagBadges } from "./flag-badges";
import { Meter } from "./meter";

const section = "flex flex-col gap-(--space) rounded-lg border-2 border-border bg-card p-(--space)";
const linkButton =
  "inline-flex min-h-(--target-min) items-center justify-center rounded-lg px-5 font-bold underline-offset-4 hover:underline";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-(--space) border-b border-border py-1 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-bold tabular-nums">{children}</dd>
    </div>
  );
}

export function ComplexHome() {
  const { account, transactions, settings } = useAccount();
  const days = daysUntilDue(account, DEMO_TODAY);
  const month = spendingSummary(transactions, `${DEMO_TODAY.slice(0, 8)}01`, DEMO_TODAY);
  const budget = budgetStatus(transactions, settings, DEMO_TODAY);
  const flags = flagTransactions(transactions);
  const recent = [...transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)).slice(0, 5);
  const biggestCategory = Math.max(...month.byCategory.map((c) => c.total), 1);
  const period = `${formatShortDate(month.from)} to ${formatShortDate(month.to)}`;
  const daysText = days === 0 ? "due today" : days > 0 ? `in ${days} ${days === 1 ? "day" : "days"}` : `${-days} days overdue`;

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold">Credit card ending {account.cardLast4}</h1>

      <section aria-labelledby="balance-h" className={section}>
        <h2 id="balance-h" className="text-lg font-bold">
          Balance
        </h2>
        <p>
          <span className="block text-sm text-muted-foreground">Current balance</span>
          <span className="text-xl font-bold tabular-nums">{formatPence(account.currentBalance)}</span>
        </p>
        <Meter
          label="Credit used"
          value={account.currentBalance}
          max={account.creditLimit}
          text={`${formatPence(account.currentBalance)} of ${formatPence(account.creditLimit)} used`}
        />
        <dl>
          <Row label="Credit limit">{formatPence(account.creditLimit)}</Row>
          <Row label="Available credit">{formatPence(availableCredit(account))}</Row>
          <Row label="APR (yearly interest rate)">{account.apr}%</Row>
        </dl>
      </section>

      <section aria-labelledby="bill-h" className={section}>
        <h2 id="bill-h" className="text-lg font-bold">
          Your bill
        </h2>
        <dl>
          <Row label="Statement balance">{formatPence(account.statementBalance)}</Row>
          <Row label="Minimum payment">{formatPence(account.minimumPayment)}</Row>
          <Row label="Due">
            {formatLongDate(account.paymentDueDate)}, {daysText}
          </Row>
          <Row label="Last payment">
            {formatPence(account.lastPayment.amount)} on {formatShortDate(account.lastPayment.date)}
          </Row>
        </dl>
        <p className="text-sm text-muted-foreground">
          Your statement balance is what you owed when your last statement was made. Your current balance also includes
          spending since then.
        </p>
        <Link href="/account/pay" className={`${linkButton} self-start bg-primary text-primary-foreground`}>
          Pay your bill
        </Link>
      </section>

      <section aria-labelledby="month-h" className={section}>
        <h2 id="month-h" className="text-lg font-bold">
          This month, {period}
        </h2>
        {budget ? (
          <>
            <Meter
              label="Monthly budget used"
              value={budget.spent}
              max={budget.budget}
              text={`${formatPence(budget.spent)} spent of your ${formatPence(budget.budget)} budget`}
            />
            <p className="font-bold tabular-nums">
              {budget.remaining >= 0
                ? `${formatPence(budget.remaining)} left this month`
                : `${formatPence(-budget.remaining)} over budget this month`}
            </p>
          </>
        ) : (
          <p className="font-bold tabular-nums">{formatPence(month.total)} spent</p>
        )}

        <table className="w-full text-sm">
          <caption className="pb-1 text-left text-base font-bold">Spending by category</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Amount</th>
            </tr>
          </thead>
          <tbody>
            {month.byCategory.map((c) => (
              <tr key={c.category} className="align-top">
                <th scope="row" className="py-1 pr-(--space) text-left font-normal">
                  {c.category}
                  <span aria-hidden className="mt-1 block h-2 rounded-full bg-muted">
                    <span
                      className="block h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(0, (c.total * 100) / biggestCategory)}%` }}
                    />
                  </span>
                </th>
                <td className="py-1 text-right font-bold tabular-nums">{formatPence(c.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {month.refunds > 0 && (
          <p className="text-sm text-muted-foreground">
            Includes pending items. {formatPence(month.refunds)} of refunds already taken off.
          </p>
        )}
      </section>

      <section aria-labelledby="recent-h" className={section}>
        <h2 id="recent-h" className="text-lg font-bold">
          Recent transactions
        </h2>
        <ul>
          {recent.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-(--space) border-b border-border py-2 last:border-0">
              <div>
                <span className="block font-bold">{t.merchant}</span>
                <span className="text-sm text-muted-foreground">{formatShortDate(t.date)}</span>
                <FlagBadges flags={flags.get(t.id)!} />
              </div>
              <span className="font-bold tabular-nums">{t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount)}</span>
            </li>
          ))}
        </ul>
        <Link href="/account/spending" className={`${linkButton} self-start border-2 border-input`}>
          See all transactions
        </Link>
      </section>
    </div>
  );
}
