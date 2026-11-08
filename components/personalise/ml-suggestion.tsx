"use client";

import { Info, Lightbulb, ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import type { Suggestion } from "@/lib/personalisation/client";
import { shouldShowCard } from "@/lib/personalisation/controller";
import { usePersonalisation, useSuggestionFeed } from "@/lib/personalisation/provider";
import { usePreferences } from "@/lib/preferences/provider";
import { CATALOG, configurationActions, type ItemId } from "@/lib/recommender/catalog";
import type { Configuration, EvidenceLevel } from "@/lib/recommender/types";
import { useStylePreview } from "./style-preview";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1.1em] font-bold";

const confidenceWords = (p: number) => (p >= 0.8 ? "high" : p >= 0.65 ? "fairly high" : "moderate");
const EVIDENCE_WORDS: Record<EvidenceLevel, string> = {
  strong: "lots of similar profiles",
  moderate: "a fair number of similar profiles",
  limited: "only a few similar profiles",
  insufficient: "very few similar profiles",
};
const titleOf = (items: ItemId[]) => items.map((id) => CATALOG[id].title).join(", ");

/**
 * One optional suggestion from Dial: a small, compatible set of display changes. It asks; nothing changes until
 * "Preview it" and then "Keep it" on the preview bar. The person can untick parts, pick another option, say no,
 * or put it off. After keeping, Dial asks once whether it made the app easier to use.
 */
export function MlSuggestion() {
  const [finished, setFinished] = useState(false);
  const [kept, setKept] = useState<string | null>(null);
  const ml = useSuggestionFeed(!finished);
  const { prefs, preview } = usePreferences();
  const { active } = useStylePreview();
  const announce = useAnnounce();

  if (kept)
    return (
      <RatePrompt
        onRate={(satisfaction) => {
          if (satisfaction !== null) ml.rate(kept, satisfaction);
          announce(satisfaction === null ? "OK." : "Thanks. That helps Dial suggest better.");
          setKept(null);
        }}
      />
    );

  const s = ml.suggestion;
  if (
    finished ||
    !s ||
    !shouldShowCard({ consented: ml.status.consent.personalisation, suggestionId: s.id, onboarding: prefs.onboarding, previewActive: preview !== null || active !== null, answered: ml.answered })
  )
    return null;

  return (
    <SuggestionCard
      key={s.id}
      s={s}
      onKept={() => {
        setFinished(true);
        setKept(s.id);
      }}
      onDone={() => setFinished(true)}
    />
  );
}

