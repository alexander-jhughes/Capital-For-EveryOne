"use client";

import { PauseCircle } from "lucide-react";
import Link from "next/link";
import { SUGGESTED_QUESTIONS } from "@/lib/assistant/client";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { daysUntilDue } from "@/lib/finance";
import { formatLongDate, formatPence } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import { useAskDial } from "../assistant/ask-dial";

/** Simple Home: what you owe, when, one action. Everything else is a question away. */
export function SimpleHome() {
  const { account, settings } = useAccount();
  const { openAsk } = useAskDial();
  const days = daysUntilDue(account, DEMO_TODAY);
  const when = days === 0 ? "That's today." : days === 1 ? "That's tomorrow." : days > 0 ? `That's in ${days} days.` : `That was ${-days} days ago.`;
  const threshold = settings.singlePurchaseThreshold;

  return (
    <div className="flex flex-col gap-(--space)">
      <p className="text-sm text-muted-foreground">Credit card ending {account.cardLast4}</p>
      <h1 className="text-xl font-bold leading-tight">You owe {formatPence(account.statementBalance)}.</h1>
      <p className="text-lg font-bold">
        Due {formatLongDate(account.paymentDueDate)}. <span className="font-normal">{when}</span>
      </p>
      <p>
        That&apos;s your full bill. If you can&apos;t pay it all, the least you need to pay is {formatPence(account.minimumPayment)}.
      </p>
      <Link
        href="/account/pay"
        className="flex min-h-(--target-min) w-full items-center justify-center rounded-lg bg-primary px-6 text-lg font-bold text-primary-foreground"
      >
        Pay my bill
      </Link>

      <p className="flex items-start gap-2 rounded-lg border-2 border-border bg-card p-(--space)">
        <PauseCircle aria-hidden className="mt-1 size-[1.2em] shrink-0" />
        <span>
          {settings.enabled
            ? threshold !== null
              ? `Spend Pause is on: we'll check with you before any purchase over ${formatPence(threshold)}.`
              : "Spend Pause is on."
            : "Spend Pause is off."}{" "}
          <Link href="/account/spend-pause" className="inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4">
            {settings.enabled ? "Change Spend Pause" : "Turn on Spend Pause"}
          </Link>
        </span>
      </p>

      <section aria-labelledby="ask-home-h" className="flex flex-col gap-2">
        <h2 id="ask-home-h" className="text-lg font-bold">
          Ask about your money
        </h2>
        <ul className="flex flex-col gap-2">
          {SUGGESTED_QUESTIONS.slice(0, 3).map(({ question }) => (
            <li key={question}>
              <button
                type="button"
                onClick={() => openAsk(question)}
                aria-haspopup="dialog"
                className="min-h-(--target-min) w-full rounded-lg border-2 border-input bg-card px-4 py-2 text-left font-bold hover:bg-muted"
              >
                {question}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
