"use client";
// Similar-user insights on Home (demo). Compares the person's own display choices with three SYNTHETIC sample profiles
// (lib/similar-users/profiles.ts) and suggests a view. Nothing changes until "Try"; it uses the existing Simple/Detailed
// switch. "Not now" hides it for this visit.
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePreferences } from "@/lib/preferences/provider";
import { closestProfile, SIGNAL_LABEL } from "@/lib/similar-users/profiles";
import { useMode } from "@/lib/state/mode-context";

const KEY = "cfe-similar-dismissed";

export function SimilarUsersBanner() {
  const { prefs } = usePreferences();
  const { mode, setMode } = useMode();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  useEffect(() => {
    try {
      setDismissed(sessionStorage.getItem(KEY));
    } catch {}
  }, []);

  const match = closestProfile(prefs);
  if (!match || match.profile.recommends === mode || dismissed === match.profile.id) return null;
  const view = match.profile.recommends === "simple" ? "Simple view" : "Detailed view";
  const notNow = () => {
    setDismissed(match.profile.id);
    try {
      sessionStorage.setItem(KEY, match.profile.id);
    } catch {}
  };

  return (
    <section aria-labelledby="similar-h" className="hairline flex flex-col gap-3 rounded-xl bg-card p-(--space)">
      <p className="inline-flex w-fit items-center gap-1.5 rounded-full bg-accent px-2.5 py-0.5 text-xs font-bold text-accent-foreground">
        <Sparkles aria-hidden className="size-[1em]" />
        Similar user insights
      </p>
      <h2 id="similar-h" className="text-xl font-bold leading-tight">
        Based on users with similar preferences, you may prefer {view}.
      </h2>
      <p className="text-lg leading-snug">{match.profile.reason}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" className="min-h-(--target-min) px-4 font-bold" onClick={() => setMode(match.profile.recommends)}>
          Try {view}
        </Button>
        <Button size="lg" variant="outline" className="min-h-(--target-min) px-4" onClick={notNow}>
          Not now
        </Button>
        <Button size="lg" variant="ghost" className="min-h-(--target-min) px-4 underline underline-offset-4" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          Why am I seeing this?
        </Button>
      </div>
      {why && (
        <div className="flex flex-col gap-2 rounded-lg bg-accent p-(--space) text-accent-foreground">
          <p className="font-bold">
            Closest match: {match.profile.label} ({match.similarity}% similar)
          </p>
          <p>{match.profile.summary}</p>
          <ul className="list-disc pl-5">
            {match.profile.traits.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {match.matched.length > 0 && <p>You chose {match.matched.map((s) => SIGNAL_LABEL[s]).join(", ")}, as people in this group usually do.</p>}
          <p className="text-sm">
            Demo: the sample profiles are synthetic, not real customers. The match is a simple similarity score of your own display settings on this
            device, not a trained model, and nothing is sent anywhere.
          </p>
        </div>
      )}
    </section>
  );
}
