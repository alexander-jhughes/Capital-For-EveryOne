"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SEED_ACCOUNT } from "@/lib/data/seed";
import { ModeSwitch } from "./mode-switch";

const NAV = [
  { href: "/account", label: "Home" },
  { href: "/account/spending", label: "Spending" },
  { href: "/account/pay", label: "Pay" },
  { href: "/account/spend-pause", label: "Spend Pause" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="border-b-2 bg-card">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-(--space) px-4 py-3">
        <div>
          <Link href="/account" className="text-lg font-bold underline-offset-4 hover:underline">
            Capital For EveryOne
          </Link>
          <p className="text-sm text-muted-foreground">
            {SEED_ACCOUNT.holderName}, card ending {SEED_ACCOUNT.cardLast4}
          </p>
        </div>
        <ModeSwitch />
      </div>
      <nav aria-label="Main" className="mx-auto max-w-5xl px-4 pb-2">
        <ul className="flex flex-wrap gap-x-2 gap-y-1">
          {NAV.map((n) => {
            const current = path === n.href;
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  aria-current={current ? "page" : undefined}
                  className="inline-flex min-h-(--target-min) items-center rounded-md px-3 underline-offset-4 hover:underline aria-[current=page]:font-bold aria-[current=page]:underline aria-[current=page]:decoration-3"
                >
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
