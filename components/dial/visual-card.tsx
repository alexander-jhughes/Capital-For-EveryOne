"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import type { Visual, VisualDatum, VisualSeries } from "@/lib/dial/types";
import { TOTALS, visualHref } from "@/lib/dial/visuals";

// Shows a Visual exactly as lib/dial/visuals.ts built it. No figure is worked out here: every number on screen is a
// `display` string from the visual. Bar lengths are geometry only, and every mark is aria-hidden next to visible
// text (or a visually hidden table) that says the same thing. Colours come from the chart tokens, so dark theme and
// high contrast follow app/globals.css; values are always printed, so identity is never colour alone.

const nextStep =
  "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 self-start rounded-[1.4em] bg-primary px-[1.2em] py-1 text-center font-bold text-primary-foreground";
const SWATCH = ["bg-chart", "bg-chart-2"] as const;

/** Share of the largest value, for a bar's length. Negative values (refunds) draw nothing. */
const width = (value: number, max: number) => `${max > 0 ? (Math.max(0, value) * 100) / max : 0}%`;
const maxOf = (data: VisualDatum[]) => Math.max(0, ...data.map((d) => d.value));

function Track({ value, max, tone = 0, thin = false }: { value: number; max: number; tone?: number; thin?: boolean }) {
  return (
    <span aria-hidden className={`block w-full rounded-full bg-chart-track hairline ${thin ? "h-1.5" : "h-2.5"}`}>
      <span className={`block h-full rounded-full ${SWATCH[tone] ?? SWATCH[0]}`} style={{ width: width(value, max) }} />
    </span>
  );
}

function Note({ children }: { children?: string }) {
  return children ? <span className="block text-sm font-normal text-muted-foreground">{children}</span> : null;
}

/** Headline figures (the TOTALS series), shown above the chart. */
function Totals({ data }: { data: VisualDatum[] }) {
  if (!data.length) return null;
  const [first, ...rest] = data;
  return (
    <dl className="flex flex-col gap-2">
      <div className="flex flex-col">
        <dt className="text-sm text-muted-foreground">{first.label}</dt>
        <dd className="text-xl font-bold leading-tight tracking-tight">{first.display}</dd>
      </div>
      {rest.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {rest.map((d) => (
            <div key={d.label} className="flex min-w-0 flex-col">
              <dt className="text-sm text-muted-foreground">{d.label}</dt>
              <dd className="font-bold">{d.display}</dd>
            </div>
          ))}
        </div>
      )}
    </dl>
  );
}

