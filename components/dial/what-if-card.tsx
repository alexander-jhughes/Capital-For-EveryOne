"use client";

import { ArrowRight, Calculator } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import type { WhatIfResult } from "@/lib/dial/types";
import { ESTIMATE_LINE } from "@/lib/dial/what-if";

// Shows a what-if exactly as lib/dial/what-if.ts worked it out. Always labelled as an estimate, always with its
// assumptions. Nothing here moves money: the only action is a link to the screen where the person decides.

const nextStep =
  "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 self-start rounded-[1.4em] bg-primary px-[1.2em] py-1 text-center font-bold text-primary-foreground";

/** Plain words for the outcome. Statements about the arithmetic, never promises or advice. */
function outcomeText(r: WhatIfResult): string {
  switch (r.outcome) {
    case "not_enough_data":
      return "Not enough history to work this out";
    case "not_possible":
      return "Not possible on these figures";
    case "stretch":
      return "A big change on these figures";
    case "fits":
      return r.scenario.kind === "pay_monthly" ? "Clears the balance on these figures" : "A small change on these figures";
  }
}

const linkFor = (r: WhatIfResult) =>
  r.scenario.kind === "pay_monthly" ? { href: "/account/pay", label: "Go to Pay" } : { href: "/account/goals", label: "Set a goal" };

export function WhatIfCard({ result, onNavigate }: { result: WhatIfResult; onNavigate?: () => void }) {
  const titleId = useId();
  const link = linkFor(result);
  const blocked = result.outcome === "not_possible" || result.outcome === "not_enough_data";

  return (
    <section aria-labelledby={titleId} data-what-if={result.scenario.kind} className="elevated flex min-w-0 flex-col gap-3 rounded-xl bg-card p-(--space) text-card-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={titleId} className="text-lg font-bold leading-snug">
          {result.title}
        </h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-warning bg-warning-surface px-2.5 py-0.5 text-sm font-bold text-warning">
          <Calculator aria-hidden className="size-[1em] shrink-0" />
          Estimate
        </span>
      </div>

      <p className={`text-sm font-bold ${blocked ? "text-attention" : "text-muted-foreground"}`}>{outcomeText(result)}</p>
      <p className="text-base">{result.statement}</p>

      {result.figures.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg bg-muted p-3 min-[22rem]:grid-cols-2">
          {result.figures.map((f) => (
            <div key={f.label} className="flex min-w-0 flex-col">
              <dt className="text-sm text-muted-foreground">{f.label}</dt>
              <dd className="font-bold [overflow-wrap:anywhere]">{f.display}</dd>
            </div>
          ))}
        </dl>
      )}

      <div>
        <h4 className="text-sm font-bold">What this assumes</h4>
        <ul className="list-disc pl-5 text-sm text-muted-foreground">
          {result.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>

      <p className="text-sm font-bold">{ESTIMATE_LINE}</p>

      <Link href={link.href} onClick={onNavigate} className={nextStep}>
        {link.label} <ArrowRight aria-hidden className="size-[1em] shrink-0" />
      </Link>
    </section>
  );
}
