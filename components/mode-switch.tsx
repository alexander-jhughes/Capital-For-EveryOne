"use client";

import { Check } from "lucide-react";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";

const OPTIONS: { value: Mode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "complex", label: "Complex" },
];

/** The Dial. Native radios: arrow keys work, and screen readers hear "Dial, Simple, selected". */
export function ModeSwitch() {
  const { mode, setMode } = useMode();
  return (
    <fieldset className="flex items-center gap-2">
      <legend className="sr-only">Dial: how your account looks</legend>
      <span aria-hidden className="font-bold">
        Dial
      </span>
      <div className="flex gap-1 rounded-lg border-2 border-input bg-card p-1">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className="inline-flex min-h-(--target-min) cursor-pointer items-center justify-center gap-1.5 rounded-md px-4 font-bold has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
          >
            <input
              type="radio"
              name="dial"
              value={o.value}
              checked={mode === o.value}
              onChange={() => setMode(o.value)}
              className="sr-only"
            />
            {mode === o.value && <Check aria-hidden className="size-[1em]" strokeWidth={3} />}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
