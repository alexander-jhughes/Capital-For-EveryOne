"use client";

// "About you": the person tells us what would help, if they want to. Follows the Money Advice Trust's TEXAS approach:
// Thank them, Explain why we ask and how it's used, get eXplicit consent (a second one for health), Ask only about
// what would help, and Signpost free help. Nothing is guessed about the person; the model only picks which of six
// ways of tailoring the app fits, and the person can see why and choose a different one.
import { Check, HeartHandshake, Info, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import { DRIVER_HEADINGS, DRIVERS, NEEDS, PERSON_TYPE_COPY, PERSON_TYPES, type NeedId, type PersonType } from "@/lib/profile/catalog";
import { useProfile } from "@/lib/profile/provider";
import { FreeHelp } from "./free-help";

const pill = "inline-flex min-h-(--target-min) items-center justify-center gap-2 rounded-full px-5 font-bold";
const box = "size-6 shrink-0 accent-[var(--primary)]";

function StyleSummary() {
  const { profile } = useProfile();
  const a = profile?.result?.adaptations;
  if (!a) return null;
  const words = [a.style.plain && "plain, everyday words", a.style.brief && "short answers", a.style.stepByStep && "one thing at a time", a.style.gentle && "a calm, unhurried tone"].filter(Boolean) as string[];
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5">
      <li>Home shows {a.cards.length ? "a few things picked for you near the top" : "its usual sections"}.</li>
      <li>Dial uses {words.length ? words.join(", ") : "its usual wording"}. Every figure is still checked against your account.</li>
      {a.signpost && <li>Answers about your bill mention where to get free, confidential money advice.</li>}
      <li>Dial&apos;s suggested questions match what you&apos;re likely to ask.</li>
    </ul>
  );
}

