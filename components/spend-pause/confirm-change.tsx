"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { describeChecks } from "@/lib/spend-pause/settings";
import type { SpendPauseSettings } from "@/lib/types";
import { actionClass } from "./styles";

const backdropClass = "fixed inset-0 z-50 bg-foreground/60";
const popupClass =
  "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[28rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-(--space) overflow-y-auto rounded-(--radius) border-2 bg-popover p-(--space) text-popover-foreground";

export const dialogClasses = { backdropClass, popupClass };

/** Turning Spend Pause on or off always stops here first, whether it came from this screen or from Dial. */
export function ConfirmChange({
  change,
  settings,
  onConfirm,
  onCancel,
  returnFocus,
}: {
  change: "on" | "off" | null;
  settings: SpendPauseSettings;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const turningOn = change === "on";
  return (
    <AlertDialog.Root open={change !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={backdropClass} />
        <AlertDialog.Popup className={popupClass} finalFocus={returnFocus}>
          <AlertDialog.Title className="text-lg font-bold">{turningOn ? "Turn on Spend Pause?" : "Turn off Spend Pause?"}</AlertDialog.Title>
          <AlertDialog.Description render={<div className="flex flex-col gap-(--space) text-base" />}>
            {turningOn ? (
              <>
                <p>Dial will ask you first before these purchases in the demo shop:</p>
                <ul className="list-disc pl-5">
                  {describeChecks(settings).map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
                <p>This doesn&apos;t change anything you&apos;ve already bought.</p>
              </>
            ) : (
              <p>Purchases in the demo shop will go through without a check. Your choices stay saved, and you can turn it back on at any time.</p>
            )}
          </AlertDialog.Description>
          <div className="flex flex-col gap-2 sm:flex-row-reverse sm:flex-wrap">
            <Button onClick={onConfirm} className={actionClass}>
              {turningOn ? "Yes, turn it on" : "Yes, turn it off"}
            </Button>
            <AlertDialog.Close render={<Button variant="outline" className={`${actionClass} border-input`} />}>Not now</AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
