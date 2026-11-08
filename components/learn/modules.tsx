"use client";

// Credit Learning Lab modules. Start from the person's own figures (from the account every screen reads), let them
// change any of them, and show the effect. All arithmetic is lib/learn/credit.ts; nothing here calculates money.
import { useState } from "react";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { availableCredit, daysUntilDue } from "@/lib/finance";
import { formatLongDate, formatPence } from "@/lib/format";
import {
  balanceForUtilisation,
  durationText,
  ILLUSTRATIVE,
  MINIMUM_RULE_TEXT,
  monthlyInterest,
  repay,
  utilisationPercent,
  type RepaymentResult,
} from "@/lib/learn/credit";
import { usePreferences } from "@/lib/preferences/provider";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import { cardClass, Meter } from "../ui/panel";
import { Illustrative, NumberField, parseAmount, parseRate, poundsText } from "./fields";

const result = `${cardClass} flex flex-col gap-2 border-l-4 border-primary`;
const GUIDE = 30;

function Explain({ items }: { items: [string, string][] }) {
  return (
    <dl className="flex flex-col gap-3">
      {items.map(([t, d]) => (
        <div key={t}>
          <dt className="font-bold">{t}</dt>
          <dd>{d}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UtilisationSimulator() {
  const { account } = useAccount();
  const { prefs } = usePreferences();
  const [balance, setBalance] = useState(poundsText(account.currentBalance));
  const [limit, setLimit] = useState(poundsText(account.creditLimit));
  const [payment, setPayment] = useState("0");
  const b = parseAmount(balance);
  const l = parseAmount(limit, { min: 100 });
  const p = parseAmount(payment);
  const ok = b.value !== null && l.value !== null && p.value !== null;
  const after = ok ? Math.max(0, b.value! - p.value!) : 0;
  const now = ok ? utilisationPercent(b.value!, l.value!)! : 0;
  const then = ok ? utilisationPercent(after, l.value!)! : 0;
  const guideBalance = ok ? balanceForUtilisation(l.value!, GUIDE) : 0;
  return (
    <div className="flex flex-col gap-(--space)">
      <Explain
        items={[
          ["What it is", "Credit utilisation is how much of your limit you're using: your balance divided by your limit."],
          ["Why it matters", "Lenders may look at it when you apply for credit. Using less of your limit is often seen more favourably. A common rule of thumb is to stay under 30%, but it's a guide, not a rule."],
        ]}
      />
      <div className="grid grid-cols-1 gap-(--space) sm:grid-cols-2">
        <NumberField label="Balance" value={balance} onChange={setBalance} error={b.error} hint="Starts at your current balance." />
        <NumberField
          label="Credit limit"
          value={limit}
          onChange={setLimit}
          error={l.error}
          presets={[1000, 1500, 3000].map((x) => ({ label: `£${x.toLocaleString("en-GB")}`, value: String(x) }))}
        />
      </div>
      <NumberField
        label="A payment you might make"
        value={payment}
        onChange={setPayment}
        error={p.error}
        presets={[
          { label: "None", value: "0" },
          { label: "£100", value: "100" },
          { label: "£250", value: "250" },
          { label: `Your bill, ${formatPence(account.statementBalance)}`, value: poundsText(account.statementBalance) },
        ]}
      />
      {ok && (
        <section aria-labelledby="util-result" className={result}>
          <h2 id="util-result" className="text-lg font-bold">
            Your utilisation
          </h2>
          <p role="status" aria-atomic="true" className="text-lg">
            Now <strong>{now}%</strong>
            {p.value! > 0 && (
              <>
                . After paying {formatPence(Math.min(p.value!, b.value!))}: <strong>{then}%</strong>
              </>
            )}
            .{then > 100 && " That's over the limit."}
          </p>
          {prefs.charts === "show" && (
            <Meter label="Utilisation after the payment" value={Math.min(100, then)} valueText={`${then}% of the limit`} marker={GUIDE} markerLabel={`The line marks ${GUIDE}%`} tone={then > 100 ? "attention" : "chart"} />
          )}
          <p>
            {after <= guideBalance
              ? `At ${formatPence(after)} you'd be at or under ${GUIDE}% of a ${formatPence(l.value!)} limit.`
              : `To be at or under ${GUIDE}%, the balance would need to be ${formatPence(guideBalance)} or less: ${formatPence(after - guideBalance)} lower.`}
          </p>
          <p className="text-sm text-muted-foreground">This shows a share of your limit only. It isn&apos;t a credit score, and it doesn&apos;t predict a lender&apos;s decision.</p>
        </section>
      )}
    </div>
  );
}

function PlanSummary({ title, r }: { title: string; r: RepaymentResult }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/60 p-3">
      <h3 className="font-bold">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
        <dt>First payment</dt>
        <dd className="text-right font-bold">{formatPence(r.firstPayment)}</dd>
        <dt>Time to clear</dt>
        <dd className="text-right font-bold">{r.neverClears ? "Never" : durationText(r.months)}</dd>
        <dt>Interest paid</dt>
        <dd className="text-right font-bold">{r.totalInterest === null ? "Not worked out" : formatPence(r.totalInterest)}</dd>
      </dl>
    </div>
  );
}

function YearlyTable({ caption, plans }: { caption: string; plans: { name: string; r: RepaymentResult }[] }) {
  const years = [...new Set(plans.flatMap((p) => p.r.yearly.filter((y) => y.month % 12 === 0).map((y) => y.month / 12)))].sort((a, b) => a - b).slice(0, 11);
  const at = (r: RepaymentResult, year: number) => {
    const row = r.yearly.find((y) => y.month === year * 12);
    return row ? formatPence(row.balance) : r.months !== null && r.months < year * 12 ? "Paid off" : "";
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left [&_td]:py-1 [&_td]:text-right [&_th]:py-1">
        <caption className="pb-1 text-left font-bold">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">After</th>
            {plans.map((p) => (
              <th key={p.name} scope="col" className="text-right">
                {p.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((y) => (
            <tr key={y} className="border-t">
              <th scope="row" className="font-normal">
                {y === 0 ? "Today" : `${y} ${y === 1 ? "year" : "years"}`}
              </th>
              {plans.map((p) => (
                <td key={p.name}>{at(p.r, y)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MinimumPaymentExplainer() {
  const { account } = useAccount();
  const simple = useMode().mode === "simple";
  const [balance, setBalance] = useState(poundsText(account.statementBalance));
  const [extra, setExtra] = useState("25");
  const b = parseAmount(balance, { min: 100 });
  const e = parseAmount(extra);
  const min = b.value !== null ? repay(b.value, account.apr, { kind: "minimum" }) : null;
  const more = b.value !== null && e.value !== null ? repay(b.value, account.apr, { kind: "minimum", extra: e.value }) : null;
  const saved = min && more && min.totalInterest !== null && more.totalInterest !== null ? min.totalInterest - more.totalInterest : null;
  const sooner = min && more && min.months !== null && more.months !== null ? min.months - more.months : null;
  return (
    <div className="flex flex-col gap-(--space)">
      <Explain
        items={[
          ["What it is", `The minimum payment is the least you must pay by the due date to keep the account up to date. Your minimum this month is ${formatPence(account.minimumPayment)}.`],
          ["Why it matters", "Missing it can mean a late fee and a missed payment on your credit file. Paying it on time avoids both."],
          ["The catch", "Paying only the minimum keeps the account in order, but the rest carries over and interest is usually charged on it, so the balance can take a long time to clear."],
        ]}
      />
      <div className="grid grid-cols-1 gap-(--space) sm:grid-cols-2">
        <NumberField label="Balance to pay off" value={balance} onChange={setBalance} error={b.error} hint="Starts at your statement balance." />
        <NumberField
          label="Extra each month"
          value={extra}
          onChange={setExtra}
          error={e.error}
          presets={["10", "25", "50", "100"].map((x) => ({ label: `+£${x}`, value: x }))}
        />
      </div>
      {min && more && (
        <section aria-labelledby="min-result" className={result}>
          <h2 id="min-result" className="text-lg font-bold">
            Minimum only, or a little more
          </h2>
          <p role="status" aria-atomic="true" className="text-lg">
            {saved !== null && sooner !== null && e.value! > 0
              ? `Paying ${formatPence(e.value!)} more each month clears it ${durationText(sooner)} sooner and costs ${formatPence(saved)} less in interest.`
              : `Paying only the minimum would take ${durationText(min.months)}.`}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <PlanSummary title="Minimum only" r={min} />
            <PlanSummary title={`Minimum + ${formatPence(e.value ?? 0)}`} r={more} />
          </div>
          {!simple && (
            <YearlyTable
              caption="Balance left at the end of each year"
              plans={[
                { name: "Minimum only", r: min },
                { name: "With the extra", r: more },
              ]}
            />
          )}
          <Illustrative>
            {ILLUSTRATIVE} Minimum payments here are {MINIMUM_RULE_TEXT}, at your card&apos;s {account.apr}% APR.
          </Illustrative>
        </section>
      )}
    </div>
  );
}

export function InterestCalculator() {
  const { account } = useAccount();
  const [balance, setBalance] = useState(poundsText(account.currentBalance));
  const [apr, setApr] = useState(String(account.apr));
  const [payment, setPayment] = useState("100");
  const b = parseAmount(balance, { min: 100 });
  const r = parseRate(apr);
  const p = parseAmount(payment, { min: 100 });
  const ok = b.value !== null && r.value !== null && p.value !== null;
  const plan = ok ? repay(b.value!, r.value!, { kind: "fixed", amount: p.value! }) : null;
  const first = ok ? monthlyInterest(b.value!, r.value!) : 0;
  return (
    <div className="flex flex-col gap-(--space)">
      <Explain
        items={[
          ["APR", "The annual percentage rate: the yearly cost of borrowing. Each month, interest is roughly a twelfth of it, charged on what you still owe."],
          ["How to use this", "Change the balance, the rate and what you'd pay each month, and see how long it takes and what it costs."],
        ]}
      />
      <div className="grid grid-cols-1 gap-(--space) sm:grid-cols-3">
        <NumberField label="Balance" value={balance} onChange={setBalance} error={b.error} />
        <NumberField label="APR" value={apr} onChange={setApr} error={r.error} suffix="%" presets={[{ label: `Yours, ${account.apr}%`, value: String(account.apr) }]} />
        <NumberField label="Paid each month" value={payment} onChange={setPayment} error={p.error} presets={["50", "100", "200"].map((x) => ({ label: `£${x}`, value: x }))} />
      </div>
      {plan && (
        <section aria-labelledby="int-result" className={result}>
          <h2 id="int-result" className="text-lg font-bold">
            What it would cost
          </h2>
          {plan.neverClears ? (
            <p role="status" className="text-lg font-bold text-attention">
              {formatPence(p.value!)} a month doesn&apos;t cover the first month&apos;s interest of {formatPence(first)}, so the balance would never go down.
            </p>
          ) : (
            <p role="status" aria-atomic="true" className="text-lg">
              Paying {formatPence(p.value!)} a month clears {formatPence(b.value!)} in <strong>{durationText(plan.months)}</strong>
              {plan.totalInterest !== null && (
                <>
                  , with <strong>{formatPence(plan.totalInterest)}</strong> of interest
                </>
              )}
              .
            </p>
          )}
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
            <dt>Interest in the first month</dt>
            <dd className="text-right font-bold">{formatPence(first)}</dd>
            {plan.totalPaid !== null && (
              <>
                <dt>Total paid</dt>
                <dd className="text-right font-bold">{formatPence(plan.totalPaid)}</dd>
              </>
            )}
          </dl>
          <Illustrative>{ILLUSTRATIVE}</Illustrative>
        </section>
      )}
    </div>
  );
}

export function StatementExplainer() {
  const { account, transactions } = useAccount();
  const days = daysUntilDue(account, DEMO_TODAY);
  const pending = transactions.filter((t) => t.status === "pending" && t.amount > 0 && t.category !== "Payments");
  const pendingTotal = pending.reduce((s, t) => s + t.amount, 0);
  const rows: [string, string, string][] = [
    ["Statement balance", formatPence(account.statementBalance), "What you owed on the day your statement was made. It doesn't change when you spend more."],
    ["Current balance", formatPence(account.currentBalance), "What you owe right now: the statement balance, plus spending since, minus payments and refunds since."],
    ["Minimum payment", formatPence(account.minimumPayment), "The least you must pay by the due date to keep the account up to date."],
    ["Payment due date", `${formatLongDate(account.paymentDueDate)}${days >= 0 ? `, ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}` : ""}`, "Pay at least the minimum by this date."],
    ["Pending transactions", pending.length ? `${pending.length} ${pending.length === 1 ? "item" : "items"}, ${formatPence(pendingTotal)}` : "None", "Purchases still being processed. They count towards your current balance, and can change slightly or drop off before they settle."],
    ["Available credit", formatPence(availableCredit(account)), "Your credit limit minus your current balance."],
  ];
  return (
    <div className="flex flex-col gap-(--space)">
      <p>Here is each figure on a card statement, with yours beside it.</p>
      <ul className="flex flex-col gap-2">
        {rows.map(([term, yours, meaning]) => (
          <li key={term} className={`${cardClass} flex flex-col gap-1`}>
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="font-bold">{term}</span>
              <span className="font-bold text-primary">
                <span className="sr-only">Yours: </span>
                {yours}
              </span>
            </span>
            <span>{meaning}</span>
          </li>
        ))}
      </ul>
      <section aria-labelledby="free-h" className={`${cardClass} flex flex-col gap-1`}>
        <h2 id="free-h" className="font-bold">
          Interest-free periods
        </h2>
        <p>
          Many cards don&apos;t charge interest on purchases if the whole statement balance is paid by the due date. Pay less than that, and interest is usually charged. Each card&apos;s terms say exactly how its interest-free period works, so check yours.
        </p>
      </section>
    </div>
  );
}