function SuggestionCard({ s, onKept, onDone }: { s: Suggestion; onKept: () => void; onDone: () => void }) {
  const ml = usePersonalisation();
  const { startRequest } = useStylePreview();
  const announce = useAnnounce();
  const id = useId();
  const [chosen, setChosen] = useState<ItemId[]>(s.configuration.items);
  const main = s.configuration.items;
  const synthetic = s.trainedOn === "synthetic";

  const previewItems = (items: ItemId[]) => {
    const { actions, mode } = configurationActions(items);
    startRequest({
      name: titleOf(items),
      actions,
      mode,
      source: "ml",
      onFinish: (keep) => {
        const whole = items.length === main.length && items.every((i) => main.includes(i));
        ml.respond(s, keep ? (whole ? "accepted" : "modified") : "rejected", items);
        if (keep) onKept();
        else onDone();
      },
    });
  };
  const toggle = (item: ItemId) => setChosen((c) => (c.includes(item) ? c.filter((x) => x !== item) : main.filter((x) => x === item || c.includes(x))));
  const decline = () => {
    ml.respond(s, "rejected", main);
    announce("OK. Dial won't suggest that again for a while.");
    onDone();
  };
  const later = () => {
    ml.respond(s, "dismissed", main);
    announce("OK. Dial will hold that suggestion for now.");
    onDone();
  };

  return (
    <section aria-labelledby={`${id}-h`} className="hairline flex flex-col gap-3 rounded-xl bg-card p-(--space)">
      <h2 id={`${id}-h`} className="flex items-center gap-2 font-bold">
        <Lightbulb aria-hidden className="size-[1.1em] shrink-0 text-primary" />
        A suggestion from Dial
      </h2>
      <p className="text-lg">{s.configuration.offer || `Would you like to try: ${s.configuration.title}?`}</p>
      <p className="text-muted-foreground">Nothing changes unless you preview it and choose Keep it.</p>

      {main.length > 1 && (
        <fieldset className="flex min-w-0 flex-col gap-1">
          <legend className="font-bold">What would change</legend>
          <p className="text-sm text-muted-foreground">Untick anything you don&apos;t want.</p>
          {main.map((item) => (
            <label key={item} className="flex min-h-(--target-min) cursor-pointer items-center gap-3">
              <input type="checkbox" checked={chosen.includes(item)} onChange={() => toggle(item)} className="size-6 shrink-0 accent-[var(--primary)]" />
              <span>{CATALOG[item].title}</span>
            </label>
          ))}
        </fieldset>
      )}

      <p className="text-sm text-muted-foreground">
        Dial&apos;s confidence: {confidenceWords(s.configuration.confidence)}, based on {EVIDENCE_WORDS[s.configuration.evidence]}
        {synthetic ? " in its practice data" : ""}.
      </p>

      <details className="rounded-lg bg-accent px-(--space) py-1 text-accent-foreground">
        <summary className="flex min-h-(--target-min) cursor-pointer items-center gap-2 font-bold">
          <Info aria-hidden className="size-[1.1em] shrink-0" />
          Why am I seeing this?
        </summary>
        <div className="flex flex-col gap-2 pb-2">
          {s.explanation.summary && <p>{s.explanation.summary}</p>}
          {s.explanation.reasons.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-6">
              {s.explanation.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {s.warnings
            .filter((w) => w.code !== "synthetic_only")
            .map((w) => (
              <p key={w.code}>{w.text}</p>
            ))}
          <p>
            Dial uses only the answers you chose to give, your display settings and the display changes you kept. It never uses your spending, transactions or account,
            or what you say to Dial. Suggestions are worked out on Dial&apos;s own server, never by another company.
          </p>
          {synthetic && <p>These suggestions come from a model trained on made-up practice data. It hasn&apos;t been tested with real people yet.</p>}
          <div className="flex flex-wrap gap-x-4">
            <Link href="/account/personalise/about-you" className="inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4">
              Change your answers
            </Link>
            <Link href="/account/settings#suggestions" className="inline-flex min-h-(--target-min) items-center font-bold underline underline-offset-4">
              Turn suggestions off
            </Link>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => previewItems(chosen)} disabled={chosen.length === 0} className={`${pill} bg-primary text-primary-foreground disabled:opacity-50`}>
          {chosen.length === main.length ? "Preview it" : "Preview my choice"}
        </button>
        <button type="button" onClick={decline} className={`${pill} hairline bg-card`}>
          No thanks
        </button>
        <button type="button" onClick={later} className={`${pill} hairline bg-card`}>
          Not now
        </button>
      </div>
      {chosen.length === 0 && <p role="status">Tick at least one change to preview it.</p>}

      {s.alternatives.length > 0 && <Alternatives options={s.alternatives} onPreview={previewItems} />}
    </section>
  );
}

function Alternatives({ options, onPreview }: { options: Configuration[]; onPreview: (items: ItemId[]) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h3 id={id} className="font-bold">
        Or try something else
      </h3>
      <ul aria-labelledby={id} className="flex flex-col gap-2">
        {options.map((c) => (
          <li key={c.items.join()} className="flex flex-wrap items-center justify-between gap-2">
            <span>{c.title || titleOf(c.items)}</span>
            <button type="button" onClick={() => onPreview(c.items)} className={`${pill} hairline bg-card`}>
              Preview this instead
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RatePrompt({ onRate }: { onRate: (satisfaction: -1 | 0 | 1 | null) => void }) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-h`} className="hairline flex flex-col gap-3 rounded-xl bg-card p-(--space)">
      <h2 id={`${id}-h`} className="font-bold">
        Kept. Did that make Dial easier to use?
      </h2>
      <p className="text-muted-foreground">Optional. Your answer helps Dial suggest better. You can change it back any time in Display and voice, or with the Simple and Detailed switch.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onRate(1)} className={`${pill} hairline bg-card`}>
          <ThumbsUp aria-hidden className="size-[1em]" />
          Yes, easier
        </button>
        <button type="button" onClick={() => onRate(0)} className={`${pill} hairline bg-card`}>
          No difference
        </button>
        <button type="button" onClick={() => onRate(-1)} className={`${pill} hairline bg-card`}>
          <ThumbsDown aria-hidden className="size-[1em]" />
          No, harder
        </button>
        <button type="button" onClick={() => onRate(null)} className={`${pill} hairline bg-card`}>
          Skip
        </button>
      </div>
    </section>
  );
}
