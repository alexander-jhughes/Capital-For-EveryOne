"use client";

// First run. Four short steps, every one skippable, nothing guessed: the person picks each setting themselves, and it
// applies immediately so the screen they're reading is the preview. Choices are saved only when they finish.
import { ArrowLeft, ArrowRight, Check, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { RESET_SPEND_PAUSE } from "@/lib/demo-config";
import { formatLongDate, formatPence } from "@/lib/format";
import { utilisationPercent } from "@/lib/learn/credit";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { usePreferences } from "@/lib/preferences/provider";
import { isWidgetShown, TEXT_SIZES, WIDGET_LABELS, WIDGETS, type Preferences, type UiAction } from "@/lib/preferences/schema";
import { useAccount } from "@/lib/state/account-context";
import { useMode } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import { DialMark } from "../wordmark";
import { Money } from "../ui/money";
import { Meter } from "../ui/panel";

const primary = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full bg-primary px-6 text-lg font-bold text-primary-foreground";
const secondary = "hairline inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full bg-card px-5 font-bold";
const choice = "flex min-h-(--target-min) cursor-pointer items-center gap-3 rounded-(--radius) border-2 border-input bg-card px-3 py-2 has-checked:border-primary has-checked:font-bold has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring";
const radio = "size-[max(1.4em,24px)] shrink-0 accent-primary";
const STEPS = ["Your view", "Reading comfort", "Your home screen", "Ready"] as const;

/** A real bill card in either view's sizes, scaled down. A picture of the choice: the label next to it says it in words. */
function ViewPreview({ mode }: { mode: Mode }) {
  const { account } = useAccount();
  const used = utilisationPercent(account.currentBalance, account.creditLimit) ?? 0;
  return (
    <div aria-hidden inert data-preview={mode} style={{ "--scale": 0.72, "--figure-scale": 0.72 } as React.CSSProperties} className="pointer-events-none mt-2 w-full overflow-hidden rounded-(--radius) bg-background p-(--space)">
      {mode === "simple" ? (
        <div className="flex flex-col gap-2">
          <p className="text-lg font-semibold text-muted-foreground">Your bill is</p>
          <p className="figure">
            <Money pence={account.statementBalance} />
          </p>
          <p className="text-lg font-bold">Due {formatLongDate(account.paymentDueDate)}</p>
          <span className="flex min-h-(--target-min) items-center justify-center rounded-xl bg-primary text-lg font-bold text-primary-foreground">Pay my bill</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl bg-hero p-(--space) text-hero-foreground">
          <p className="flex justify-between text-sm text-hero-muted">
            <span>Current balance</span>
            <span>{account.apr}% APR</span>
          </p>
          <p className="text-xl font-bold">
            <Money pence={account.currentBalance} />
          </p>
          <span className="block h-2 overflow-hidden rounded-full bg-white/20">
            <span className="block h-full rounded-full bg-[#6cc4e8]" style={{ width: `${Math.min(100, used)}%` }} />
          </span>
          <p className="text-sm text-hero-muted">
            {used}% used · bill {formatPence(account.statementBalance)}, minimum {formatPence(account.minimumPayment)}
          </p>
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string | number>({ legend, value, options, onChange }: { legend: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 font-bold">{legend}</legend>
      {options.map((o) => (
        <label key={String(o.value)} className={choice}>
          <input type="radio" name={legend} checked={value === o.value} onChange={() => onChange(o.value)} className={radio} />
          <span className="flex flex-col">
            <span>{o.label}</span>
            {o.hint && <span className="text-sm font-normal text-muted-foreground">{o.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** After "Start the demo again": forget this device's demo state, then turn the demo's Spend Pause back on. */
function useDemoReset(active: boolean) {
  const { ready, updateSettings } = useAccount();
  const announce = useAnnounce();
  const router = useRouter();
  const [done, setDone] = useState(false);
  // Kept after the URL loses ?reset=done, so the confirmation stays on screen.
  const [shown] = useState(active);
  // Runs before the providers' own effects read storage (children's effects run first).
  useEffect(() => {
    if (!active) return;
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (const k of Object.keys(store)) if (k.startsWith("cfe-")) store.removeItem(k);
      } catch {}
    }
  }, [active]);
  useEffect(() => {
    if (!active || !ready || done) return;
    updateSettings(RESET_SPEND_PAUSE);
    setDone(true);
    announce("The demo has been reset.");
    router.replace("/");
  }, [active, ready, done, updateSettings, announce, router]);
  return shown;
}

export function Onboarding({ reset = false }: { reset?: boolean }) {
  const { prefs, apply } = usePreferences();
  const { mode, setMode } = useMode();
  const ml = usePersonalisation();
  const router = useRouter();
  const announce = useAnnounce();
  const wasReset = useDemoReset(reset);
  const [step, setStep] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (step !== null) heading.current?.focus();
  }, [step]);

  const change = (actions: UiAction[]) => apply(actions, { source: "settings" });
  const set = <K extends "textSize" | "contrast" | "motion" | "targets" | "charts" | "learning">(type: K) => (value: Preferences[K]) => change([{ type, value } as UiAction]);
  const finish = (how: "done" | "skipped") => {
    // One apply with save writes every choice kept during setup, plus this one, to the cookie.
    apply([{ type: "onboarding", value: how }], { source: "settings", save: true });
    announce(how === "done" ? "Your choices are saved. Signing you in." : "Setup skipped. You can change anything in Display and voice.");
    router.push("/account");
  };

  if (step === null) {
    const back = prefs.onboarding !== "unset";
    return (
      <div className="flex flex-col gap-(--space) py-4">
        <DialMark className="size-16" />
        <h1 className="text-xl font-bold tracking-tight">Credit, made accessible.</h1>
        <p className="text-lg text-muted-foreground">
          Capital for Everyone shows your credit card the way that suits you, explains every figure in plain English, and helps you learn and set goals. Dial, the assistant, answers questions about your account.
        </p>
        {wasReset && (
          <p role="status" className="rounded-xl bg-accent px-(--space) py-3 font-bold text-accent-foreground">
            The demo is back to the start.
          </p>
        )}
        <p className="rounded-xl bg-warning-surface px-(--space) py-3 text-warning">
          <strong>Demo account.</strong> Every figure belongs to one fictional card. Nothing here is real financial information.
        </p>
        {back ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Link href="/account" className={primary}>
              Sign in to the demo
            </Link>
            <button type="button" onClick={() => setStep(0)} className={secondary}>
              Set up my view again
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button type="button" onClick={() => setStep(0)} className={primary}>
              Set up my view
              <ArrowRight aria-hidden className="size-[1em]" />
            </button>
            <button type="button" onClick={() => finish("skipped")} className={secondary}>
              Skip and sign in
            </button>
          </div>
        )}
        <p className="text-sm text-muted-foreground">Setup takes about a minute. Every step can be skipped, and you can change anything later.</p>
      </div>
    );
  }

  const last = step === STEPS.length - 1;
  return (
    <div className="flex flex-col gap-(--space) py-2">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-bold text-muted-foreground">
          Step {step + 1} of {STEPS.length}
        </p>
        <Meter label="Setup progress" value={step + 1} max={STEPS.length} valueText={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} />
      </div>
      <h1 ref={heading} tabIndex={-1} className="text-xl font-bold tracking-tight focus:outline-none">
        {["How would you like it to look?", "Make reading comfortable", "Choose what Home shows", "You're all set"][step]}
      </h1>

      {step === 0 && (
        <fieldset className="flex flex-col gap-(--space)">
          <legend className="pb-2">Pick a view. The page changes as you choose, and you can switch any time with the button at the top.</legend>
          <div className="grid grid-cols-1 gap-(--space) sm:grid-cols-2">
            {(
              [
                { value: "simple", label: "Simple", hint: "The few things that matter, in large type, one clear action at a time." },
                { value: "complex", label: "Detailed", hint: "Everything on one screen: balance, bill, charts, categories and history." },
              ] as const
            ).map((o) => (
              <label key={o.value} className={`${choice} flex-col items-start`}>
                <span className="flex items-center gap-3">
                  <input type="radio" name="onboarding-view" checked={mode === o.value} onChange={() => setMode(o.value)} className={radio} />
                  <span className="text-lg">{o.label}</span>
                </span>
                <span className="text-base font-normal text-muted-foreground">{o.hint}</span>
                <ViewPreview mode={o.value} />
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-(--space)">
          <p>Each choice applies straight away, so you can see it before you continue.</p>
          <Segmented legend="Text size" value={prefs.textSize} onChange={set("textSize")} options={TEXT_SIZES.map((t) => ({ value: t, label: t === 100 ? "Standard" : `${t}%` }))} />
          <Segmented
            legend="Contrast"
            value={prefs.contrast}
            onChange={set("contrast")}
            options={[
              { value: "standard", label: "Standard" },
              { value: "high", label: "Stronger contrast", hint: "Black and white with heavier outlines." },
            ]}
          />
          <Segmented
            legend="Buttons"
            value={prefs.targets}
            onChange={set("targets")}
            options={[
              { value: "standard", label: "Standard size" },
              { value: "large", label: "Larger and easier to press" },
            ]}
          />
          <Segmented
            legend="Animation"
            value={prefs.motion}
            onChange={set("motion")}
            options={[
              { value: "system", label: "Follow my device" },
              { value: "reduced", label: "Turn animation off" },
            ]}
          />
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-(--space)">
          <Segmented
            legend="How much at once"
            value={prefs.layout.density}
            onChange={(v) => change([{ type: "density", value: v }])}
            options={[
              { value: "standard", label: "Show every section I choose" },
              { value: "calm", label: "Keep it calm", hint: "Only the first three sections, so there's less to take in." },
            ]}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="pb-2 font-bold">Sections on Home in {mode === "simple" ? "Simple" : "Detailed"} view</legend>
            {WIDGETS.map((w) => {
              const on = isWidgetShown(mode, prefs.layout, w);
              return (
                <label key={w} className={choice}>
                  <input type="checkbox" checked={on} onChange={() => change([{ type: on ? "hide" : "show", widget: w }])} className={radio} />
                  <span>{WIDGET_LABELS[w]}</span>
                </label>
              );
            })}
          </fieldset>
          <Segmented
            legend="Charts"
            value={prefs.charts}
            onChange={set("charts")}
            options={[
              { value: "show", label: "Show charts", hint: "Every chart also has its figures in words." },
              { value: "hide", label: "Lists of figures instead" },
            ]}
          />
          <Segmented
            legend="Credit Learning Lab"
            value={prefs.learning}
            onChange={set("learning")}
            options={[
              { value: "on", label: "Show it", hint: "Calculators, explainers and a short quiz about credit." },
              { value: "off", label: "Not for me" },
            ]}
          />
          <Segmented
            legend="Suggestions"
            value={ml.consent === "granted" ? "on" : "off"}
            onChange={(v) => ml.setConsent(v === "on")}
            options={[
              { value: "off", label: "No suggestions", hint: "The default. Nothing about how you use the app is counted." },
              { value: "on", label: "Suggest display changes", hint: "Counts taps on this device only, never your money or questions. Every suggestion is a preview you keep or reject." },
            ]}
          />
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-(--space)">
          <ul className="flex flex-col gap-2">
            {[
              `${mode === "simple" ? "Simple" : "Detailed"} view`,
              `Text ${prefs.textSize === 100 ? "at standard size" : `at ${prefs.textSize}%`}${prefs.contrast === "high" ? ", stronger contrast" : ""}${prefs.targets === "large" ? ", larger buttons" : ""}${prefs.motion === "reduced" ? ", no animation" : ""}`,
              `Home ${prefs.layout.density === "calm" ? "kept calm, three sections" : "shows the sections you chose"}${prefs.charts === "hide" ? ", figures as lists" : ""}`,
              `Learning Lab ${prefs.learning === "on" ? "on" : "off"}, suggestions ${ml.consent === "granted" ? "on" : "off"}`,
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <CircleCheck aria-hidden className="mt-1 size-[1.1em] shrink-0 text-success" />
                {t}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">Change any of this later in Display and voice, or just ask Dial, for example &ldquo;make the text bigger&rdquo;.</p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <button type="button" onClick={() => (last ? finish("done") : setStep(step + 1))} className={primary}>
          {last ? (
            <>
              <Check aria-hidden className="size-[1em]" />
              Sign in to the demo
            </>
          ) : (
            <>
              Continue
              <ArrowRight aria-hidden className="size-[1em]" />
            </>
          )}
        </button>
        <button type="button" onClick={() => setStep(step === 0 ? null : step - 1)} className={secondary}>
          <ArrowLeft aria-hidden className="size-[1em]" />
          Back
        </button>
        {!last && (
          <button type="button" onClick={() => finish("skipped")} className="inline-flex min-h-(--target-min) items-center px-3 font-bold text-primary underline underline-offset-4">
            Skip setup
          </button>
        )}
      </div>
    </div>
  );
}
