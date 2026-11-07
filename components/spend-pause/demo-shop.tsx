"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { Button } from "@/components/ui/button";
import { DEMO_NOW } from "@/lib/demo-clock";
import { formatPence } from "@/lib/format";
import { useAccount } from "@/lib/state/account-context";
import { actionClass, panelClass } from "./styles";

const SHOP = "Northwind Audio";
const ITEM = "Wireless headphones";
const PRICE = 12000;

const linkClass = "inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4";

/** A made-up shop, the only place Spend Pause applies. Nothing here touches a real card or real money. */
export function DemoShop() {
  const { ready, addPendingPurchase, resolvePurchase, pendingPurchase, pauseHistory } = useAccount();
  const router = useRouter();
  const announce = useAnnounce();
  const [message, setMessage] = useState("");

  const buy = () => {
    const purchase = { id: `demo-${pauseHistory.length + 1}`, merchant: SHOP, item: ITEM, amount: PRICE, createdAt: DEMO_NOW.toISOString() };
    const decision = addPendingPurchase(purchase);
    if (decision.shouldPause) {
      router.push("/account/spend-pause/check");
      return;
    }
    resolvePurchase(purchase.id, "go");
    const text = `Bought. ${formatPence(PRICE)} at ${SHOP} is now in your spending as pending. Spend Pause didn't need to check this one.`;
    setMessage(text);
    announce(text);
  };

  return (
    <main id="main" className="gutter mx-auto flex min-h-dvh max-w-[30rem] flex-col gap-(--space) bg-background py-(--space)">
      <p className={`${panelClass} border-input text-base font-bold`}>This is a made-up demo shop. No real money moves.</p>
      <h1 className="text-xl font-bold">{SHOP}</h1>
      <section aria-labelledby="product" className={`flex flex-col gap-(--space) ${panelClass}`}>
        <h2 id="product" className="text-lg font-bold">
          {ITEM}
        </h2>
        <p className="text-lg font-bold tabular-nums">{formatPence(PRICE)}</p>
        {!ready ? (
          <p role="status" className="text-base">
            Getting ready.
          </p>
        ) : pendingPurchase ? (
          <Link href="/account/spend-pause/check" className={linkClass}>
            You have a purchase waiting. Check it now
          </Link>
        ) : (
          <Button onClick={buy} className={actionClass}>
            Buy
          </Button>
        )}
      </section>
      {message ? <p className={`${panelClass} text-base font-bold`}>{message}</p> : null}
      <Link href="/account/spend-pause" className={linkClass}>
        Back to Spend Pause
      </Link>
    </main>
  );
}
