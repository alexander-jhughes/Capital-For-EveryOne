"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { AGE_BANDS, type AgeBand, PROFILE_SECTIONS, type ProfileAnswers, QUESTIONS, type QuestionId, sanitizeAnswers } from "@/lib/recommender/profile";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1.1em] font-bold";
const row = "flex min-h-(--target-min) cursor-pointer items-center gap-3 border-b py-1 last:border-0";

/** One optional question: its options plus "Prefer not to say" (no answer stored). */
function Choice({ legend, value, options, onChange }: { legend: string; value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="pb-1 font-bold">{legend}</legend>
      {[...options, { value: "", label: "Prefer not to say" }].map((o) => (
        <label key={o.value} className={row}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} className="size-6 shrink-0 accent-[var(--primary)]" />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * "About you": optional questions that help Dial suggest display changes. Every answer can be skipped.
 * Never asks about health, disability, income or anything about the person's finances, and nothing is guessed.
 */
export function AboutYou() {
  const ml = usePersonalisation();
  const announce = useAnnounce();
  const { consent, profile, research } = ml.status;
  const [answers, setAnswers] = useState<ProfileAnswers>({});
  const [ageBand, setAgeBand] = useState<AgeBand | "">("");
  const [saved, setSaved] = useState<"" | "answers" | "research">("");

  // Start from what's saved, once it has loaded.
  useEffect(() => setAnswers(profile?.answers ?? {}), [profile]);
  useEffect(() => setAgeBand(research?.ageBand ?? ""), [research]);

  const set = (id: QuestionId, v: string) => {
    setSaved("");
    setAnswers((a) => sanitizeAnswers({ ...a, [id]: v || undefined }));
  };

  const save = async (next: ProfileAnswers) => {
    const ok = await ml.saveProfile(next);
    if (ok) setSaved("answers");
    announce(ok ? "Saved. Dial will use your answers for its next suggestion." : "That didn't save. Please try again.");
  };

  const intro = (
    <div className="flex flex-col gap-2">
      <h1 className="text-xl font-bold tracking-tight">About you</h1>
      <p className="text-lg text-muted-foreground">
        A few optional questions about how you like to use a money app. Dial uses your answers only to suggest display changes, and only you can keep them.
      </p>
      <p className="text-muted-foreground">
        Every question is optional. Dial never asks about your health, income or debts, and never guesses anything about you. Your text size, contrast, animation
        and button settings are in{" "}
        <Link href="/account/settings" className="font-bold underline underline-offset-4">
          Display and voice
        </Link>{" "}
        and always win over any suggestion.
      </p>
    </div>
  );

  if (!ml.loaded)
    return (
      <div className="flex flex-col gap-6">
        {intro}
        <p role="status">Loading…</p>
      </div>
    );

  if (!ml.status.available)
    return (
      <div className="flex flex-col gap-6">
        {intro}
        <p role="status">This isn&apos;t available right now. Everything else in the app works as usual.</p>
      </div>
    );

  if (!consent.personalisation)
    return (
      <div className="flex flex-col gap-6">
        {intro}
        <div className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
          <p className="font-bold">Suggestions from Dial are off.</p>
          <p>
            To answer these questions, turn suggestions on. Dial will then save your answers, display settings and how you answer its suggestions, under a random ID
            that isn&apos;t linked to your name or account. You can turn it off at any time, and everything saved is deleted.
          </p>
          <button
            type="button"
            onClick={async () => announce((await ml.setConsent({ personalisation: true })) ? "Suggestions on." : "That didn't work. Please try again.")}
            className={`${pill} self-start bg-primary text-primary-foreground`}
          >
            Turn suggestions on
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      {intro}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(answers);
        }}
        className="flex flex-col gap-6"
      >
        {PROFILE_SECTIONS.map((section) => (
          <section key={section.id} aria-labelledby={`about-${section.id}`} className="elevated flex flex-col gap-4 rounded-xl bg-card p-(--space)">
            <h2 id={`about-${section.id}`} className="text-lg font-bold">
              {section.title}
            </h2>
            {QUESTIONS.filter((q) => q.section === section.id).map((q) => (
              <Choice key={q.id} legend={q.label} value={(answers as Record<string, string | undefined>)[q.id] ?? ""} options={q.options} onChange={(v) => set(q.id, v)} />
            ))}
          </section>
        ))}
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={`${pill} bg-primary text-primary-foreground`}>
            <Check aria-hidden className="size-[1em]" />
            Save answers
          </button>
          <button
            type="button"
            onClick={() => {
              setAnswers({});
              void save({});
            }}
            className={`${pill} hairline bg-card`}
          >
            Clear all my answers
          </button>
          <Link href="/account" className={`${pill} hairline bg-card`}>
            Back to Home
          </Link>
        </div>
        <p role="status" className="empty:hidden">
          {saved === "answers" ? "Saved. Dial will use your answers for its next suggestion." : ""}
        </p>
      </form>

      <section aria-labelledby="about-research" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
        <h2 id="about-research" className="text-lg font-bold">
          Usability research (optional)
        </h2>
        {consent.research ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await ml.saveResearch(ageBand ? { ageBand } : {});
              if (ok) setSaved("research");
              announce(ok ? "Saved." : "That didn't save. Please try again.");
            }}
            className="flex flex-col gap-3"
          >
            <p className="text-muted-foreground">
              Used only to check that suggestions work equally well for different groups. It is never used to make suggestions, and it is stored separately.
            </p>
            <Choice legend="Your age band" value={ageBand} options={AGE_BANDS.map((b) => ({ value: b, label: b === "65+" ? "65 or over" : b.replace("-", " to ") }))} onChange={(v) => setAgeBand(v as AgeBand | "")} />
            <button type="submit" className={`${pill} self-start bg-primary text-primary-foreground`}>
              Save
            </button>
            <p role="status" className="empty:hidden">
              {saved === "research" ? "Saved." : ""}
            </p>
          </form>
        ) : (
          <p className="text-muted-foreground">
            Off. You can turn it on in{" "}
            <Link href="/account/settings#suggestions" className="font-bold underline underline-offset-4">
              Display and voice
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
