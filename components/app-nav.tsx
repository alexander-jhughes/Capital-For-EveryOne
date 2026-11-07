"use client";

import { ChartColumn, CreditCard, House, PauseCircle, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePreferences } from "@/lib/preferences/provider";
import { useAskDial } from "./assistant/ask-dial";
import { DialMark, Wordmark } from "./wordmark";

const LINKS = [
  { href: "/account", label: "Home", Icon: House },
  { href: "/account/spending", label: "Spending", Icon: ChartColumn },
  { href: "/account/pay", label: "Pay", Icon: CreditCard },
  { href: "/account/spend-pause", label: "Pause", long: "Spend Pause", Icon: PauseCircle },
];

const tab =
  "group relative flex min-h-(--target-min) flex-col items-center justify-end gap-1 pt-2 text-sm aria-[current=page]:font-bold aria-[current=page]:text-primary " +
  "lg:flex-row lg:justify-start lg:gap-3 lg:rounded-xl lg:px-3 lg:pt-0 lg:text-base lg:aria-[current=page]:bg-accent lg:aria-[current=page]:text-accent-foreground";

/**
 * One navigation landmark: a bottom tab bar on phones (Dial raised in the middle), a side rail from 1024px.
 * Sticky only on screens tall enough; at 400% zoom it scrolls with the page instead of covering it.
 */
export function AppNav() {
  const path = usePathname();
  const { openAsk, openVoice } = useAskDial();
  const { prefs } = usePreferences();
  if (!path.startsWith("/account")) return null;

  const link = ({ href, label, long, Icon }: (typeof LINKS)[number] & { long?: string }) => (
    <li key={href}>
      <Link href={href} aria-current={path === href ? "page" : undefined} className={tab}>
        <span aria-hidden className="absolute top-0 h-1 w-8 rounded-b-full group-aria-[current=page]:bg-primary lg:hidden" />
        <Icon aria-hidden className="size-[1.35em] shrink-0 group-aria-[current=page]:stroke-[2.6]" />
        {/* Phone tab bar has fixed width: labels follow text size up to what fits five across. */}
        <span className="text-[clamp(13px,3.9vw,var(--text-sm))] leading-tight lg:hidden">{label}</span>
        <span className="hidden lg:inline">{long ?? label}</span>
      </Link>
    </li>
  );

  return (
    <nav
      aria-label="Main"
      className="z-40 bg-card px-1 pb-[env(safe-area-inset-bottom)] lg:px-5 shadow-[0_-1px_0_var(--border)] [@media(min-height:480px)]:sticky [@media(min-height:480px)]:bottom-0 lg:order-first lg:flex lg:h-dvh lg:w-64 lg:shrink-0 lg:flex-col lg:p-5 lg:shadow-[1px_0_0_var(--border)] lg:[@media(min-height:480px)]:top-0"
    >
      <div className="mb-6 hidden lg:block">
        <Wordmark />
      </div>
      <ul className="grid grid-cols-5 items-end lg:flex lg:flex-col lg:items-stretch lg:gap-1">
        {LINKS.slice(0, 2).map(link)}
        <li className="lg:order-last lg:mt-5">
          <button
            type="button"
            onClick={() => (prefs.voiceFirst ? openVoice() : openAsk())}
            aria-label={prefs.voiceFirst ? "Talk to Dial" : undefined}
            aria-haspopup="dialog"
            className="flex min-h-(--target-min) w-full flex-col items-center justify-end gap-1 text-sm font-bold lg:flex-row lg:justify-center lg:gap-2 lg:rounded-xl lg:bg-primary lg:text-base lg:text-primary-foreground"
          >
            <span className="elevated -mt-6 flex size-(--target-min) items-center justify-center rounded-full bg-primary lg:mt-0 lg:size-auto lg:bg-transparent lg:shadow-none">
              <DialMark className="size-[1.75em] lg:size-[1.4em]" />
            </span>
            <span className="text-[clamp(13px,3.9vw,var(--text-sm))] leading-tight lg:text-base">
              Dial<span className="hidden lg:inline">: ask or talk</span>
            </span>
          </button>
        </li>
        {LINKS.slice(2).map(link)}
        <li className="hidden lg:block">
          <Link href="/account/settings" aria-current={path === "/account/settings" ? "page" : undefined} className={tab}>
            <SlidersHorizontal aria-hidden className="size-[1.35em] shrink-0" />
            Display and voice
          </Link>
        </li>
      </ul>
      <p className="mt-auto hidden pt-6 text-sm text-muted-foreground lg:block">
        Independent hackathon concept. Not an official Capital One product.
      </p>
    </nav>
  );
}