export function AboutYou() {
  const { profile, ready, save, remove } = useProfile();
  const announce = useAnnounce();
  const [needs, setNeeds] = useState<NeedId[]>([]);
  const [sensitive, setSensitive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const typeLegend = useId();

  useEffect(() => {
    if (!profile) return;
    setNeeds(profile.needs);
    setSensitive(profile.sensitiveConsent);
  }, [profile]);

  const run = async (work: () => Promise<string | null>, done: string) => {
    setBusy(true);
    const error = await work();
    setBusy(false);
    setMessage(error ?? done);
    announce(error ?? done);
  };

  if (!ready || !profile) return <p className="text-muted-foreground">Loading…</p>;
  const toggle = (id: NeedId) => setNeeds((n) => (n.includes(id) ? n.filter((x) => x !== id) : [...n, id]));
  const result = profile.result;

  return (
    <div className="flex flex-col gap-(--space)">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold tracking-tight">About you</h1>
        <p className="text-lg">Thank you for taking a look. Telling us a little about what would help means the app can put the right things first and Dial can talk to you the way you prefer.</p>
      </div>

      <section aria-labelledby="ay-why" className="hairline flex flex-col gap-2 rounded-xl bg-card p-(--space)">
        <h2 id="ay-why" className="flex items-center gap-2 font-bold">
          <Info aria-hidden className="size-[1.1em] text-primary" />
          How we use this
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>Only to change what you see first and how Dial words things.</li>
          <li>Never for your credit limit, interest, or any decision about your account. Dial still can&apos;t make payments or change Spend Pause.</li>
          <li>Kept on our server in a signed cookie for this demo, not in the browser. You can change or delete it at any time.</li>
          <li>Everything is optional. Tick only what you&apos;re happy to share.</li>
        </ul>
      </section>

      {!profile.consent ? (
        <section aria-labelledby="ay-consent" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
          <h2 id="ay-consent" className="text-lg font-bold">
            Tailor the app for me
          </h2>
          <p>Nothing about you is kept until you turn this on. Turning it off later deletes everything.</p>
          <button type="button" disabled={busy} onClick={() => run(() => save({ consent: true }), "Tailoring is on. Tell us anything that would help below.")} className={`${pill} self-start bg-primary text-primary-foreground`}>
            Turn on tailoring
          </button>
        </section>
      ) : (
        <>
          <form
            className="flex flex-col gap-(--space)"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => save({ needs, sensitiveConsent: sensitive }), "Saved. The app has been tailored to what you told us.");
            }}
          >
            {DRIVERS.map((driver) => (
              <fieldset key={driver} className="elevated flex min-w-0 flex-col gap-1 rounded-xl bg-card p-(--space)" disabled={driver === "health" && !sensitive}>
                <legend className="sr-only">{DRIVER_HEADINGS[driver].title}</legend>
                <p className="text-lg font-bold">{DRIVER_HEADINGS[driver].title}</p>
                <p className="pb-1 text-sm text-muted-foreground">{DRIVER_HEADINGS[driver].hint}</p>
                {driver === "health" && (
                  <label className="mb-2 flex min-h-(--target-min) cursor-pointer items-start gap-3 rounded-lg bg-accent p-3 text-accent-foreground">
                    <input
                      type="checkbox"
                      checked={sensitive}
                      onChange={(e) => {
                        setSensitive(e.target.checked);
                        if (!e.target.checked) setNeeds((n) => n.filter((id) => NEEDS.find((x) => x.id === id)?.driver !== "health"));
                      }}
                      className={`${box} mt-0.5`}
                    />
                    <span className="font-semibold">I agree to you keeping health information I choose to share, only to adjust how the app works for me. I can withdraw this at any time.</span>
                  </label>
                )}
                {NEEDS.filter((n) => n.driver === driver).map((n) => (
                  <label key={n.id} className="flex min-h-(--target-min) cursor-pointer items-center gap-3 border-b py-1 last:border-0">
                    <input type="checkbox" checked={needs.includes(n.id)} onChange={() => toggle(n.id)} className={box} />
                    <span className="font-semibold">{n.label}</span>
                  </label>
                ))}
              </fieldset>
            ))}
            <button type="submit" disabled={busy} className={`${pill} self-start bg-primary text-primary-foreground`}>
              <Check aria-hidden className="size-[1em]" />
              Save
            </button>
          </form>

          <section aria-labelledby="ay-result" className="elevated flex flex-col gap-3 rounded-xl bg-card p-(--space)">
            <h2 id="ay-result" className="text-lg font-bold">
              How the app is tailored
            </h2>
            {result?.type ? (
              <>
                <p className="text-xl font-bold leading-tight">{PERSON_TYPE_COPY[result.type].title}</p>
                <p className="text-lg">{PERSON_TYPE_COPY[result.type].summary}</p>
                {result.reasons.length > 0 && (
                  <div>
                    <p className="font-bold">{result.source === "chosen" ? "Why" : "Why Dial suggested this"}</p>
                    <ul className="list-disc pl-5">
                      {result.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {result.source === "model" && <p className="text-sm text-muted-foreground">Worked out by a small model from what you told us and how you use the app. If it doesn&apos;t sound like you, choose another below.</p>}
              </>
            ) : (
              <p className="text-lg">Dial isn&apos;t sure yet, so it isn&apos;t guessing. Tell us a little more above, or choose the one that sounds most like you.</p>
            )}
            <StyleSummary />

            <fieldset className="flex flex-col gap-1" aria-describedby={typeLegend}>
              <legend className="pb-1 font-bold">Which sounds most like you?</legend>
              <p id={typeLegend} className="pb-1 text-sm text-muted-foreground">
                Your choice always comes before Dial&apos;s suggestion.
              </p>
              {[null, ...PERSON_TYPES].map((t: PersonType | null) => (
                <label key={t ?? "auto"} className="flex min-h-(--target-min) cursor-pointer items-center gap-3 border-b py-1 last:border-0">
                  <input type="radio" name="person-type" checked={profile.chosen === t} disabled={busy} onChange={() => run(() => save({ chosen: t }), t ? `Saved: ${PERSON_TYPE_COPY[t].title}.` : "Saved. Dial will work it out.")} className={box} />
                  <span className="flex flex-col">
                    <span className="font-semibold">{t ? PERSON_TYPE_COPY[t].title : "Let Dial work it out"}</span>
                    {t && <span className="text-sm text-muted-foreground">{PERSON_TYPE_COPY[t].summary}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          </section>

          <section aria-labelledby="ay-delete" className="hairline flex flex-col gap-2 rounded-xl p-(--space)">
            <h2 id="ay-delete" className="font-bold">
              Stop tailoring
            </h2>
            <p>This deletes everything you told us and the usage counts. Your account and display settings aren&apos;t affected.</p>
            <button type="button" disabled={busy} onClick={() => run(remove, "Deleted. Nothing about you is kept.")} className={`${pill} hairline self-start bg-card`}>
              <Trash2 aria-hidden className="size-[1em]" />
              Delete everything about me
            </button>
          </section>
        </>
      )}

      {message && (
        <p role="status" className="rounded-xl bg-accent px-(--space) py-3 font-semibold text-accent-foreground">
          {message}
        </p>
      )}

      <section aria-labelledby="ay-help" className="hairline flex flex-col gap-2 rounded-xl bg-card p-(--space)">
        <h2 id="ay-help" className="flex items-center gap-2 font-bold">
          <HeartHandshake aria-hidden className="size-[1.1em] text-primary" />
          Free, confidential help
        </h2>
        <FreeHelp />
      </section>
    </div>
  );
}
