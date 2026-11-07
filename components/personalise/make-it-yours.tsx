"use client";

import { Check, Info, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { usePreferences } from "@/lib/preferences/provider";
import { CHOICES, recommend, STYLE_ORDER, STYLES, type ChoiceId } from "@/lib/preferences/recommend";
import { useStylePreview } from "./style-preview";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1.1em] font-bold";

/** Optional, skippable personalisation. Suggestions come from a published rule table, never from account data. */
export function MakeItYours() {
  const [picked, setPicked] = useState<ChoiceId[]>([]);
  const [shown, setShown] = useState(false);
  const { prefs, apply } = usePreferences();
  const { start } = useStylePreview();
  const router = useRouter();
  const announce = useAnnounce();
  const legendId = useId();
  const rec = shown ? recommend(picked) : null;
  const maxScore = rec ? Math.max(...Object.values(rec.scores), 1) : 1;

  const toggle = (id: ChoiceId) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const skip = () => {
    apply([{ type: "onboarding", value: "skipped" }], { save: true });
    announce("Skipped. You can personalise any time from Display and voice.");
    router.push("/account");
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">Make it yours</h1>
        <p className="text-lg text-muted-foreground">Tell us what you&apos;d like and we&apos;ll suggest a style. It&apos;s optional, and you can change it whenever you like.</p>
        {prefs.onboarding !== "unset" && <p className="text-sm text-muted-foreground">You&apos;ve done this before. Choosing again replaces nothing until you keep a new style.</p>}
      </div>

      {!rec ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setShown(true);
          }}
          className="flex flex-col gap-4"
        >
          <fieldset className="elevated flex min-w-0 flex-col gap-1 rounded-xl bg-card p-(--space)" aria-describedby={`${legendId}-hint`}>
            <legend className="sr-only">What would you like?</legend>
            <p className="text-lg font-bold">What would you like?</p>
            <p id={`${legendId}-hint`} className="pb-2 text-muted-foreground">
              Tick any that appeal. Ticking none is fine too.
            </p>
            {CHOICES.map((c) => (
              <label key={c.id} className="flex min-h-(--target-min) cursor-pointer items-center gap-3 border-b py-1 last:border-0">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} className="size-6 shrink-0 accent-[var(--primary)]" />
                <span className="font-semibold">{c.label}</span>
              </label>
            ))}
          </fieldset>
          {shown && picked.length === 0 && (
            <p role="status" className="font-bold">
              Tick at least one thing to get a suggestion, or skip.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={`${pill} bg-primary text-primary-foreground`}>
              <Sparkles aria-hidden className="size-[1em]" />
              Suggest a style
            </button>
            <button type="button" onClick={skip} className={`${pill} hairline bg-card`}>
              Skip for now
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4" aria-live="polite">
          <section aria-labelledby="rec-h" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
            <p className="text-sm font-bold text-muted-foreground">We suggest</p>
            <h2 id="rec-h" className="text-xl font-bold tracking-tight">
              {STYLES[rec.style].name}
            </h2>
            <p>{STYLES[rec.style].summary}</p>
            {rec.reasons.length > 0 && (
              <div>
                <p className="font-bold">Because you chose:</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {rec.reasons.map((r) => (
                    <li key={r.label} className="flex items-center gap-2">
                      <Check aria-hidden className="size-[1em] shrink-0 text-primary" />
                      {r.label} <span className="text-sm text-muted-foreground">(+{r.points})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {rec.direct.length > 0 && <p className="text-muted-foreground">Also turned on directly: {rec.direct.join(", ").toLowerCase()}.</p>}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  start(rec);
                  router.push("/account");
                }}
                className={`${pill} bg-primary text-primary-foreground`}
              >
                Preview it on my home screen
              </button>
              <button type="button" onClick={() => setShown(false)} className={`${pill} hairline bg-card`}>
                Change my choices
              </button>
              <button type="button" onClick={skip} className={`${pill} hairline bg-card`}>
                No thanks
              </button>
            </div>
          </section>

          <details className="rounded-xl bg-card p-(--space) hairline">
            <summary className="flex min-h-(--target-min) cursor-pointer items-center gap-2 font-bold">
              <Info aria-hidden className="size-[1.1em]" />
              How this suggestion was made
            </summary>
            <div className="flex flex-col gap-3 pt-2">
              <p>
                Each thing you ticked adds points to one or more styles, using a fixed table. The style with the most points is suggested; a tie goes to the
                calmer style. This is a simple set of rules, not artificial intelligence.
              </p>
              <table className="w-full">
                <caption className="pb-1 text-left font-bold">Points for each style</caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Style</th>
                    <th scope="col">Points</th>
                  </tr>
                </thead>
                <tbody>
                  {STYLE_ORDER.map((s) => (
                    <tr key={s}>
                      <th scope="row" className="w-[45%] py-1 pr-2 text-left font-semibold">
                        {STYLES[s].name}
                      </th>
                      <td className="py-1">
                        <span className="flex items-center gap-2">
                          <span aria-hidden className="h-2 flex-1 rounded-full bg-chart-track">
                            <span className="block h-full rounded-full bg-chart" style={{ width: `${(rec.scores[s] * 100) / maxScore}%` }} />
                          </span>
                          <span className="w-6 text-right font-bold">{rec.scores[s]}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-muted-foreground">
                It only uses the boxes you ticked. It doesn&apos;t look at your transactions or spending, doesn&apos;t guess anything about you, and nothing is
                saved unless you keep a style.
              </p>
            </div>
          </details>
        </div>
      )}

      <Link href="/account/settings" className="inline-flex min-h-(--target-min) items-center self-start font-bold text-primary underline underline-offset-4">
        Fine-tune every setting in Display and voice
      </Link>
    </div>
  );
}
