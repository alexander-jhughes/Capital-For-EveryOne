"use client";

import { SlidersHorizontal, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { spendingHref } from "@/lib/dial/spending-filters";
import type { SpendingFilters } from "@/lib/dial/types";
import { monthLabel, sortLabel, type SpendingView } from "@/lib/dial/spending-view";

const chip =
  "inline-flex min-h-(--target-min) max-w-full items-center gap-2 rounded-[1.4em] bg-accent px-[1em] py-1 text-left font-bold text-accent-foreground hover:underline underline-offset-4";

/**
 * When a link removes the control that had focus (a chip, "Clear filters", "Close"), focus would fall to <body>.
 * Put it somewhere sensible instead, once the new URL has rendered.
 */
export function useCatchFocus(key: string, target: React.RefObject<HTMLElement | null>) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body) target.current?.focus({ preventScroll: true });
  }, [key, target]);
}

/** Every filter from the URL as a chip that removes it. Links, not state: reload, back and forward all work. */
export function SpendingFilterBar({ view, today }: { view: SpendingView; today: string }) {
  const f = view.filters;
  const heading = useRef<HTMLHeadingElement>(null);
  const without = (key: keyof SpendingFilters) => spendingHref({ ...f, [key]: undefined });
  const chips = [
    f.category && { key: "category", kind: "Category", label: f.category, href: without("category") },
    f.merchant && { key: "merchant", kind: "Shop", label: f.merchant, href: without("merchant") },
    f.month && { key: "month", kind: "Month", label: monthLabel(f.month, today), href: without("month") },
    f.sort && { key: "sort", kind: "Sort", label: sortLabel(f.sort), href: without("sort") },
  ].filter((c): c is { key: string; kind: string; label: string; href: string } => !!c);
  useCatchFocus(view.status, heading);

  return (
    <section aria-labelledby="sf-h" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space) shadow-[inset_4px_0_0_var(--primary)]">
      <h2 id="sf-h" ref={heading} tabIndex={-1} className="flex items-center gap-2 text-sm font-bold text-muted-foreground focus:outline-none">
        <SlidersHorizontal aria-hidden className="size-[1.1em] shrink-0" />
        Filtered view
      </h2>
      <p role="status" className="text-lg font-bold leading-snug">
        {view.status}
      </p>
      {view.notes.map((n) => (
        <p key={n} className="-mt-1 text-sm text-muted-foreground">
          {n}
        </p>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <ul aria-label="Active filters" className="flex max-w-full flex-wrap gap-2">
          {chips.map((c) => (
            <li key={c.key} className="max-w-full">
              <Link href={c.href} scroll={false} className={chip}>
                <span className="min-w-0">
                  <span className="sr-only">Remove </span>
                  <span className="font-normal">{c.kind}: </span>
                  {c.label}
                </span>
                <X aria-hidden className="size-[1em] shrink-0" strokeWidth={2.6} />
              </Link>
            </li>
          ))}
        </ul>
        <Link
          href={spendingHref({ txn: f.txn, highlight: f.highlight })}
          scroll={false}
          className="inline-flex min-h-(--target-min) items-center px-2 font-bold text-primary underline underline-offset-4"
        >
          Clear filters
        </Link>
      </div>
    </section>
  );
}
