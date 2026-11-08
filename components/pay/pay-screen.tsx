"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { evidenceHref } from "@/lib/assistant/client";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { availableCredit, daysUntilDue, payoffEstimate } from "@/lib/finance";
import { formatLongDate, formatPence, formatShortDate } from "@/lib/format";
import { newPaymentId } from "@/lib/payments/client";
import { accountAfterPayments, parsePaymentAmount, paymentHistory, paymentOptions, type PaymentOption } from "@/lib/payments/rules";
import { usePreferences } from "@/lib/preferences/provider";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Account, Payment, Pence } from "@/lib/types";

const panel = "elevated rounded-xl bg-card p-(--space)";
const action = "h-auto min-h-(--target-min) w-full max-w-full whitespace-normal px-4 py-2 text-base font-bold scroll-mb-[calc(var(--target-min)*3)] sm:w-auto";
const textLink = "inline-flex min-h-(--target-min) items-center font-bold text-primary underline underline-offset-4";

type Stage =
  | { name: "choose" }
  /** `id` is taken here, once, so confirming twice is the same payment. */
  | { name: "review"; id: string; amount: Pence; kind: Payment["kind"]; label: string }
  | { name: "done"; payment: Payment }
  | { name: "failed"; message: string };

const whenDue = (days: number) => (days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : `${-days} days ago`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-bold tabular-nums">{value}</dd>
    </div>
  );
}

/** Heading of the current step. Takes focus when the step changes, so keyboard and screen reader users move with it. */
function StepHeading({ children }: { children: React.ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <h2 ref={heading} tabIndex={-1} className="text-lg font-bold focus:outline-none">
      {children}
    </h2>
  );
}

function Overview({ account, simple }: { account: Account; simple: boolean }) {
  const newer = account.currentBalance - account.statementBalance;
  const paid = account.statementBalance === 0;
  if (simple) {
    return (
      <section aria-labelledby="pay-owed" className={`flex flex-col gap-1 ${panel}`}>
        <h2 id="pay-owed" className="text-base font-semibold text-muted-foreground">
          {paid ? "Your bill" : "Your bill is"}
        </h2>
        {paid ? (
          <p className="text-lg font-bold">Your bill is paid.</p>
        ) : (
          <>
            <p className="text-xl font-bold leading-tight tracking-tight">
              <Money pence={account.statementBalance} />
            </p>
            <p className="font-bold">Due {formatLongDate(account.paymentDueDate)}</p>
            <p className="text-muted-foreground">The least you can pay is {formatPence(account.minimumPayment)}.</p>
          </>
        )}
        <p className="text-muted-foreground">
          You owe {formatPence(account.currentBalance)} in total{newer > 0 && !paid ? ", including spending since this bill" : ""}.
        </p>
      </section>
    );
  }
  return (
    <section aria-labelledby="pay-owed" className={`flex flex-col gap-3 ${panel}`}>
      <h2 id="pay-owed" className="text-lg font-bold">
        What you owe
      </h2>
      <dl className="flex flex-col gap-1">
        <Row label="Current balance" value={formatPence(account.currentBalance)} />
        <Row label="Statement balance" value={formatPence(account.statementBalance)} />
        <Row label="Minimum payment" value={formatPence(account.minimumPayment)} />
        <Row label="Payment due" value={paid ? "Nothing due" : `${formatLongDate(account.paymentDueDate)}, ${whenDue(daysUntilDue(account, DEMO_TODAY))}`} />
        <Row label="Available credit" value={formatPence(availableCredit(account))} />
      </dl>
      <p className="text-sm text-muted-foreground">
        Your statement balance is what&apos;s left of your last bill.
        {newer > 0 ? ` Your current balance also includes ${formatPence(newer)} of newer activity.` : " Your current balance is the same amount."}
      </p>
    </section>
  );
}

