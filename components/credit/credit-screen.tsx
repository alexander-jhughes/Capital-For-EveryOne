"use client";

// Building your credit: where this card stands on the habits that help a credit file, in plain words, with every
// figure from lib/finance/credit.ts. Works the same in Simple and Detailed view, by voice (Dial reads the same
// sentences) and with a screen reader (the meter has a text version, and statuses are words and shapes, not colour).
import { CircleAlert, CircleCheck, CircleDashed, MessageCircle } from "lucide-react";
import Link from "next/link";
import { actionClass, panelClass } from "@/components/spend-pause/styles";
import { useAskDial } from "@/components/assistant/ask-dial";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { creditHealth, UTILISATION_GUIDE, type HabitStatus } from "@/lib/finance/credit";
import { formatLongDate, formatPence } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";

const STATUS: Record<HabitStatus, { text: string; Icon: typeof CircleCheck; tone: string }> = {
  done: { text: "Done", Icon: CircleCheck, tone: "text-success" },
  "on-track": { text: "On track", Icon: CircleCheck, tone: "text-success" },
  "to-do": { text: "To do", Icon: CircleDashed, tone: "text-foreground" },
  "needs-attention": { text: "Needs attention", Icon: CircleAlert, tone: "text-attention" },
};

export function CreditScreen() {
  const { account, payments, ready } = useAccount();
  const { openAsk } = useAskDial();
  if (!ready) return <p role="status">Loading your card.</p>;

  const h = creditHealth(account, payments, DEMO_TODAY);
  const fill = Math.min(100, h.usedPercent);

  return (
    <div className="flex flex-col gap-(--space)">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">Building your credit</h1>
        <p className="text-muted-foreground">
          A few habits help your credit file over time. This is where your card stands on each one, worked out from your account.
        </p>
      </div>

      <section aria-labelledby="credit-use" className={`${panelClass} flex flex-col gap-3`}>
        <h2 id="credit-use" className="text-lg font-bold">
          How much of your limit you&apos;re using
        </h2>
        <p className="figure text-[calc(2.5rem*var(--figure-scale,1))] font-bold leading-none">
          {h.usedPercent}%
          <span className="ml-2 align-middle text-base font-normal text-muted-foreground">of {formatPence(h.limit)}</span>
        </p>
        <div
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fill}
          aria-valuetext={`${h.usedPercent}% of your limit used. The guide is under ${UTILISATION_GUIDE}%.`}
          aria-label="Share of your limit in use"
          className="relative h-4 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${fill}%` }} />
          <div aria-hidden className="absolute inset-y-0 w-[3px] bg-foreground" style={{ left: `${UTILISATION_GUIDE}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">
          The line marks {UTILISATION_GUIDE}%. Keeping under it can help your credit. You owe {formatPence(h.balance)} and have {formatPence(h.available)} left to spend.
        </p>
      </section>

      <section aria-labelledby="credit-habits" className={`${panelClass} flex flex-col gap-4`}>
        <h2 id="credit-habits" className="text-lg font-bold">
          Your habits: {h.onTrack} of {h.habits.length} on track
        </h2>
        <ol className="flex flex-col gap-4">
          {h.habits.map((x) => {
            const s = STATUS[x.status];
            return (
              <li key={x.id} className="flex items-start gap-3">
                <s.Icon aria-hidden className={`mt-1 size-[1.3em] shrink-0 ${s.tone}`} />
                <div className="flex flex-col gap-1">
                  <p className="font-bold">
                    {x.title} <span className={`ml-1 text-sm font-semibold ${s.tone}`}>({s.text})</span>
                  </p>
                  <p>{x.detail}</p>
                  {x.next && <p className="font-semibold">{x.next}</p>}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Link href="/account/pay" className={`${actionClass} inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground`}>
            Make a payment
          </Link>
          <button type="button" onClick={() => openAsk("How can I build my credit?")} className={`${actionClass} inline-flex items-center justify-center gap-2 rounded-full hairline bg-card`}>
            <MessageCircle aria-hidden className="size-[1.1em]" />
            Ask Dial about it
          </button>
        </div>
      </section>

      <section aria-labelledby="credit-about" className="flex flex-col gap-1 text-sm text-muted-foreground">
        <h2 id="credit-about" className="font-bold text-foreground">
          About this
        </h2>
        <p>
          This doesn&apos;t show your credit score, and it won&apos;t guess one. Each credit reference agency works scores out its own way. These are the habits
          they agree help. The {UTILISATION_GUIDE}% guide follows Experian&apos;s advice. Your next bill is due {formatLongDate(h.dueDate)}.
        </p>
      </section>
    </div>
  );
}
