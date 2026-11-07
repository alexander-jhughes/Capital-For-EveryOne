"use client";

import { Input } from "@/components/ui/input";
import { formatPence } from "@/lib/format";
import { THRESHOLD_PRESETS, type FormErrors, type SettingsForm, type ThresholdChoice } from "@/lib/spend-pause/settings";

export interface FieldProps {
  form: SettingsForm;
  errors: FormErrors;
  change: (next: Partial<SettingsForm>) => void;
  /** Screen-reader and on-screen heading for the group. Simple asks it as a question. */
  legend: string;
}

const optionClass = "flex min-h-(--target-min) cursor-pointer items-center gap-3 rounded-(--radius) border-2 border-input bg-card px-3 py-1 text-base has-checked:border-primary has-checked:font-bold";
const radioClass = "scroll-mb-[calc(var(--target-min)*3)] size-[max(1.5em,24px)] shrink-0 accent-primary";
const inputClass = "scroll-mb-[calc(var(--target-min)*3)] h-auto min-h-(--target-min) rounded-(--radius) border-input px-3 text-base md:text-base";

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="font-bold text-warning">
      {message}
    </p>
  );
}

function Yes({ label, name, checked, onChange }: { label: string; name: string; checked: boolean; onChange: () => void }) {
  return (
    <label className={optionClass}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className={radioClass} />
      {label}
    </label>
  );
}

function PoundsInput({ id, label, value, error, onChange }: { id: string; label: string; value: string; error?: string; onChange: (value: string) => void }) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-base font-bold">
        {label}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={inputClass}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function ThresholdField({ form, errors, change, legend }: FieldProps) {
  const choose = (threshold: ThresholdChoice) => change({ threshold });
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-lg font-bold">{legend}</legend>
      {THRESHOLD_PRESETS.map((amount) => (
        <Yes key={amount} name="threshold" label={`Over ${formatPence(amount).replace(".00", "")}`} checked={form.threshold === String(amount)} onChange={() => choose(`${amount}`)} />
      ))}
      <Yes name="threshold" label="Another amount" checked={form.threshold === "other"} onChange={() => choose("other")} />
      {form.threshold === "other" ? <PoundsInput id="threshold-other" label="Amount in pounds" value={form.otherAmount} error={errors.otherAmount} onChange={(otherAmount) => change({ otherAmount })} /> : null}
      <Yes name="threshold" label="Don't check by amount" checked={form.threshold === "none"} onChange={() => choose("none")} />
      <FieldError id="threshold-error" message={errors.threshold} />
    </fieldset>
  );
}

export function BudgetField({ form, errors, change, legend }: FieldProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-lg font-bold">{legend}</legend>
      <Yes name="budget" label="Yes, set a monthly budget" checked={form.budgetOn} onChange={() => change({ budgetOn: true })} />
      {form.budgetOn ? <PoundsInput id="budget-amount" label="Monthly budget in pounds" value={form.budgetAmount} error={errors.budgetAmount} onChange={(budgetAmount) => change({ budgetAmount })} /> : null}
      <Yes name="budget" label="No monthly budget" checked={!form.budgetOn} onChange={() => change({ budgetOn: false })} />
    </fieldset>
  );
}

export function QuietHoursField({ form, errors, change, legend }: FieldProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="pb-2 text-lg font-bold">{legend}</legend>
      <Yes name="quiet" label="Yes, set quiet hours" checked={form.quietOn} onChange={() => change({ quietOn: true })} />
      {form.quietOn ? (
        <div className="flex flex-wrap gap-(--space)">
          {(
            [
              ["quiet-start", "From", "quietStart"],
              ["quiet-end", "Until", "quietEnd"],
            ] as const
          ).map(([id, label, field]) => (
            <div key={id} className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={id} className="text-base font-bold">
                {label}
              </label>
              <Input
                id={id}
                type="time"
                value={form[field]}
                onChange={(event) => change({ [field]: event.target.value })}
                aria-invalid={errors.quietHours ? true : undefined}
                aria-describedby={errors.quietHours ? "quiet-error" : undefined}
                className={inputClass}
              />
            </div>
          ))}
        </div>
      ) : null}
      <FieldError id="quiet-error" message={errors.quietHours} />
      <Yes name="quiet" label="No quiet hours" checked={!form.quietOn} onChange={() => change({ quietOn: false })} />
    </fieldset>
  );
}
