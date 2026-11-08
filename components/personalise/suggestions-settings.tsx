"use client";

import { Download, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { useAnnounce } from "@/components/live-region";
import type { ConsentState } from "@/lib/personalisation/client";
import { usePersonalisation } from "@/lib/personalisation/provider";
import { QUESTIONS } from "@/lib/recommender/profile";

const pill = "inline-flex min-h-(--target-min) max-w-full items-center justify-center gap-2 rounded-[1.4em] px-[1em] text-left font-bold";

/** An Off/On choice styled like the other Display and voice settings. */
function OnOff({ legend, hint, on, disabled, onChange }: { legend: string; hint: React.ReactNode; on: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
      <legend className="text-lg font-bold">{legend}</legend>
      <div className="-mt-1 text-muted-foreground">{hint}</div>
      <div className="hairline flex max-w-full flex-wrap gap-1 self-start rounded-[1.6em] bg-card p-1">
        {(["off", "on"] as const).map((v) => (
          <label
            key={v}
            className="inline-flex min-h-(--target-min) min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-[1.4em] px-[0.75em] font-bold has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring has-[:disabled]:cursor-not-allowed"
          >
            <input type="radio" name={name} checked={on === (v === "on")} onChange={() => onChange(v === "on")} className="sr-only" />
            {v === "on" ? "On" : "Off"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** "Suggestions from Dial" in Display and voice: the three separate consents, and the person's data controls. */
export function SuggestionsSettings() {
  const ml = usePersonalisation();
  const announce = useAnnounce();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { consent } = ml.status;

  const change = async (c: Partial<ConsentState>, done: string) => {
    setBusy(true);
    const ok = await ml.setConsent(c);
    setBusy(false);
    announce(ok ? done : "That didn't work. Nothing was changed. Please try again.");
  };

  const download = async () => {
    const data = await ml.exportData();
    if (data === null) return announce("Your data couldn't be downloaded right now. Please try again.");
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "dial-suggestions-data.json" });
    a.click();
    URL.revokeObjectURL(url);
    announce("Your data has been downloaded.");
  };

  return (
    <section id="suggestions" aria-labelledby="s-ml" className="elevated flex scroll-mt-4 flex-col gap-4 rounded-xl bg-card p-(--space)">
      <div className="flex flex-col gap-2">
        <h2 id="s-ml" className="text-lg font-bold">
          Suggestions from Dial
        </h2>
        <p className="text-muted-foreground">
          Dial can suggest a few display changes that tend to make the app easier for people with similar answers, like larger text or a calmer home screen. It
          uses only the optional answers you give, your display settings and the display changes you keep. It never uses your spending, transactions or account,
          or what you say to Dial. A suggestion never changes anything until you preview it and choose Keep it.
        </p>
        <p className="text-muted-foreground">
          Suggestions come from a model trained on made-up practice data. It hasn&apos;t been tested with real people yet. Your display settings always win: Dial
          never suggests changing something you set yourself.
        </p>
        {ml.replacedV1 && !consent.personalisation && (
          <p role="status" className="font-bold">
            Suggestions have been upgraded and now save your answers on Dial&apos;s server, so they need your permission again.
          </p>
        )}
      </div>

      {!ml.loaded ? (
        <p role="status">Checking suggestions…</p>
      ) : !ml.status.available ? (
        <p role="status">Suggestions aren&apos;t available right now. Everything else works as usual.</p>
      ) : (
        <>
          <OnOff
            legend="Suggestions"
            disabled={busy}
            on={consent.personalisation}
            hint={
              <p>
                On: Dial saves your answers, display settings and how you answer its suggestions, under a random ID that isn&apos;t linked to your name or
                account. Off: everything saved is deleted. Your display settings on this device stay as they are.
              </p>
            }
            onChange={(on) => void change({ personalisation: on }, on ? "Suggestions on." : "Suggestions off. Everything Dial had saved for them is deleted.")}
          />

          {consent.personalisation && (
            <>
              <div className="flex flex-col gap-1">
                <Link href="/account/personalise/about-you" className={`${pill} self-start bg-accent text-accent-foreground`}>
                  <UserRound aria-hidden className="size-[1em]" />
                  {ml.status.profile?.answered ? "Change your answers about you" : "Answer a few questions about you"}
                </Link>
                <p className="text-sm text-muted-foreground">
                  Optional. {ml.status.profile?.answered ?? 0} of {QUESTIONS.length} answered. Without answers, Dial suggests only when it has enough to go on.
                </p>
              </div>

              <OnOff
                legend="Help improve suggestions for others"
                disabled={busy}
                on={consent.collaborative}
                hint={
                  <p>
                    Off unless you turn it on. On: how you answer suggestions can be used, without your ID, when Dial&apos;s model is retrained, so suggestions get
                    better for people with similar answers. Turning it off leaves you out of all future training.
                  </p>
                }
                onChange={(on) => void change({ collaborative: on }, on ? "Thanks. Your answers can help improve suggestions." : "You're left out of future training.")}
              />

              <OnOff
                legend="Usability research"
                disabled={busy}
                on={consent.research}
                hint={
                  <p>
                    Off unless you turn it on. On: you can add an optional age band on the About you page. It is used only to check that suggestions work equally
                    well for different groups. It is never used to make suggestions. Turning it off deletes it.
                  </p>
                }
                onChange={(on) => void change({ research: on }, on ? "Usability research on." : "Usability research off. Your age band is deleted.")}
              />

              <div className="flex flex-col gap-2">
                <p className="font-bold">Your data</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void download()} className={`${pill} hairline bg-card`}>
                    <Download aria-hidden className="size-[1em]" />
                    Download my data
                  </button>
                  {confirmDelete ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">Delete everything saved for suggestions and turn them off?</span>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await ml.deleteEverything();
                          setConfirmDelete(false);
                          announce(ok ? "Deleted. Suggestions are off." : "That didn't work. Nothing was deleted. Please try again.");
                        }}
                        className={`${pill} bg-primary text-primary-foreground`}
                      >
                        Yes, delete
                      </button>
                      <button type="button" onClick={() => setConfirmDelete(false)} className={`${pill} hairline bg-card`}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(true)} className={`${pill} hairline bg-card`}>
                      <Trash2 aria-hidden className="size-[1em]" />
                      Delete my data
                    </button>
                  )}
                </div>
                {ml.status.model && (
                  <p className="text-sm text-muted-foreground">
                    Model {ml.status.model.version}
                    {ml.status.model.trainedOn === "synthetic" ? ", trained on made-up practice data only" : ""}.
                  </p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
