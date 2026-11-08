"use client";

import { ChevronRight, GraduationCap, LayoutGrid, RotateCcw, SlidersHorizontal, Sparkles, Target, UserRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePreferences } from "@/lib/preferences/provider";

/** Every screen the phone tab bar has no room for. The desktop side rail lists the same ones. */
export function useMoreLinks() {
  const { prefs } = usePreferences();
  return [
    { href: "/account/goals", label: "Goals", hint: "Track spending, debt and saving goals", Icon: Target },
    ...(prefs.learning === "on" ? [{ href: "/account/learn", label: "Learning Lab", hint: "Calculators, explainers and a quiz", Icon: GraduationCap }] : []),
    { href: "/account/settings", label: "Display and voice", hint: "Text size, contrast, Home sections, charts", Icon: SlidersHorizontal },
    { href: "/account/personalise", label: "Make it yours", hint: "Get a suggested style, preview it first", Icon: Sparkles },
    { href: "/account/about-you", label: "About you", hint: "Tell us what would help, so the app and Dial suit you", Icon: UserRound },
  ];
}

/** Phone header button. Hidden from 1024px, where the side rail shows the same links. */
export function MoreButton() {
  const path = usePathname();
  if (!path.startsWith("/account")) return null;
  return (
    <Link
      href="/account/more"
      aria-current={path === "/account/more" ? "page" : undefined}
      className="hairline inline-flex min-h-(--target-min) items-center gap-1.5 rounded-full bg-card px-[0.9em] text-sm font-bold aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground lg:hidden"
    >
      <LayoutGrid aria-hidden className="size-[1.1em]" />
      More
    </Link>
  );
}

export function MoreScreen() {
  const links = useMoreLinks();
  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold tracking-tight">More</h1>
      <ul className="flex flex-col gap-2">
        {links.map(({ href, label, hint, Icon }) => (
          <li key={href}>
            <Link href={href} className="elevated flex min-h-(--target-min) items-center gap-3 rounded-xl bg-card p-(--space)">
              <Icon aria-hidden className="size-[1.4em] shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block font-bold">{label}</span>
                <span className="block text-sm text-muted-foreground">{hint}</span>
              </span>
              <ChevronRight aria-hidden className="size-[1.2em] shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
      <section aria-labelledby="more-demo" className="hairline flex flex-col gap-2 rounded-xl p-(--space)">
        <h2 id="more-demo" className="font-bold">
          Demo account
        </h2>
        <p className="text-muted-foreground">Everything here is made-up demo data for one fictional card. Starting again clears your payments, goals and display choices on this device.</p>
        {/* A form, not a link: a link could be prefetched, and prefetching must never reset anything. */}
        <form action="/demo/reset" method="post">
          <button type="submit" className="inline-flex min-h-(--target-min) items-center gap-2 font-bold text-primary underline underline-offset-4">
            <RotateCcw aria-hidden className="size-[1em]" />
            Start the demo again
          </button>
        </form>
        <Link href="/demo/users" className="inline-flex min-h-(--target-min) items-center gap-2 font-bold text-primary underline underline-offset-4">
          <UserRound aria-hidden className="size-[1em]" />
          Try a synthetic demo user
        </Link>
      </section>
    </div>
  );
}
