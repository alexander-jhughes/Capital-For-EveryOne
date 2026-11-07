"use client";

import { CirclePause, CirclePlay } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { Button } from "@/components/ui/button";
import { formatPence } from "@/lib/format";
import { confirmationFor } from "@/lib/spend-pause/dial";
import { describeChecks, hasChecks } from "@/lib/spend-pause/settings";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { SpendPauseSettings } from "@/lib/types";
import { ConfirmChange } from "./confirm-change";
import { SettingsEditor } from "./settings-editor";
import { actionClass, panelClass } from "./styles";

const linkClass = "inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4";

function Limits() {
  return (
    <ul className="list-disc pl-5 text-base">
      <li>It asks you before a purchase in the demo shop, and you always make the final choice.</li>
      <li>It isn&apos;t connected to a real card, so it can&apos;t stop purchases anywhere else.</li>
      <li>It can&apos;t undo or change anything you&apos;ve already bought.</li>
    </ul>
  );
}

export function SpendPauseScreen({ requested }: { requested?: string }) {
  const { settings, ready, settingsSaved, updateSettings, pauseHistory, pendingPurchase } = useAccount();
  const { mode } = useMode();
  const announce = useAnnounce();
  const [asking, setAsking] = useState<"on" | "off" | null>(null);
  const [editing, setEditing] = useState(false);
  const [needChecks, setNeedChecks] = useState(false);
  const [notice, setNotice] = useState<{ text: string; undo?: SpendPauseSettings } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const linkHandled = useRef(false);

  // A link from Dial can only open the question. The person still answers it.
  useEffect(() => {
    if (!ready || linkHandled.current) return;
    linkHandled.current = true;
    const change = confirmationFor(settings, requested);
    if (change) setAsking(change);
  }, [ready, requested, settings]);

  const tell = (text: string, undo?: SpendPauseSettings) => {
    setNotice({ text, undo });
    announce(text);
  };

  const applyChange = () => {
    const previous = settings;
    const enabled = asking === "on";
    updateSettings({ ...settings, enabled });
    setAsking(null);
    tell(enabled ? "Spend Pause is on." : "Spend Pause is off.", previous);
  };

  const undo = () => {
    if (!notice?.undo) return;
    updateSettings(notice.undo);
    tell(notice.undo.enabled ? "Done. Spend Pause is back on." : "Done. Spend Pause is back off.");
    toggle.current?.focus();
  };

  const startToggle = () => {
    setNotice(null);
    if (settings.enabled || hasChecks(settings)) setAsking(settings.enabled ? "off" : "on");
    else {
      setNeedChecks(true);
      setEditing(true);
    }
  };

  const saveChoices = (next: SpendPauseSettings) => {
    updateSettings(next);
    setEditing(false);
    if (needChecks) {
      setNeedChecks(false);
      setAsking("on");
    } else tell("Your Spend Pause choices are saved.");
    requestAnimationFrame(() => heading.current?.focus());
  };

  if (!ready) {
    return (
      <div className="flex flex-col gap-(--space)">
        <h1 className="text-xl font-bold">Spend Pause</h1>
        <p role="status" className="text-base">
          Loading your choices.
        </p>
      </div>
    );
  }

  const checks = describeChecks(settings);
  const StatusIcon = settings.enabled ? CirclePause : CirclePlay;

  return (
    <div className="flex flex-col gap-(--space) [&_a]:scroll-mb-[calc(var(--target-min)*3)] [&_summary]:scroll-mb-[calc(var(--target-min)*3)]">
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold focus:outline-none">
        Spend Pause
      </h1>
      <p className="text-base">A moment to think before a big purchase. You always decide.</p>

      {pendingPurchase ? (
        <p className={`${panelClass} border-input text-base`}>
          A purchase is waiting for your answer.{" "}
          <Link href="/account/spend-pause/check" className={linkClass}>
            Check it now
          </Link>
        </p>
      ) : null}

      {!editing ? (
        <section aria-labelledby="pause-status" className={`flex flex-col gap-(--space) ${panelClass} ${settings.enabled ? "border-primary" : "border-input"}`}>
          <h2 id="pause-status" className="flex items-center gap-2 text-lg font-bold">
            <StatusIcon aria-hidden className="size-[1.2em] shrink-0" />
            {settings.enabled ? "Spend Pause is on" : "Spend Pause is off"}
          </h2>
          {settings.enabled ? (
            <>
              <p className="text-base">Dial checks with you first for:</p>
              <ul className="list-disc pl-5 text-base">
                {checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-base">{hasChecks(settings) ? "Purchases in the demo shop go through without a check." : "Choose what to check, then turn it on."}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button ref={toggle} variant={settings.enabled ? "outline" : "default"} onClick={startToggle} className={`${actionClass} ${settings.enabled ? "border-input" : ""}`}>
              {settings.enabled ? "Turn off Spend Pause" : "Turn on Spend Pause"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setNotice(null);
                setEditing(true);
              }}
              className={`${actionClass} border-input`}
            >
              Change what&apos;s checked
            </Button>
          </div>
        </section>
      ) : (
        <SettingsEditor
          settings={settings}
          intro={needChecks ? "Choose at least one thing to check, then you can turn Spend Pause on." : undefined}
          onSave={saveChoices}
          onCancel={() => {
            setEditing(false);
            setNeedChecks(false);
            requestAnimationFrame(() => heading.current?.focus());
          }}
        />
      )}

      {notice ? (
        <div className={`flex flex-col items-start gap-2 ${panelClass}`}>
          <p className="text-base font-bold">{notice.text}</p>
          {notice.undo ? (
            <Button variant="outline" onClick={undo} className={`${actionClass} border-input`}>
              Undo
            </Button>
          ) : null}
        </div>
      ) : null}

      {!settingsSaved ? (
        <p className={`${panelClass} border-input text-base`}>We can&apos;t save your choices on this device, so they&apos;ll last until you close Dial.</p>
      ) : null}

      {mode === "simple" ? (
        <details className={panelClass}>
          <summary className="flex min-h-(--target-min) cursor-pointer items-center text-base font-bold">What it can and can&apos;t do</summary>
          <Limits />
        </details>
      ) : (
        <section aria-labelledby="pause-limits" className={`flex flex-col gap-2 ${panelClass}`}>
          <h2 id="pause-limits" className="text-lg font-bold">
            What it can and can&apos;t do
          </h2>
          <Limits />
        </section>
      )}

      {pauseHistory.length > 0 ? (
        <section aria-labelledby="pause-history" className={`flex flex-col gap-2 ${panelClass}`}>
          <h2 id="pause-history" className="text-lg font-bold">
            Your recent choices
          </h2>
          <ul className="flex flex-col gap-1 text-base">
            {pauseHistory.slice(0, 3).map(({ purchase, outcome }) => (
              <li key={purchase.id}>
                {formatPence(purchase.amount)} at {purchase.merchant}: {outcome === "go" ? "you went ahead" : "you cancelled it"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Link href="/demo/shop" className={linkClass}>
        Try it in the demo shop
      </Link>

      <ConfirmChange change={asking} settings={settings} onConfirm={applyChange} onCancel={() => setAsking(null)} returnFocus={heading} />
    </div>
  );
}
