// Shared building blocks for dashboard sections, the Learning Lab and Goals: one card style, one meter, one bar list,
// one empty state. Every visual has its numbers in text next to it, so nothing depends on colour or on seeing a bar.
import { ArrowRight } from "lucide-react";
import Link from "next/link";

export const cardClass = "elevated rounded-xl bg-card p-(--space)";
export const linkButton = "inline-flex min-h-(--target-min) items-center gap-1.5 font-bold text-primary underline-offset-4 hover:underline";

/** A titled card. `id` names the heading, so the section is a labelled region for screen readers. */
export function Panel({
  id,
  title,
  icon,
  action,
  children,
  className = "",
}: {
  id: string;
  title: React.ReactNode;
  icon?: React.ReactNode;
  action?: { href: string; label: string; srLabel?: string };
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`${cardClass} flex flex-col gap-3 ${className}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={id} className="flex items-center gap-2 text-lg font-bold">
          {icon}
          {title}
        </h2>
        {action && (
          <Link href={action.href} className={linkButton}>
            {action.label}
            {action.srLabel && <span className="sr-only"> {action.srLabel}</span>}
            <ArrowRight aria-hidden className="size-[1em]" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/**
 * A horizontal meter. `valueText` is what a screen reader hears, and callers also show it as text.
 * `marker` draws a labelled line (for example a 30% guide), described in `markerLabel` for screen readers.
 */
export function Meter({
  label,
  value,
  max = 100,
  valueText,
  tone = "chart",
  marker,
  markerLabel,
  className = "",
}: {
  label: string;
  value: number;
  max?: number;
  valueText: string;
  tone?: "chart" | "attention" | "success";
  marker?: number;
  markerLabel?: string;
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value * 100) / max)) : 0;
  const fill = tone === "attention" ? "bg-attention" : tone === "success" ? "bg-success" : "bg-chart";
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, Math.max(0, value))}
      aria-valuetext={markerLabel ? `${valueText}. ${markerLabel}` : valueText}
      className={`relative h-3 overflow-hidden rounded-full bg-chart-track hairline ${className}`}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      {marker !== undefined && max > 0 && (
        <span aria-hidden className="absolute inset-y-0 w-0.5 bg-foreground" style={{ left: `${Math.min(100, (marker * 100) / max)}%` }} />
      )}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  display: string;
  /** Extra text after the figure, e.g. "£12.30 more than last month". Read by everyone, not only screen readers. */
  note?: string;
}

/**
 * Labelled bars, largest first by the caller. The label and figure are always text; the bar is decoration
 * (aria-hidden), so with charts turned off (`bars={false}`) the list reads exactly the same.
 */
export function BarList({ rows, label, bars = true }: { rows: BarRow[]; label: string; bars?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-col gap-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-semibold">{r.label}</span>
            <span className="font-bold">{r.display}</span>
          </span>
          {bars && (
            <span aria-hidden className="block h-2 overflow-hidden rounded-full bg-chart-track">
              <span className="block h-full rounded-full bg-chart" style={{ width: `${Math.max(2, (Math.max(0, r.value) * 100) / max)}%` }} />
            </span>
          )}
          {r.note && <span className="text-sm text-muted-foreground">{r.note}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Nothing to show yet: says why, and what would change that. */
export function EmptyState({ title, children, icon }: { title: string; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-lg bg-muted/60 p-3">
      {icon}
      <p className="font-bold">{title}</p>
      {children && <div className="text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Placeholder while account figures load, so nobody reads a stale number. One status message for the whole block. */
export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div role="status" className="flex flex-col gap-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} aria-hidden className="block h-[1em] animate-pulse rounded-md bg-muted" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}
