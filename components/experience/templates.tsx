"use client";

import { ArrowRight, CalendarClock, ChartColumn, CreditCard, Receipt, Repeat } from "lucide-react";
import Link from "next/link";
import { evidenceHref, knownEvidence } from "@/lib/assistant/client";
import type { ExperienceTemplate } from "@/lib/assistant/experience";
import { DEMO_TODAY } from "@/lib/demo-clock";
import {
  availableCredit,
  daysUntilDue,
  findPossibleDuplicates,
  findPriceChanges,
  flagTransactions,
  monthOverMonth,
  payoffEstimate,
  totalByMerchant,
} from "@/lib/finance";
import { formatDate, formatLongDate, formatMonth, formatPence } from "@/lib/format";
import { usePreferences } from "@/lib/preferences/provider";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Transaction } from "@/lib/types";
import { FlagBadges } from "../account/flag-badges";
import { Money } from "../ui/money";

// Every figure below comes from lib/finance or the account record. Simple and Detailed read the same values;
// Simple shows fewer of them, never different ones, and keeps every warning.

interface TemplateProps {
  evidenceIds: string[];
  onNavigate?: () => void;
}

const nextStep =
  "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 self-start rounded-[1.4em] bg-primary px-[1.2em] font-bold text-primary-foreground";

const when = (days: number) => (days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : `${-days} days ago`);
const signed = (t: Transaction) => (t.amount < 0 ? `+${formatPence(-t.amount)}` : formatPence(t.amount));

function useCommon() {
  const { mode } = useMode();
  const { prefs } = usePreferences();
  const acct = useAccount();
  return { simple: mode === "simple", steps: prefs.explanations === "stepByStep", ...acct };
}

