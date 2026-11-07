"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { dialogClasses } from "@/components/spend-pause/confirm-change";
import { actionClass, panelClass } from "@/components/spend-pause/styles";
import { Button } from "@/components/ui/button";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { formatPence } from "@/lib/format";
import { explainPause, type PauseExplanation } from "@/lib/spend-pause/explain";
import type { PauseOutcome } from "@/lib/spend-pause/state";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { PendingPurchase } from "@/lib/types";
import { ReadAloud } from "./read-aloud";

const linkClass = "inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4";

interface Finished {
  purchase: PendingPurchase;
  outcome: PauseOutcome;
}

const resultText = ({ purchase, outcome }: Finished) =>
  outcome === "go"
    ? `Done. ${formatPence(purchase.amount)} at ${purchase.merchant} is now in your spending as pending.`
    : `Cancelled. ${formatPence(purchase.amount)} at ${purchase.merchant} wasn't bought, and nothing has changed.`;

function Result({ finished }: { finished: Finished }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="flex flex-col gap-(--space)">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold focus:outline-none">
        {finished.outcome === "go" ? "Purchase made" : "Purchase cancelled"}
      </h1>
      <p className="text-base">{resultText(finished)}</p>
      <Link href={finished.outcome === "go" ? "/account/spending" : "/account"} className={linkClass}>
        {finished.outcome === "go" ? "See your spending" : "Back to Home"}
      </Link>
      <Link href="/account/spend-pause" className={linkClass}>
        Back to Spend Pause
      </Link>
    </div>
  );
}

function SimpleCard({ purchase, explained, onChoose }: { purchase: PendingPurchase; explained: PauseExplanation; onChoose: (outcome: PauseOutcome) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const spoken = `Quick check. ${explained.sentence}`;
  return (
    <div className="flex flex-col gap-(--space)">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold focus:outline-none">
        Quick check
      </h1>
      <p className="text-lg">{explained.sentence}</p>
      <p className="text-base">
        {purchase.item} from {purchase.merchant}
      </p>
      <div className="flex flex-col gap-2">
        <Button onClick={() => onChoose("go")} className={`${actionClass} sm:w-full`}>
          Go ahead
        </Button>
        <Button variant="outline" onClick={() => onChoose("cancel")} className={`${actionClass} border-input sm:w-full`}>
          Cancel it
        </Button>
        <ReadAloud text={spoken} />
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4">
      <dt>{label}</dt>
      <dd className="font-bold tabular-nums">{value}</dd>
    </div>
  );
}

function ComplexDialog({ purchase, explained, onChoose }: { purchase: PendingPurchase; explained: PauseExplanation; onChoose: (outcome: PauseOutcome) => void }) {
  return (
    <>
      <h1 className="text-xl font-bold">Spend Pause check</h1>
      {/* No outside click or Escape: this only closes with an answer, so a purchase can't be left half decided. */}
      <AlertDialog.Root open>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className={dialogClasses.backdropClass} />
          <AlertDialog.Popup className={dialogClasses.popupClass}>
            <AlertDialog.Title className="text-lg font-bold">Check this purchase?</AlertDialog.Title>
            <AlertDialog.Description className="text-base">{explained.sentence}</AlertDialog.Description>
            <dl className="flex flex-col gap-1 text-base">
              <Row label="Merchant" value={purchase.merchant} />
              <Row label="Item" value={purchase.item} />
              <Row label="Amount" value={formatPence(purchase.amount)} />
              {explained.balanceAfter ? <Row label="Balance after" value={explained.balanceAfter} /> : null}
              {explained.availableCreditAfter ? <Row label="Available credit after" value={explained.availableCreditAfter} /> : null}
              {explained.budget ? <Row label={explained.budget.label} value={explained.budget.value} /> : null}
            </dl>
            <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap">
              <Button onClick={() => onChoose("go")} className={actionClass}>
                Go ahead
              </Button>
              <Button variant="outline" onClick={() => onChoose("cancel")} className={`${actionClass} border-input`}>
                Cancel it
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

/** The pause itself. Lives inside the Dial layout, so the mode switch and announcer keep working. */
export function PauseCheck() {
  const { account, transactions, settings, ready, pendingPurchase, resolvePurchase } = useAccount();
  const { mode } = useMode();
  const announce = useAnnounce();
  const [finished, setFinished] = useState<Finished | null>(null);

  const explained = useMemo(
    () =>
      pendingPurchase
        ? explainPause({ account, txns: transactions, settings, today: DEMO_TODAY, now: DEMO_NOW }, pendingPurchase)
        : null,
    [account, transactions, settings, pendingPurchase],
  );

  const choose = (outcome: PauseOutcome) => {
    if (!pendingPurchase) return;
    const done = { purchase: pendingPurchase, outcome };
    resolvePurchase(pendingPurchase.id, outcome);
    setFinished(done);
    announce(resultText(done));
  };

  if (finished) return <Result finished={finished} />;

  if (!ready) {
    return (
      <p role="status" className="text-base">
        Loading your purchase.
      </p>
    );
  }

  if (!pendingPurchase || !explained) {
    return (
      <div className={`flex flex-col gap-(--space) ${panelClass}`}>
        <h1 className="text-xl font-bold">Nothing to check</h1>
        <p className="text-base">There&apos;s no purchase waiting for your answer.</p>
        <Link href="/account/spend-pause" className={linkClass}>
          Back to Spend Pause
        </Link>
      </div>
    );
  }

  return mode === "simple" ? (
    <SimpleCard purchase={pendingPurchase} explained={explained} onChoose={choose} />
  ) : (
    <ComplexDialog purchase={pendingPurchase} explained={explained} onChoose={choose} />
  );
}