function optionNote(option: PaymentOption, account: Account) {
  const left = account.currentBalance - option.amount;
  if (option.id === "statement") return left > 0 ? `Clears this bill. ${formatPence(left)} would stay on your balance.` : "Clears this bill and your balance.";
  if (option.id === "minimum") return "The least you can pay on this bill.";
  return "Clears everything you owe, including newer activity.";
}

/** What paying this much every month would mean. Only useful when it wouldn't clear the bill straight away. */
function estimate(account: Account, amount: Pence) {
  if (amount >= account.statementBalance) return null;
  const { months, totalInterest } = payoffEstimate(account.statementBalance, account.apr, amount);
  return months === null
    ? "Estimate: paying this much each month wouldn't clear this bill."
    : `Estimate: paying this much each month would take about ${months} months and cost about ${formatPence(totalInterest ?? 0)} in interest at ${account.apr}% APR.`;
}

function Choose({ account, simple, onReview }: { account: Account; simple: boolean; onReview: (amount: Pence, kind: Payment["kind"], label: string) => void }) {
  const options = useMemo(() => paymentOptions(account), [account]);
  const [choice, setChoice] = useState<PaymentOption["id"] | "other">(options[0]?.id ?? "other");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  const typedAmount = parsePaymentAmount(typed, account.currentBalance);

  const next = () => {
    const option = options.find((o) => o.id === choice);
    if (option) return onReview(option.amount, option.kind, option.label);
    const result = parsePaymentAmount(typed, account.currentBalance);
    if (result.ok) return onReview(result.amount, "custom", "Other amount");
    setError(result.error);
    field.current?.focus();
  };

  const card = "flex min-h-(--target-min) cursor-pointer items-start gap-3 rounded-xl p-3 hairline has-[:checked]:bg-accent has-[:checked]:text-accent-foreground";
  return (
    <form
      noValidate
      className="flex flex-col gap-(--space)"
      onSubmit={(e) => {
        e.preventDefault();
        next();
      }}
    >
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-lg font-bold">How much do you want to pay?</legend>
        {options.map((o) => (
          <label key={o.id} className={card}>
            <input type="radio" name={`${id}-amount`} checked={choice === o.id} onChange={() => setChoice(o.id)} className="mt-[0.3em] size-[1.1em] shrink-0 accent-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap justify-between gap-x-3 font-bold">
                <span>{o.label}</span>
                <span className="tabular-nums">{formatPence(o.amount)}</span>
              </span>
              <span className="block text-sm">{optionNote(o, account)}</span>
              {!simple && o.id === "minimum" && <span className="block text-sm">{estimate(account, o.amount)}</span>}
            </span>
          </label>
        ))}
        <label className={card}>
          <input type="radio" name={`${id}-amount`} checked={choice === "other"} onChange={() => setChoice("other")} className="mt-[0.3em] size-[1.1em] shrink-0 accent-primary" />
          <span className="font-bold">Other amount</span>
        </label>
      </fieldset>

      {choice === "other" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-other`} className="font-bold">
            Amount in pounds
          </label>
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            Up to your current balance of {formatPence(account.currentBalance)}.
          </p>
          <Input
            ref={field}
            id={`${id}-other`}
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            aria-invalid={error !== ""}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
            onChange={(e) => {
              setTyped(e.target.value);
              setError("");
            }}
            className="h-auto min-h-(--target-min) bg-card text-base md:text-base"
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="flex items-start gap-1.5 font-bold text-destructive">
              <TriangleAlert aria-hidden className="mt-[0.2em] size-[1em] shrink-0" />
              {error}
            </p>
          )}
          {!simple && typedAmount.ok && <p className="text-sm text-muted-foreground">{estimate(account, typedAmount.amount)}</p>}
        </div>
      )}

      {!simple && <p className="text-sm text-muted-foreground">Estimates assume no new spending and the same interest rate. This is information, not advice.</p>}
      <Button type="submit" className={action}>
        Review payment
      </Button>
    </form>
  );
}

function Review({
  stage,
  account,
  simple,
  onConfirm,
  onBack,
}: {
  stage: Extract<Stage, { name: "review" }>;
  account: Account;
  simple: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const after = accountAfterPayments(account, [{ id: stage.id, amount: stage.amount, date: DEMO_TODAY, kind: stage.kind }]);
  const fullBill = stage.amount === account.statementBalance;
  const belowMinimum = stage.amount < account.minimumPayment;
  return (
    <section className={`flex flex-col gap-(--space) ${panel}`}>
      <StepHeading>{simple ? `Pay ${formatPence(stage.amount)}${fullBill ? ", your full bill" : ""}?` : "Review your payment"}</StepHeading>
      <dl className="flex flex-col gap-1">
        <Row label="Payment" value={formatPence(stage.amount)} />
        <Row label="Paying" value={`Card ending ${account.cardLast4}`} />
        {!simple && <Row label="Payment type" value={stage.label} />}
        <Row label="Balance after" value={formatPence(after.currentBalance)} />
        <Row label="Statement balance after" value={formatPence(after.statementBalance)} />
        {!simple && <Row label="Available credit after" value={formatPence(availableCredit(after))} />}
      </dl>
      {after.currentBalance > 0 && after.statementBalance === 0 && <p>This clears your bill. {formatPence(after.currentBalance)} stays on your balance.</p>}
      {belowMinimum && <p className="font-bold">This is less than your {formatPence(account.minimumPayment)} minimum payment.</p>}
      <p className="text-sm text-muted-foreground">This is a simulated payment in a demo. No real money moves.</p>
      <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap sm:justify-end">
        <Button onClick={onConfirm} className={action}>
          Confirm payment
        </Button>
        <Button variant="outline" onClick={onBack} className={`${action} border-input`}>
          Go back
        </Button>
      </div>
    </section>
  );
}

function Done({ payment, account, onUndo, onAnother, saved }: { payment: Payment; account: Account; onUndo: () => void; onAnother: () => void; saved: boolean }) {
  return (
    <section className={`flex flex-col gap-(--space) ${panel}`}>
      <StepHeading>
        <span className="flex items-center gap-2">
          <CircleCheck aria-hidden className="size-[1.2em] shrink-0 text-success" />
          Payment recorded
        </span>
      </StepHeading>
      <p>Your simulated payment of {formatPence(payment.amount)} is recorded and pending. No real money moved.</p>
      <dl className="flex flex-col gap-1">
        <Row label="Balance now" value={formatPence(account.currentBalance)} />
        <Row label="Statement balance now" value={formatPence(account.statementBalance)} />
        <Row label="Minimum payment now" value={formatPence(account.minimumPayment)} />
      </dl>
      {!saved && <p className="font-bold">We can&apos;t save on this device, so this payment will be lost if you reload the page.</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="outline" onClick={onUndo} className={`${action} border-input`}>
          Undo this payment
        </Button>
        {account.currentBalance > 0 && (
          <Button variant="outline" onClick={onAnother} className={`${action} border-input`}>
            Make another payment
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-(--space)">
        <Link href="/account" className={textLink}>
          Back to Home
        </Link>
        <Link href={evidenceHref([payment.id])} className={textLink}>
          See it in your transactions
        </Link>
      </div>
    </section>
  );
}

function History({ onUndo }: { onUndo: (id: string) => void }) {
  const { transactions, payments } = useAccount();
  const mine = new Set(payments.map((p) => p.id));
  const rows = paymentHistory(transactions);
  return (
    <section aria-labelledby="pay-history" className={`flex flex-col gap-2 ${panel}`}>
      <h2 id="pay-history" className="text-lg font-bold">
        Payment history
      </h2>
      <ul className="flex flex-col gap-2">
        {rows.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <span>
              <span className="font-bold tabular-nums">{formatPence(-t.amount)}</span> on {formatShortDate(t.date)}, {t.status}
            </span>
            {mine.has(t.id) && (
              <Button variant="outline" onClick={() => onUndo(t.id)} aria-label={`Undo ${formatPence(-t.amount)} payment`} className="h-auto min-h-(--target-min) border-input px-3 text-base font-bold scroll-mb-[calc(var(--target-min)*3)]">
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Simulated card payments: choose, review, confirm. Every figure comes from `useAccount()`, in both views. */
export function PayScreen() {
  const { account, ready, makePayment, undoPayment, payments, paymentsSaved } = useAccount();
  const { mode } = useMode();
  const { prefs } = usePreferences();
  const announce = useAnnounce();
  const simple = mode === "simple";
  const [stage, setStage] = useState<Stage>({ name: "choose" });
  const [notice, setNotice] = useState("");
  // Blocks a repeat before React has re-rendered. makePayment refuses a repeated id as well.
  const submitted = useRef(false);

  if (!ready) {
    return (
      <div className="flex flex-col gap-(--space)">
        <h1 className="text-xl font-bold">Pay</h1>
        <p role="status">Loading your account.</p>
      </div>
    );
  }

  const review = (amount: Pence, kind: Payment["kind"], label: string) => {
    submitted.current = false;
    setNotice("");
    setStage({ name: "review", id: newPaymentId(), amount, kind, label });
  };

  const confirm = () => {
    if (stage.name !== "review" || submitted.current) return;
    submitted.current = true;
    const result = makePayment(stage.amount, stage.kind, stage.id);
    if (result.ok) {
      setStage({ name: "done", payment: result.payment });
      const left = accountAfterPayments(account, [result.payment]).currentBalance;
      announce(`Payment of ${formatPence(result.payment.amount)} recorded. Your balance is now ${formatPence(left)}.`);
    } else {
      setStage({ name: "failed", message: result.message });
      announce(result.message);
    }
  };

  const undo = (id: string) => {
    const payment = payments.find((p) => p.id === id);
    if (!payment) return;
    undoPayment(id);
    setStage({ name: "choose" });
    const text = `Payment of ${formatPence(payment.amount)} undone. Your balance is back to ${formatPence(account.currentBalance + payment.amount)}.`;
    setNotice(text);
    announce(text);
  };

  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold">Pay</h1>
      {stage.name === "choose" && <p className="text-muted-foreground">This is a simulated payment in a demo. No real money moves.</p>}
      {stage.name !== "done" && <Overview account={account} simple={simple} />}

      {notice && (
        <p role="status" className={`${panel} font-bold`}>
          {notice}
        </p>
      )}

      {stage.name === "failed" && (
        <section className={`flex flex-col gap-(--space) ${panel}`}>
          <StepHeading>Payment not made</StepHeading>
          <p>{stage.message}</p>
          <Button onClick={() => setStage({ name: "choose" })} className={action}>
            Choose an amount
          </Button>
        </section>
      )}

      {stage.name === "choose" &&
        (account.currentBalance > 0 ? (
          <>
            {prefs.explanations === "stepByStep" && (
              <ol className="list-decimal pl-5">
                <li>Choose how much to pay.</li>
                <li>Check the details.</li>
                <li>Confirm the payment.</li>
              </ol>
            )}
            <Choose key={account.currentBalance} account={account} simple={simple} onReview={review} />
          </>
        ) : (
          <p className={`${panel} font-bold`}>You have nothing to pay.</p>
        ))}

      {stage.name === "review" && <Review stage={stage} account={account} simple={simple} onConfirm={confirm} onBack={() => setStage({ name: "choose" })} />}

      {stage.name === "done" && (
        <Done payment={stage.payment} account={account} saved={paymentsSaved} onUndo={() => undo(stage.payment.id)} onAnother={() => setStage({ name: "choose" })} />
      )}

      {stage.name !== "review" && <History onUndo={undo} />}
    </div>
  );
}
