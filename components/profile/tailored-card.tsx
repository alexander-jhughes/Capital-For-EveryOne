"use client";

// "Picked for you" on Home: what the saved profile changes, in plain sight, with the reasons one tap away.
// Every action here is an ordinary link or an ordinary Dial question; display changes are only ever previewed.
import { ArrowRight, Eye, HeartHandshake, Mic } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { daysUntilDue } from "@/lib/finance";
import { formatLongDate } from "@/lib/format";
import { FREE_HELP, PERSON_TYPE_COPY } from "@/lib/profile/catalog";
import type { CardId } from "@/lib/profile/infer";
import { useProfile } from "@/lib/profile/provider";
import { usePreferences } from "@/lib/preferences/provider";
import { useAccount } from "@/lib/state/account-context";
import { useAskDial } from "../assistant/ask-dial";
import { useStylePreview } from "../personalise/style-preview";

const row = "flex min-h-(--target-min) w-full items-center justify-between gap-3 rounded-lg bg-accent px-3 py-2 text-left font-bold text-accent-foreground";
const pill = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-5 font-bold";
const OFFER_KEY = "cfe-profile-offer";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(OFFER_KEY) === "no";
  } catch {
    return false;
  }
}

function TailoredRow({ id }: { id: CardId }) {
  const { account } = useAccount();
  const { openAsk, openVoice } = useAskDial();
  const days = daysUntilDue(account, DEMO_TODAY);
  const go = (href: string, text: string) => (
    <Link href={href} className={row}>
      {text}
      <ArrowRight aria-hidden className="size-[1em] shrink-0" />
    </Link>
  );
  const ask = (q: string, text: string) => (
    <button type="button" onClick={() => openAsk(q)} className={row}>
      {text}
      <ArrowRight aria-hidden className="size-[1em] shrink-0" />
    </button>
  );
  switch (id) {
    case "free_help":
      return (
        <div className="flex flex-col gap-1 rounded-lg bg-accent px-3 py-2 text-accent-foreground">
          <p className="flex items-center gap-2 font-bold">
            <HeartHandshake aria-hidden className="size-[1.1em]" />
            Free, confidential money help
          </p>
          <p className="text-sm">
            {FREE_HELP.map((h, i) => (
              <span key={h.name}>
                {i > 0 && (i === FREE_HELP.length - 1 ? " and " : ", ")}
                <a href={h.url} target="_blank" rel="noopener noreferrer" className="font-bold underline underline-offset-4">
                  {h.name}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </span>
            ))}{" "}
            give free, impartial advice.
          </p>
        </div>
      );
    case "pay_on_time":
      return go("/account/pay", account.statementBalance > 0 && days >= 0 ? `Your bill is due ${formatLongDate(account.paymentDueDate)}` : "See your payments");
    case "learn_credit":
      return go("/account/learn", "How credit works, in plain words");
    case "check_subscriptions":
      return ask("Has any subscription gone up?", "Check your subscriptions");
    case "savings_goal":
      return go("/account/goals", "Your goals");
    case "spend_pause":
      return go("/account/spend-pause", "Spend Pause: a moment to think before you buy");
    case "what_if":
      return ask("What if I spend £100 less next month?", "Try a what-if sum");
    case "talk_to_dial":
      return (
        <button type="button" onClick={openVoice} className={row}>
          <span className="flex items-center gap-2">
            <Mic aria-hidden className="size-[1em]" />
            Ask Dial anything, typing or talking
          </span>
          <ArrowRight aria-hidden className="size-[1em] shrink-0" />
        </button>
      );
  }
}

export function TailoredCard() {
  const { profile } = useProfile();
  const { preview } = usePreferences();
  const { startRequest, active } = useStylePreview();
  const [dismissed, setDismissed] = useState(readDismissed);
  const result = profile?.consent ? profile.result : null;
  if (!result?.type) return null;
  const { adaptations: a } = result;
  const offer = !dismissed && !preview && !active ? a.displayOffer : null;
  const notNow = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(OFFER_KEY, "no");
    } catch {}
  };

  return (
    <section aria-labelledby="tailored-h" className="hairline flex flex-col gap-3 rounded-xl bg-card p-(--space)" data-person-type={result.type}>
      <div>
        <h2 id="tailored-h" className="font-bold text-primary">
          Picked for you
        </h2>
        <p className="text-lg font-bold leading-tight">{PERSON_TYPE_COPY[result.type].title}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {a.cards.map((c) => (
          <li key={c}>
            <TailoredRow id={c} />
          </li>
        ))}
      </ul>
      {offer && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => startRequest({ name: offer.title.toLowerCase(), actions: offer.actions, mode: offer.mode, source: "ml" })} className={`${pill} bg-primary text-primary-foreground`}>
            <Eye aria-hidden className="size-[1em]" />
            Preview {offer.title.toLowerCase()}
          </button>
          <button type="button" onClick={notNow} className={`${pill} hairline bg-card`}>
            Not now
          </button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        Based on {result.source === "chosen" ? "the type you chose" : "what you told us and how you use the app"}.{" "}
        <Link href="/account/about-you" className="font-bold underline underline-offset-4">
          Why, and change it
        </Link>
      </p>
    </section>
  );
}
