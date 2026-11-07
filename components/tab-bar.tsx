"use client";

import { CreditCard, House, PauseCircle, ReceiptText } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/account", label: "Home", Icon: House },
  { href: "/account/spending", label: "Spending", Icon: ReceiptText },
  { href: "/account/pay", label: "Pay", Icon: CreditCard },
  { href: "/account/spend-pause", label: "Pause", Icon: PauseCircle },
];

export function TabBar() {
  const path = usePathname();
  if (!path.startsWith("/account")) return null; // no tabs before sign-in

  return (
    // Sticky only on screens tall enough; at 400% zoom it scrolls with the page instead of covering it.
    <nav aria-label="Main" className="gutter z-40 border-t-2 bg-card pb-[env(safe-area-inset-bottom)] [@media(min-height:480px)]:sticky [@media(min-height:480px)]:bottom-0">
      <ul className="grid grid-cols-4">
        {TABS.map(({ href, label, Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={path === href ? "page" : undefined}
              className="group relative flex min-h-(--target-min) flex-col items-center justify-center gap-0.5 py-1 text-sm before:absolute before:top-0 before:h-1 before:w-10 before:rounded-b-full aria-[current=page]:font-bold aria-[current=page]:before:bg-foreground"
            >
              <Icon aria-hidden className="size-[1.4em] group-aria-[current=page]:stroke-[2.75]" />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
