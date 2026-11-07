"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { describeChecks, formFromSettings, settingsFromForm, validateForm, type FormErrors, type SettingsForm } from "@/lib/spend-pause/settings";
import { useMode } from "@/lib/state/mode-context";
import type { SpendPauseSettings } from "@/lib/types";
import { BudgetField, QuietHoursField, ThresholdField, type FieldProps } from "./settings-fields";
import { actionClass, panelClass } from "./styles";

interface EditorProps {
  settings: SpendPauseSettings;
  onSave: (settings: SpendPauseSettings) => void;
  onCancel: () => void;
  /** Shown first when someone must choose checks before turning Spend Pause on. */
  intro?: string;
}

/** One set of questions, shown as one form in Complex and one question per screen in Simple. */
export function SettingsEditor(props: EditorProps) {
  return useMode().mode === "simple" ? <SimpleSteps {...props} /> : <ComplexForm {...props} />;
}

function useForm(settings: SpendPauseSettings) {
  const [form, setForm] = useState<SettingsForm>(() => formFromSettings(settings));
  const [errors, setErrors] = useState<FormErrors>({});
  const change = (next: Partial<SettingsForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setErrors({});
  };
  return { form, errors, setErrors, change };
}

/** Moves focus to the first problem, so a keyboard or screen-reader user lands on what to fix. */
function focusFirstError(root: HTMLElement | null) {
  (root?.querySelector("[aria-invalid='true']") as HTMLElement | null)?.focus();
}

function ComplexForm({ settings, onSave, onCancel, intro }: EditorProps) {
  const { form, errors, setErrors, change } = useForm(settings);
  const formRef = useRef<HTMLFormElement>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateForm(form);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(settingsFromForm(form, settings.enabled));
    else requestAnimationFrame(() => focusFirstError(formRef.current));
  };
  const fields: Omit<FieldProps, "legend"> = { form, errors, change };

  return (
    <form ref={formRef} onSubmit={submit} noValidate className={`flex flex-col gap-(--space) ${panelClass}`}>
      <h2 className="text-lg font-bold">Choose what to check</h2>
      {intro ? <p className="text-base">{intro}</p> : null}
      <ThresholdField {...fields} legend="Check any purchase over" />
      <BudgetField {...fields} legend="Monthly budget (optional)" />
      <QuietHoursField {...fields} legend="Quiet hours (optional)" />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" className={actionClass}>
          Save choices
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} className={`${actionClass} border-input`}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const STEPS = ["threshold", "budget", "quietHours", "review"] as const;

function SimpleSteps({ settings, onSave, onCancel, intro }: EditorProps) {
  const { form, errors, setErrors, change } = useForm(settings);
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const name = STEPS[step];
  const fields: Omit<FieldProps, "legend"> = { form, errors, change };

  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

  const finalErrors = name === "review" ? validateForm(form) : {};
  const preview = settingsFromForm(form, settings.enabled);

  const next = () => {
    if (name === "review") return;
    const found = validateForm(form, name);
    setErrors(found);
    if (Object.keys(found).length === 0) setStep(step + 1);
    else requestAnimationFrame(() => focusFirstError(panel.current));
  };

  return (
    <div ref={panel} className={`flex flex-col gap-(--space) ${panelClass}`}>
      <h2 ref={heading} tabIndex={-1} className="text-base font-bold focus:outline-none">
        Question {step + 1} of {STEPS.length}
      </h2>
      {intro && step === 0 ? <p className="text-base">{intro}</p> : null}
      {name === "threshold" ? <ThresholdField {...fields} legend="When should we check with you?" /> : null}
      {name === "budget" ? <BudgetField {...fields} legend="Do you want a monthly budget?" /> : null}
      {name === "quietHours" ? <QuietHoursField {...fields} legend="Do you want quiet hours?" /> : null}
      {name === "review" ? (
        <>
          <p className="text-lg font-bold">Is this right?</p>
          {finalErrors.threshold ? (
            <p className="font-bold text-warning">{finalErrors.threshold}</p>
          ) : (
            <ul className="list-disc pl-5 text-base">
              {describeChecks(preview).map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <div className="flex flex-col gap-2">
        {name === "review" ? (
          <Button onClick={() => onSave(preview)} disabled={Object.keys(finalErrors).length > 0} className={actionClass}>
            Save choices
          </Button>
        ) : (
          <Button onClick={next} className={actionClass}>
            Next
          </Button>
        )}
        <Button variant="outline" onClick={() => (step === 0 ? onCancel() : setStep(step - 1))} className={`${actionClass} border-input`}>
          {step === 0 ? "Cancel" : "Back"}
        </Button>
      </div>
    </div>
  );
}
