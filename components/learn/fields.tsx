"use client";

// Inputs for the Learning Lab calculators. Typed amounts plus one-tap presets, never a slider, so nothing needs a
// steady hand. Each field says what's wrong in words next to it, and the result simply waits for a valid value.
import { useId } from "react";
import { formatPence } from "@/lib/format";
import { parsePounds } from "@/lib/spend-pause/settings";
import type { Pence } from "@/lib/types";

const fieldClass = "min-h-(--target-min) w-full rounded-(--radius) border-2 border-input bg-card px-3 text-base text-foreground aria-invalid:border-attention";
const chip = "hairline inline-flex min-h-(--target-min) items-center rounded-full bg-card px-[1em] text-sm font-bold aria-pressed:bg-primary aria-pressed:text-primary-foreground";

/** Whole pounds without ".00", for putting a figure back in an input. */
export const poundsText = (p: Pence) => formatPence(p).replace(/[£,]/g, "").replace(/\.00$/, "");

export function parseAmount(text: string, { min = 0, max = 10_000_000 }: { min?: Pence; max?: Pence } = {}): { value: Pence | null; error: string | null } {
  const value = parsePounds(text);
  if (value === null) return { value: null, error: "Enter an amount in pounds, like 500 or 486.20." };
  if (value < min) return { value: null, error: `Enter at least ${formatPence(min)}.` };
  if (value > max) return { value: null, error: `Enter ${formatPence(max)} or less.` };
  return { value, error: null };
}

export function parseRate(text: string): { value: number | null; error: string | null } {
  const m = text.trim().replace(/%$/, "").match(/^(\d{1,2})(?:\.(\d))?$/);
  if (!m) return { value: null, error: "Enter a yearly rate like 24.9." };
  const value = Number(m[1]) + Number(m[2] ?? 0) / 10;
  return value > 0 ? { value, error: null } : { value: null, error: "Enter a rate above 0%." };
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  error,
  presets = [],
  suffix,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  presets?: { label: string; value: string }[];
  suffix?: string;
}) {
  const id = useId();
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-bold">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
      <div className="flex items-center gap-2">
        {!suffix && <span aria-hidden className="text-lg font-bold">£</span>}
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          className={fieldClass}
        />
        {suffix && <span aria-hidden className="text-lg font-bold">{suffix}</span>}
      </div>
      {error && (
        <p id={`${id}-error`} className="font-bold text-attention">
          {error}
        </p>
      )}
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={`Quick choices for ${label.toLowerCase()}`}>
          {presets.map((p) => (
            <button key={p.label} type="button" aria-pressed={value === p.value} onClick={() => onChange(p.value)} className={chip}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The "illustrative" warning every calculator carries, worded the same everywhere. */
export function Illustrative({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
      <strong>Illustrative. </strong>
      {children}
    </p>
  );
}
