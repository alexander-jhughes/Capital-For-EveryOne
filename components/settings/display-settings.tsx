"use client";

import { ArrowUpToLine, Check, RotateCcw, Save, Star, Undo2 } from "lucide-react";
import { useId, useState } from "react";
import { useAskDial } from "@/components/assistant/ask-dial";
import { useAnnounce } from "@/components/live-region";
import { usePreferences } from "@/lib/preferences/provider";
import { describeActions, TEXT_SIZES, WIDGET_LABELS, WIDGETS, type Preferences, type UiAction, type WidgetId } from "@/lib/preferences/schema";
import { useMode } from "@/lib/state/mode-context";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1em] text-left font-bold";

function Segmented<T extends string | number>({
  legend,
  hint,
  value,
  options,
  onChange,
}: {
  legend: string;
  hint?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-lg font-bold">{legend}</legend>
      {hint && <p className="-mt-1 text-muted-foreground">{hint}</p>}
      <div className="hairline flex max-w-full flex-wrap gap-1 self-start rounded-[1.6em] bg-card p-1">
        {options.map((o) => (
          <label
            key={String(o.value)}
            className="inline-flex min-h-(--target-min) min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-[1.4em] px-[0.75em] font-bold has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
          >
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {value === o.value && <Check aria-hidden className="size-[0.95em]" strokeWidth={3} />}
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Display and voice: everything Dial can change by voice, changeable by touch and keyboard too. */
export function DisplaySettings() {
  const { prefs, apply, undo, save, resetToDefault, canUndo, unsaved } = usePreferences();
  const { mode } = useMode();
  const { openVoice } = useAskDial();
  const announce = useAnnounce();
  const [confirmReset, setConfirmReset] = useState(false);

  const change = (actions: UiAction[]) => {
    apply(actions);
    announce(`Done: ${describeActions(actions)}.`);
  };
  const set = <K extends keyof Omit<Preferences, "layout">>(type: K) => (value: Preferences[K]) => change([{ type, value } as UiAction]);
  const l = prefs.layout;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">Display and voice</h1>
        <p className="text-muted-foreground">
          These change how the app looks on this device. They work in both Simple and Detailed view (you&apos;re in {mode === "simple" ? "Simple" : "Detailed"} view now).
          Changes apply straight away for this visit; save them to keep them next time.
        </p>
        <button type="button" onClick={openVoice} className={`${pill} self-start bg-accent text-accent-foreground`}>
          Or tell Dial what you need
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-accent p-(--space) text-accent-foreground">
        <p role="status" className="font-bold">
          {unsaved ? "You have changes that are only for this visit." : "Your settings are saved on this device."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { save(); announce("Saved for next time."); }} disabled={!unsaved} className={`${pill} bg-primary text-primary-foreground disabled:opacity-50`}>
            <Save aria-hidden className="size-[1em]" />
            Save for next time
          </button>
          <button type="button" onClick={() => { undo(); announce("Last change undone."); }} disabled={!canUndo} className={`${pill} hairline bg-card disabled:opacity-50`}>
            <Undo2 aria-hidden className="size-[1em]" />
            Undo
          </button>
          {confirmReset ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-bold">Reset everything to the original look?</span>
              <button type="button" onClick={() => { resetToDefault(); setConfirmReset(false); announce("Everything is back to the original look."); }} className={`${pill} bg-primary text-primary-foreground`}>
                Yes, reset
              </button>
              <button type="button" onClick={() => setConfirmReset(false)} className={`${pill} hairline bg-card`}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)} className={`${pill} hairline bg-card`}>
              <RotateCcw aria-hidden className="size-[1em]" />
              Reset to default
            </button>
          )}
        </div>
      </div>
      <section aria-labelledby="s-look" className="elevated flex flex-col gap-6 rounded-xl bg-card p-(--space)">
        <h2 id="s-look" className="sr-only">
          Text and colour
        </h2>
        <Segmented
          legend="Text size"
          value={prefs.textSize}
          options={TEXT_SIZES.map((v) => ({ value: v, label: v === 100 ? "Standard" : `${v}%` }))}
          onChange={set("textSize")}
        />
        <Segmented legend="Contrast" hint="Stronger contrast uses pure black and white with heavier outlines." value={prefs.contrast} options={[{ value: "standard", label: "Standard" }, { value: "high", label: "Stronger" }]} onChange={set("contrast")} />
        <Segmented legend="Light or dark" value={prefs.theme} options={[{ value: "system", label: "Match my device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={set("theme")} />
        <Segmented legend="Spacing" value={prefs.spacing} options={[{ value: "standard", label: "Standard" }, { value: "roomy", label: "More space" }]} onChange={set("spacing")} />
        <Segmented legend="Buttons" hint="Bigger buttons are easier to press." value={prefs.targets} options={[{ value: "standard", label: "Standard" }, { value: "large", label: "Bigger" }]} onChange={set("targets")} />
        <Segmented legend="Animation" value={prefs.motion} options={[{ value: "system", label: "Match my device" }, { value: "reduced", label: "Turn off" }]} onChange={set("motion")} />
      </section>

      <section aria-labelledby="s-layout" className="elevated flex flex-col gap-4 rounded-xl bg-card p-(--space)">
        <div>
          <h2 id="s-layout" className="text-lg font-bold">
            Home screen
          </h2>
          <p className="text-muted-foreground">Choose what appears on your home screen and what comes first. This applies to both views.</p>
        </div>
        <label className="flex min-h-(--target-min) cursor-pointer items-center gap-3 font-bold">
          <input type="checkbox" checked={l.density === "calm"} onChange={(e) => change([{ type: "density", value: e.target.checked ? "calm" : "standard" }])} className="size-6 accent-[var(--primary)]" />
          Calmer home screen: show only the first three sections
        </label>
        <ul className="flex flex-col">
          {WIDGETS.map((w: WidgetId) => {
            const hidden = l.hidden.includes(w);
            const first = l.pinned[0] === w;
            const highlighted = l.emphasis === w;
            return (
              <li key={w} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 last:border-0">
                <label className="flex min-h-(--target-min) min-w-0 cursor-pointer items-center gap-3">
                  <input type="checkbox" checked={!hidden} onChange={() => change([{ type: hidden ? "show" : "hide", widget: w }])} className="size-6 shrink-0 accent-[var(--primary)]" />
                  <span className="font-semibold">{WIDGET_LABELS[w]}</span>
                </label>
                <span className="flex min-w-0 max-w-full flex-wrap gap-2">
                  <button type="button" disabled={first || hidden} onClick={() => change([{ type: "moveToTop", widget: w }])} className={`${pill} hairline bg-card disabled:opacity-50`}>
                    <ArrowUpToLine aria-hidden className="size-[1em]" />
                    {first ? "At the top" : "Move to top"}
                    <span className="sr-only">: {WIDGET_LABELS[w]}</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={highlighted}
                    disabled={hidden}
                    onClick={() => change([highlighted ? { type: "clearEmphasis" } : { type: "emphasize", widget: w }])}
                    className={`${pill} disabled:opacity-50 ${highlighted ? "bg-primary text-primary-foreground" : "hairline bg-card"}`}
                  >
                    <Star aria-hidden className="size-[1em]" />
                    Highlight<span className="sr-only">: {WIDGET_LABELS[w]}</span>
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

    </div>
  );
}