/** Numbered explanation, shown when the person asked for step-by-step explanations. */
function Steps({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-col gap-2 rounded-lg bg-accent p-3 text-accent-foreground">
      {items.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span aria-hidden className="flex size-[1.6em] shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
            {i + 1}
          </span>
          <span>
            <span className="sr-only">Step {i + 1}: </span>
            {s}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Stat({ label, children, big = false }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className={big ? "text-xl font-bold leading-tight tracking-tight" : "text-lg font-bold"}>{children}</dd>
    </div>
  );
}

function TxRows({ txns, highlight }: { txns: Transaction[]; highlight?: Set<string> }) {
  const { transactions } = useAccount();
  const flags = flagTransactions(transactions);
  return (
    <ul>
      {txns.map((t) => (
        <li key={t.id} className="flex items-center gap-3 border-b py-2 last:border-0">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent font-bold text-accent-foreground">
            {t.merchant[0]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold">{t.merchant}</span>
            <span className="text-sm text-muted-foreground">
              {t.category}, {formatDate(t.date)}
            </span>
            <FlagBadges flags={flags.get(t.id)!} highlighted={highlight?.has(t.id)} />
          </span>
          <span className={`shrink-0 font-bold ${t.amount < 0 ? "text-success" : ""}`}>{signed(t)}</span>
        </li>
      ))}
    </ul>
  );
}

function Missing({ text }: { text: string }) {
  return <p className="rounded-lg bg-muted p-3 text-muted-foreground">{text}</p>;
}

/* A. Statement ------------------------------------------------------------------------------------------- */
export function StatementTemplate({ evidenceIds, onNavigate }: TemplateProps) {
  const { simple, steps, account, transactions } = useCommon();
  const days = daysUntilDue(account, DEMO_TODAY);
  const paid = account.statementBalance === 0;
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const evidence = knownEvidence(evidenceIds, new Set(byId.keys())).map((id) => byId.get(id)!);
  const recent = evidence.length ? evidence.slice(0, simple ? 2 : 5) : [...transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, simple ? 0 : 4);

  return (
    <div className="flex flex-col gap-3">
      {simple ? (
        <div>
          <p className="text-muted-foreground">Your bill is</p>
          <p className="text-xl font-bold leading-tight tracking-tight">
            <Money pence={account.statementBalance} />
          </p>
          <p className="mt-1 font-bold">{paid ? "Your bill is paid. Nothing is due." : `Due ${formatLongDate(account.paymentDueDate)}, ${when(days)}`}</p>
          <p className="text-muted-foreground">You owe {formatPence(account.currentBalance)} in total{paid ? "" : ", including spending since this bill"}.</p>
        </div>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Current balance" big>
            <Money pence={account.currentBalance} />
          </Stat>
          <Stat label="Statement balance" big>
            <Money pence={account.statementBalance} />
          </Stat>
          <Stat label="Minimum payment">{formatPence(account.minimumPayment)}</Stat>
          <Stat label="Due">{paid ? "Nothing due" : `${formatDate(account.paymentDueDate)}, ${when(days)}`}</Stat>
          <Stat label="Available credit">{formatPence(availableCredit(account))}</Stat>
          <Stat label="Credit limit">{formatPence(account.creditLimit)}</Stat>
        </dl>
      )}
      {steps && (
        <Steps
          items={[
            `Your statement balance, ${formatPence(account.statementBalance)}, is what you owed when your last statement was made.`,
            paid ? "You have paid it, so nothing is due." : `It is due on ${formatLongDate(account.paymentDueDate)}.`,
            `Your current balance, ${formatPence(account.currentBalance)}, also includes newer spending.`,
          ]}
        />
      )}
      {recent.length > 0 && (
        <div>
          <h4 className="text-sm font-bold text-muted-foreground">{evidence.length ? "Transactions behind this" : "Latest transactions"}</h4>
          <TxRows txns={recent} />
        </div>
      )}
      {account.currentBalance > 0 && (
        <Link href="/account/pay" onClick={onNavigate} className={nextStep}>
          {paid ? "Make a payment" : "Pay my bill"}
        </Link>
      )}
    </div>
  );
}

/* B. Spending -------------------------------------------------------------------------------------------- */
export function SpendingTemplate({ onNavigate }: TemplateProps) {
  const { simple, steps, transactions } = useCommon();
  const { thisMonth, lastMonthSamePeriod, difference } = monthOverMonth(transactions, DEMO_TODAY);
  if (thisMonth.ids.length === 0) return <Missing text="There's no spending this month yet." />;
  const inMonth = transactions.filter((t) => thisMonth.ids.includes(t.id));
  const merchants = [...new Set(inMonth.map((t) => t.merchant))]
    .map((m) => totalByMerchant(inMonth, m))
    .filter((m) => m.total > 0)
    .sort((a, b) => b.total - a.total);
  const top = thisMonth.byCategory[0];
  const maxCat = Math.max(...thisMonth.byCategory.map((c) => c.total), 1);
  const month = formatMonth(thisMonth.from);
  const lastMonth = formatMonth(lastMonthSamePeriod.from);
  const comparison =
    difference === 0
      ? `the same as the same days in ${lastMonth}`
      : `${formatPence(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than the same days in ${lastMonth}`;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-muted-foreground">Spent so far in {month}</p>
        <p className="text-xl font-bold leading-tight tracking-tight">
          <Money pence={thisMonth.total} />
        </p>
        <p className="mt-1">That&apos;s {comparison}.</p>
        {simple && top && (
          <p className="text-muted-foreground">
            Most went on {top.category.toLowerCase()}: {formatPence(top.total)}.
          </p>
        )}
      </div>
      {steps && (
        <Steps
          items={[
            `This adds up everything you bought from 1 ${month}, minus refunds.`,
            `It compares with the same days of ${lastMonth} (${formatPence(lastMonthSamePeriod.total)}).`,
            top ? `Your biggest category is ${top.category.toLowerCase()}.` : "Your categories are below.",
          ]}
        />
      )}
      {!simple && (
        <div className="grid gap-4 sm:grid-cols-2">
          <table className="w-full table-fixed [overflow-wrap:anywhere]">
            <caption className="pb-1 text-left text-sm font-bold text-muted-foreground">By category</caption>
            <thead className="sr-only">
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {thisMonth.byCategory.map((c) => (
                <tr key={c.category}>
                  <th scope="row" className="py-1 pr-2 text-left font-semibold">
                    {c.category}
                    <span aria-hidden className="mt-1 block h-1.5 rounded-full bg-chart-track">
                      <span className="block h-full rounded-full bg-chart" style={{ width: `${(Math.max(0, c.total) * 100) / maxCat}%` }} />
                    </span>
                  </th>
                  <td className="w-[40%] py-1 text-right align-top font-bold">{formatPence(c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <h4 className="pb-1 text-sm font-bold text-muted-foreground">Top shops</h4>
            <ol className="flex flex-col">
              {merchants.slice(0, 5).map((m, i) => (
                <li key={m.merchant} className="flex justify-between gap-2 border-b py-1.5 last:border-0">
                  <span>
                    <span className="sr-only">{i + 1}. </span>
                    {m.merchant} <span className="text-sm text-muted-foreground">({m.count})</span>
                  </span>
                  <span className="font-bold">{formatPence(m.total)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
      <Link href="/account/spending" onClick={onNavigate} className={nextStep}>
        See my spending <ArrowRight aria-hidden className="size-[1em]" />
      </Link>
    </div>
  );
}

/* C. Subscriptions --------------------------------------------------------------------------------------- */
export function SubscriptionsTemplate({ onNavigate }: TemplateProps) {
  const { simple, steps, transactions } = useCommon();
  const changes = new Map(findPriceChanges(transactions).map((c) => [c.merchant, c]));
  const charges = transactions.filter((t) => t.category === "Subscriptions" && t.amount > 0);
  const subs = [...new Set(charges.map((t) => t.merchant))].map((m) => {
    const mine = charges.filter((t) => t.merchant === m).sort((a, b) => b.date.localeCompare(a.date));
    return { merchant: m, latest: mine[0], change: changes.get(m) ?? null };
  });
  if (subs.length === 0) return <Missing text="Dial can't see any subscriptions in your transactions." />;
  const ids = subs.flatMap((s) => (s.change ? [s.change.before.id, s.change.after.id] : [s.latest.id]));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-lg font-bold">
        You have {subs.length} {subs.length === 1 ? "subscription" : "subscriptions"}
        {changes.size > 0 ? `, and ${changes.size === 1 ? "one has" : `${changes.size} have`} changed price` : ""}.
      </p>
      {simple ? (
        <ul className="flex flex-col gap-2">
          {subs.map((s) => (
            <li key={s.merchant} className="flex items-center justify-between gap-3 rounded-lg bg-muted px-3 py-2">
              <span className="min-w-0">
                <span className="block font-bold">{s.merchant}</span>
                {s.change && (
                  <span className="text-sm font-bold text-attention">
                    {s.change.change > 0 ? "Up" : "Down"} {formatPence(Math.abs(s.change.change))} from {formatPence(s.change.before.amount)}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-lg font-bold">{formatPence(s.latest.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <table className="w-full table-fixed [overflow-wrap:anywhere]">
          <caption className="sr-only">Subscriptions</caption>
          <thead>
            <tr className="text-left text-sm text-muted-foreground">
              <th scope="col" className="pb-1 font-bold">
                Subscription
              </th>
              <th scope="col" className="pb-1 text-right font-bold">
                Now
              </th>
              <th scope="col" className="pb-1 text-right font-bold">
                Before
              </th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.merchant} className="border-t">
                <th scope="row" className="py-2 text-left">
                  <span className="block font-bold">{s.merchant}</span>
                  <span className="text-sm font-normal text-muted-foreground">Last charged {formatDate(s.latest.date)}</span>
                </th>
                <td className="py-2 text-right font-bold">{formatPence(s.latest.amount)}</td>
                <td className="py-2 text-right">
                  {s.change ? (
                    <>
                      {formatPence(s.change.before.amount)}
                      <span className="block text-sm font-bold text-attention">
                        {s.change.change > 0 ? "Up" : "Down"} {formatPence(Math.abs(s.change.change))}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">No change</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {steps && (
        <Steps
          items={["Dial looks for charges marked as subscriptions.", "It compares each one with the charge before it.", "A price change is shown when the amount is different."]}
        />
      )}
      {!simple && <p className="text-sm text-muted-foreground">Based on charges so far. Dial can&apos;t see subscriptions that haven&apos;t charged your card yet.</p>}
      <Link href={evidenceHref(ids)} onClick={onNavigate} className={nextStep}>
        See the charges <ArrowRight aria-hidden className="size-[1em]" />
      </Link>
    </div>
  );
}

/* D. Transaction ----------------------------------------------------------------------------------------- */
export function TransactionTemplate({ evidenceIds, onNavigate }: TemplateProps) {
  const { simple, steps, transactions } = useCommon();
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const ids = knownEvidence(evidenceIds, new Set(byId.keys()));
  if (ids.length === 0)
    return (
      <div className="flex flex-col gap-3">
        <Missing text="Dial didn't point to a specific transaction for this answer." />
        <Link href="/account/spending" onClick={onNavigate} className={nextStep}>
          Look through my transactions
        </Link>
      </div>
    );
  const txns = ids.map((id) => byId.get(id)!);
  const dup = findPossibleDuplicates(transactions).find((d) => ids.includes(d.first.id) && ids.includes(d.second.id));
  const flags = flagTransactions(transactions);
  const headline = dup
    ? `${dup.first.merchant} charged you ${formatPence(dup.first.amount)} twice: ${formatLongDate(dup.first.date)} and ${formatLongDate(dup.second.date)}.`
    : txns.length === 1
      ? `${txns[0].merchant}, ${signed(txns[0])} on ${formatLongDate(txns[0].date)}.`
      : `${txns.length} transactions match.`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-lg font-bold leading-snug">{headline}</p>
      {dup && <p className="text-attention">This may be a mistake if you only shopped once. Check both charges before deciding what to do.</p>}
      {simple ? (
        <TxRows txns={txns.slice(0, 2)} highlight={new Set(ids)} />
      ) : (
        <ul className="flex flex-col gap-2">
          {txns.map((t) => {
            const f = flags.get(t.id)!;
            return (
              <li key={t.id} className="rounded-lg bg-muted p-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
                  <Stat label="Shop">{t.merchant}</Stat>
                  <Stat label="Amount">{signed(t)}</Stat>
                  <Stat label="Date">{formatDate(t.date)}</Stat>
                  <Stat label="Status">{t.status === "pending" ? "Pending" : "Completed"}</Stat>
                </dl>
                <FlagBadges flags={f} />
                {f.refund && <p className="mt-1 text-sm">This is money back from {t.merchant}{t.status === "pending" ? " and hasn't finished going through yet" : ""}.</p>}
              </li>
            );
          })}
        </ul>
      )}
      {steps && <Steps items={["Check the shop, amount and date.", "Pending means it hasn't finished going through.", "If something looks wrong, look at it in Spending."]} />}
      <Link href={evidenceHref(ids)} onClick={onNavigate} className={nextStep}>
        See {ids.length === 1 ? "it" : "them"} in Spending <ArrowRight aria-hidden className="size-[1em]" />
      </Link>
    </div>
  );
}

/* E. Payment --------------------------------------------------------------------------------------------- */
export function PaymentTemplate({ onNavigate }: TemplateProps) {
  const { simple, steps, account } = useCommon();
  const days = daysUntilDue(account, DEMO_TODAY);
  const atMinimum = payoffEstimate(account.statementBalance, account.apr, account.minimumPayment);

  if (account.statementBalance === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xl font-bold leading-tight tracking-tight">Your bill is paid.</p>
        <p className="text-muted-foreground">Nothing is due. You owe {formatPence(account.currentBalance)} in total.</p>
        {account.currentBalance > 0 && (
          <Link href="/account/pay" onClick={onNavigate} className={nextStep}>
            Make a payment <ArrowRight aria-hidden className="size-[1em]" />
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-muted-foreground">Next payment due {formatLongDate(account.paymentDueDate)}</p>
        <p className="text-xl font-bold leading-tight tracking-tight">
          <Money pence={account.statementBalance} />
        </p>
        <p className="mt-1 font-bold">That is {when(days)}.</p>
        {simple && <p className="text-muted-foreground">The least you can pay is {formatPence(account.minimumPayment)}.</p>}
      </div>
      {!simple && (
        <ul className="flex flex-col gap-2">
          <li className="rounded-lg bg-muted p-3">
            <p className="flex justify-between gap-2 font-bold">
              <span>Full statement balance</span>
              <span>{formatPence(account.statementBalance)}</span>
            </p>
            <p className="text-sm text-muted-foreground">Clears the balance on your statement.</p>
          </li>
          <li className="rounded-lg bg-muted p-3">
            <p className="flex justify-between gap-2 font-bold">
              <span>Minimum payment</span>
              <span>{formatPence(account.minimumPayment)}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              {atMinimum.months === null
                ? "Paying only the minimum would not clear this balance."
                : `Estimate: paying only the minimum each month would take about ${atMinimum.months} months and cost about ${formatPence(atMinimum.totalInterest ?? 0)} in interest at ${account.apr}% APR.`}
            </p>
          </li>
          <li className="rounded-lg bg-muted p-3">
            <p className="font-bold">A different amount</p>
            <p className="text-sm text-muted-foreground">
              Any amount up to your current balance of {formatPence(account.currentBalance)}.
            </p>
          </li>
        </ul>
      )}
      {steps && (
        <Steps
          items={[
            `Choose how much to pay: the full ${formatPence(account.statementBalance)}, the minimum ${formatPence(account.minimumPayment)}, or another amount.`,
            `Pay by ${formatLongDate(account.paymentDueDate)}.`,
            "You'll be asked to confirm before anything is paid.",
          ]}
        />
      )}
      {!simple && <p className="text-sm text-muted-foreground">Estimates assume no new spending and the same interest rate. This is information, not advice.</p>}
      <Link href="/account/pay" onClick={onNavigate} className={nextStep}>
        Choose how much to pay <ArrowRight aria-hidden className="size-[1em]" />
      </Link>
    </div>
  );
}

const META: Record<Exclude<ExperienceTemplate, "general">, { title: string; Icon: typeof Receipt; Body: (p: TemplateProps) => React.ReactNode }> = {
  statement: { title: "Your statement", Icon: Receipt, Body: StatementTemplate },
  spending: { title: "Your spending", Icon: ChartColumn, Body: SpendingTemplate },
  subscriptions: { title: "Your subscriptions", Icon: Repeat, Body: SubscriptionsTemplate },
  transaction: { title: "Transactions", Icon: CreditCard, Body: TransactionTemplate },
  payment: { title: "Your next payment", Icon: CalendarClock, Body: PaymentTemplate },
};

/** The financial card Dial shows for a backend-chosen template. "general" (or anything unknown) renders nothing. */
export function ExperienceCard({ template, evidenceIds, onNavigate }: { template: ExperienceTemplate } & TemplateProps) {
  if (template === "general" || !(template in META)) return null;
  const { title, Icon, Body } = META[template as keyof typeof META];
  return (
    <section aria-label={title} data-template={template} className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space) text-card-foreground">
      <h3 className="flex items-center gap-2 text-sm font-bold text-muted-foreground">
        <Icon aria-hidden className="size-[1.15em] text-primary" />
        {title}
      </h3>
      <Body evidenceIds={evidenceIds} onNavigate={onNavigate} />
    </section>
  );
}
