"use client";

import { Check } from "lucide-react";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { useMode } from "@/lib/state/mode-context";
import { useProfile } from "@/lib/profile/provider";
import type { Mode } from "@/lib/types";

// Internal ids stay simple/complex; people see Simple / Detailed.
const OPTIONS: { value: Mode; label: string }[] = [
  { value: "simple", label: "Simple" },
  { value: "complex", label: "Detailed" },
];

/** The view switch. Native radios: arrow keys work, and screen readers hear "View, Simple, selected". */
export function ModeSwitch() {
  const { mode, setMode } = useMode();
  const { noteUsage } = useProfile();
  // The person's own tap only (style previews and Voice Mode change the view without counting).
  const { noteViewChosen } = usePersonalisation();
  return (
    <fieldset className="min-w-0 max-w-full">
      <legend className="sr-only">View</legend>
      <div className="hairline flex flex-wrap gap-1 rounded-[1.6em] bg-card p-1">
        {OPTIONS.map((o) => (
          <label
            key={o.value}
            className="inline-flex min-h-(--target-min) cursor-pointer items-center justify-center gap-1.5 rounded-full px-[0.9em] text-sm font-bold transition-colors has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
          >
            <input type="radio" name="view" value={o.value} checked={mode === o.value} onChange={() => {
                setMode(o.value);
                if (o.value === "complex") noteUsage("detailed");
                noteViewChosen(o.value);
              }} className="sr-only" />
            {mode === o.value && <Check aria-hidden className="size-[0.95em]" strokeWidth={3} />}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
