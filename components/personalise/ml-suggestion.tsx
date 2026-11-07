"use client";

import { Info, Lightbulb } from "lucide-react";
import Link from "next/link";
import { useAnnounce } from "@/components/live-region";
import { shouldShowCard } from "@/lib/personalisation/controller";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { usePreferences } from "@/lib/preferences/provider";
import type { UiAction } from "@/lib/preferences/schema";
import { useStylePreview } from "./style-preview";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1.1em] font-bold";

/** One optional display suggestion from Dial. Asks; never changes anything until "Preview it" then "Keep it". */
export function MlSuggestion() {
  const { consent, result, recordOutcome } = usePersonalisation();
  const { prefs, preview } = usePreferences();
  const { startRequest, active } = useStylePreview();
  const announce = useAnnounce();

  if (!result || !shouldShowCard({ consent, result, onboarding: prefs.onboarding, previewActive: preview !== null || active !== null })) return null;
  const rec = result.preferences[0];
  const fingerprint = result.fingerprint!;

  const previewIt = () =>
    startRequest({
      name: rec.title,
      // SuggestedAction is a compile-time-checked subset of UiAction (lib/personalisation/targets.ts).
      actions: rec.actions.map((a): UiAction => a),
      source: "ml",
      onFinish: (kept) => recordOutcome(rec.target, kept ? "accepted" : "rejected", fingerprint),
    });
  const decline = () => {
    recordOutcome(rec.target, "rejected", fingerprint);
    announce("OK. Dial won't suggest that again.");
  };
  const later = () => {
    recordOutcome(rec.target, "ignored", fingerprint);
    announce("OK. Dial will hold that suggestion for now.");
  };

  return (
    <section aria-labelledby="ml-suggestion-h" className="hairline flex flex-col gap-3 rounded-xl bg-card p-(--space)">
      <h2 id="ml-suggestion-h" className="flex items-center gap-2 font-bold">
        <Lightbulb aria-hidden className="size-[1.1em] shrink-0 text-primary" />
        A suggestion from Dial
      </h2>
      <p className="text-lg">{rec.offer}</p>
      <p className="text-muted-foreground">Nothing changes unless you preview it and choose Keep it.</p>
      <details className="rounded-lg bg-accent px-(--space) py-1 text-accent-foreground">
        <summary className="flex min-h-(--target-min) cursor-pointer items-center gap-2 font-bold">
          <Info aria-hidden className="size-[1.1em] shrink-0" />
          Why am I seeing this?
        </summary>
        <div className="flex flex-col gap-2 pb-2">
          <p className="font-bold">Because:</p>
          <ul className="flex list-disc flex-col gap-1 pl-6">
            {rec.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p>
            Dial only looks at display settings you chose and display changes you kept, on this device. It never looks at your spending, transactions or account, or
            at what you say to Dial, and nothing is sent anywhere.
          </p>
          <p>This suggestion comes from a model trained on made-up example data. It hasn&apos;t been tested with real people yet.</p>
          <Link href="/account/settings#suggestions" className="inline-flex min-h-(--target-min) items-center self-start font-bold underline underline-offset-4">
            Turn suggestions off
          </Link>
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={previewIt} className={`${pill} bg-primary text-primary-foreground`}>
          Preview it
        </button>
        <button type="button" onClick={decline} className={`${pill} hairline bg-card`}>
          No thanks
        </button>
        <button type="button" onClick={later} className={`${pill} hairline bg-card`}>
          Not now
        </button>
      </div>
    </section>
  );
}
