"use client";

import { AlertCircle, ArrowRight, Check, Save, Undo2 } from "lucide-react";
import Link from "next/link";
import type { PendingOffer, ReplyItem } from "@/lib/dial/runner";
import { ExperienceCard } from "../experience/templates";
import { EvidenceList } from "../assistant/evidence-list";
import { VisualCard } from "./visual-card";
import { WhatIfCard } from "./what-if-card";
import type { DialTurn } from "./session";

const btn = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-5 font-bold";

/**
 * One reply, rendered the same way in the Ask sheet and in Voice Mode. Every figure inside comes from a card that
 * re-derives it from the account (charts, what-ifs, money cards); the text only repeats what those cards show.
 */
export function DialReply({
  turn,
  tone,
  offer,
  onDecide,
  onFollowUp,
  onNavigate,
}: {
  turn: DialTurn;
  tone: "light" | "voice";
  /** The change waiting for an answer, if this turn offered one. */
  offer: PendingOffer | null;
  onDecide: (yes: boolean, opts?: { save?: boolean }) => void;
  onFollowUp: (q: string) => void;
  onNavigate?: () => void;
}) {
  const voice = tone === "voice";
  const outline = voice ? "border border-[#aab4c8]" : "hairline bg-card";
  const primary = voice ? "bg-[#6cc4e8] text-[#0e1626]" : "bg-primary text-primary-foreground";
  const hasOffer = !!offer && turn.items.some((i) => i.kind === "offer");
  const isPrefOffer = offer?.step.type === "preferences";

  return (
    <div className="flex flex-col gap-3">
      {turn.understood && turn.understood.toLowerCase() !== turn.input.toLowerCase() && (
        <p className={`text-sm ${voice ? "text-[#aab4c8]" : "text-muted-foreground"}`}>
          {turn.corrected ? "Corrected to: " : "Understood: "}
          <span className="font-bold">{turn.understood}</span>
        </p>
      )}
      {turn.status === "working" && (
        <div>
          <p>{turn.local ? "Working on it..." : "Checking your account..."}</p>
          <div aria-hidden className="mt-2 flex flex-col gap-2">
            <span className={`h-4 w-11/12 animate-pulse rounded ${voice ? "bg-[#27314a]" : "bg-muted"}`} />
            <span className={`h-4 w-2/3 animate-pulse rounded ${voice ? "bg-[#27314a]" : "bg-muted"}`} />
          </div>
        </div>
      )}
      {turn.items.map((item, i) => (
        <Item key={i} item={item} voice={voice} outline={outline} onFollowUp={onFollowUp} onNavigate={onNavigate} />
      ))}
      {hasOffer && turn.status === "done" && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onDecide(true)} className={`${btn} flex-1 ${primary}`}>
              <Check aria-hidden className="size-[1.1em]" />
              Keep it
            </button>
            <button type="button" onClick={() => onDecide(false)} className={`${btn} flex-1 ${outline}`}>
              <Undo2 aria-hidden className="size-[1.1em]" />
              No, leave it
            </button>
          </div>
          {isPrefOffer && (
            <button type="button" onClick={() => onDecide(true, { save: true })} className={`${btn} ${outline}`}>
              <Save aria-hidden className="size-[1.1em]" />
              Keep and save for next time
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ item, voice, outline, onFollowUp, onNavigate }: { item: ReplyItem; voice: boolean; outline: string; onFollowUp: (q: string) => void; onNavigate?: () => void }) {
  switch (item.kind) {
    case "say":
    case "offer":
      return <p className="text-lg leading-snug">{item.text}</p>;
    case "failed":
      return (
        <p className={`flex items-start gap-2 rounded-xl p-3 font-bold ${voice ? "bg-[#3a1f2a] text-[#ffb4ad]" : "bg-accent text-attention"}`}>
          <AlertCircle aria-hidden className="mt-0.5 size-[1.1em] shrink-0" />
          {item.text}
        </p>
      );
    case "visual":
      return (
        <div className="text-base text-foreground">
          <VisualCard visual={item.visual} onNavigate={onNavigate} />
        </div>
      );
    case "whatIf":
      return (
        <div className="text-base text-foreground">
          <WhatIfCard result={item.result} onNavigate={onNavigate} />
        </div>
      );
    case "link":
      return (
        <Link href={item.href} onClick={onNavigate} className={`${btn} self-start ${outline}`}>
          {item.label}
          <ArrowRight aria-hidden className="size-[1em]" />
        </Link>
      );
    case "offline":
      return (
        <div className="flex flex-col gap-1">
          <p className="text-sm">Dial&apos;s assistant isn&apos;t available right now. This is what your account shows:</p>
          <dl>
            {item.facts.map((f) => (
              <div key={f.key}>
                <dt className={`text-sm ${voice ? "text-[#aab4c8]" : "text-muted-foreground"}`}>{f.label}</dt>
                <dd className="text-lg font-bold">{f.value}</dd>
              </div>
            ))}
          </dl>
          <EvidenceList ids={item.evidenceIds} onNavigate={onNavigate} />
        </div>
      );
    case "answer":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-lg font-bold leading-snug">{item.text}</p>
          {item.template !== "general" ? (
            <div className="text-base text-foreground">
              <ExperienceCard template={item.template} evidenceIds={item.evidenceIds} onNavigate={onNavigate} />
            </div>
          ) : (
            <EvidenceList ids={item.evidenceIds} onNavigate={onNavigate} />
          )}
          {item.followUps.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className={`text-sm font-bold ${voice ? "text-[#aab4c8]" : ""}`}>You could ask next</p>
              <ul className="flex flex-wrap gap-2">
                {item.followUps.map((q) => (
                  <li key={q}>
                    <button type="button" onClick={() => onFollowUp(q)} className={`${btn} ${outline} font-semibold`}>
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {process.env.NODE_ENV === "development" && <p className="self-start rounded border border-input px-2 text-sm">dev: source {item.source}</p>}
        </div>
      );
  }
}