/** Horizontal bars, one series. The visible list is the accessible equivalent: each row reads label, amount, note. */
function Bars({ series }: { series: VisualSeries }) {
  const max = maxOf(series.data);
  const id = useId();
  return (
    <div>
      <p id={id} className="pb-1 text-sm font-bold text-muted-foreground">
        {series.name}
      </p>
      <ul aria-labelledby={id} className="flex flex-col">
        {series.data.map((d) => (
          <li key={d.label} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
            {/* Wraps the amount under the label rather than breaking a word, at large text on a narrow screen. */}
            <span className="min-w-[min(100%,9em)] flex-1 font-semibold">{d.label}</span>
            <span className="ml-auto shrink-0 text-right font-bold">{d.display}</span>
            {d.note && <span className="basis-full text-sm text-muted-foreground">{d.note}</span>}
            <span className="mt-1.5 basis-full">
              <Track value={d.value} max={max} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A visually hidden table for charts whose visible layout isn't a table. */
function HiddenTable({ series, caption }: { series: VisualSeries[]; caption: string }) {
  const rows = series[0]?.data ?? [];
  return (
    // A table ignores the 1px width of sr-only, so the wrapper is the hidden box.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {series.map((s) => {
                const d = s.data[i];
                return <td key={s.name}>{d ? `${d.display}${d.note ? `, ${d.note}` : ""}` : ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two periods side by side, per category: legend first, then a pair of bars with both values printed. */
function Grouped({ series }: { series: VisualSeries[] }) {
  const pair = series.slice(0, 2);
  const max = Math.max(...pair.map((s) => maxOf(s.data)));
  const rows = pair[0].data;
  return (
    <div>
      <HiddenTable series={pair} caption={`${pair.map((s) => s.name).join(" and ")}, side by side`} />
      <div aria-hidden className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {pair.map((s, i) => (
            <li key={s.name} className="flex items-center gap-2">
              <span className={`size-3 shrink-0 rounded-sm hairline ${SWATCH[i]}`} />
              <span className={i === 0 ? "font-bold" : "text-muted-foreground"}>{s.name}</span>
            </li>
          ))}
        </ul>
        <ul className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <li key={r.label} className="flex flex-col gap-1">
              <span className="font-semibold">{r.label}</span>
              {pair.map((s, k) => {
                const d = s.data[i];
                return (
                  <span key={s.name} className="flex items-center gap-3">
                    <span className="min-w-[3rem] flex-1">
                      <Track value={d?.value ?? 0} max={max} tone={k} thin={k > 0} />
                    </span>
                    <span className={`shrink-0 text-right text-sm ${k === 0 ? "font-bold" : "text-muted-foreground"}`}>{d?.display}</span>
                  </span>
                );
              })}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** One series over time: vertical columns when there's room, horizontal bars on a narrow card or at large text. */
function Columns({ series }: { series: VisualSeries[] }) {
  const drawn = series.filter((s) => s.data.length);
  if (drawn.length > 1) return <Grouped series={drawn} />;
  const s = drawn[0];
  const max = maxOf(s.data);
  return (
    <div className="@container">
      <div className="@md:hidden">
        <Bars series={s} />
      </div>
      <div className="hidden @md:block">
        <HiddenTable series={[s]} caption={s.name} />
        <div aria-hidden>
          <p className="pb-2 text-sm font-bold text-muted-foreground">{s.name}</p>
          <div className="flex items-end gap-3 border-b-2 border-input pb-0">
            {s.data.map((d) => (
              <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                <span className="text-sm font-bold">{d.display}</span>
                <span className="flex h-36 w-full max-w-16 items-end">
                  <span className="block w-full rounded-t-[4px] bg-chart" style={{ height: width(d.value, max), minHeight: d.value > 0 ? 2 : 0 }} />
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-3 pt-1">
            {s.data.map((d) => (
              <span key={d.label} className="min-w-0 flex-1 text-center text-sm [overflow-wrap:anywhere]">
                <span className="block font-semibold">{d.label}</span>
                <Note>{d.note}</Note>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One meter: spent against a budget. Data order from visuals.ts: spent, budget, left or over, share. */
function Progress({ series }: { series: VisualSeries }) {
  const [spent, budget, rest, share] = series.data;
  const over = rest?.label.startsWith("Over");
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-bold leading-tight tracking-tight">{spent.display}</span>
        {budget && <span className="text-muted-foreground">of {budget.display}</span>}
      </p>
      {budget && (
        <span aria-hidden className="block h-3 w-full overflow-hidden rounded-full bg-chart-track hairline">
          <span
            className={`block h-full rounded-full ${over ? "bg-attention" : "bg-chart"}`}
            style={{ width: over ? "100%" : width(spent.value, budget.value) }}
          />
        </span>
      )}
      <dl className="flex flex-wrap gap-x-6 gap-y-1">
        {[rest, share]
          .filter((d): d is VisualDatum => !!d)
          .map((d) => (
            <div key={d.label} className="flex min-w-0 flex-col">
              <dt className="text-sm text-muted-foreground">{d.label}</dt>
              <dd className={`font-bold ${d === rest && over ? "text-attention" : ""}`}>{d.display}</dd>
            </div>
          ))}
      </dl>
      <p className="text-sm text-muted-foreground">{spent.label}</p>
    </div>
  );
}

/** Ranked rows, largest first. The visible ordered list is the accessible equivalent. */
function Ranked({ series }: { series: VisualSeries }) {
  const max = maxOf(series.data);
  return (
    <div>
      <p className="pb-1 text-sm font-bold text-muted-foreground">{series.name}</p>
      <ol className="flex flex-col">
        {series.data.map((d, i) => (
          <li key={`${d.label}-${i}`} className="flex items-start gap-3 border-b py-2 last:border-0">
            <span
              aria-hidden
              className="flex size-[1.8em] shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-foreground"
            >
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
              <span className="min-w-[min(100%,8em)] flex-1 font-bold">{d.label}</span>
              <span className="ml-auto shrink-0 font-bold">{d.display}</span>
              {d.note && <span className="basis-full text-sm text-muted-foreground">{d.note}</span>}
              <span className="mt-1 basis-full">
                <Track value={d.value} max={max} thin />
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function VisualCard({ visual, onNavigate }: { visual: Visual; onNavigate?: () => void }) {
  const titleId = useId();
  const totals = visual.series.find((s) => s.name === TOTALS)?.data ?? [];
  const drawn = visual.series.filter((s) => s.name !== TOTALS && s.data.length);
  const hasData = drawn.length > 0;

  return (
    <section
      aria-labelledby={titleId}
      data-visual={visual.kind}
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl bg-card p-(--space) text-card-foreground"
    >
      <h3 id={titleId} className="text-lg font-bold leading-snug">
        {visual.title}
      </h3>
      {!hasData ? (
        <p className="rounded-lg bg-muted p-3 text-muted-foreground">{visual.summary}</p>
      ) : (
        <>
          <Totals data={totals} />
          {visual.chart === "bars" && <Bars series={drawn[0]} />}
          {visual.chart === "columns" && <Columns series={drawn} />}
          {visual.chart === "progress" && <Progress series={drawn[0]} />}
          {visual.chart === "list" && <Ranked series={drawn[0]} />}
        </>
      )}
      {visual.limitations.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
          {visual.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {visual.link && (
        <Link href={visualHref(visual.link)} onClick={onNavigate} className={nextStep}>
          {visual.link.label} <ArrowRight aria-hidden className="size-[1em] shrink-0" />
        </Link>
      )}
    </section>
  );
}
