// TEMP: throwaway preview of Complex mode. Delete before release.

import Link from "next/link"

import {
  ComplexScreen,
  ComplexScreenSkeleton,
} from "@/components/complex/ComplexScreen"
import {
  mockAccount,
  mockDuplicateIds,
  mockTransactions,
} from "@/components/complex/mock"

const VIEWS = [
  { href: "/dev/complex", label: "Default" },
  { href: "/dev/complex?view=highlight", label: "Highlight duplicates" },
  { href: "/dev/complex?view=loading", label: "Loading" },
  { href: "/dev/complex?view=none", label: "No transactions" },
]

export default async function ComplexPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const { view } = await searchParams

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-[var(--density,12px)] px-4 py-[var(--density,12px)]">
      <nav aria-label="Preview views">
        <ul className="flex flex-wrap gap-x-[var(--density,12px)] text-[length:calc(var(--text-base,16px)*0.875)]">
          {VIEWS.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                scroll={false}
                className="inline-flex min-h-[var(--target-min,44px)] items-center underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {view === "loading" ? (
        <ComplexScreenSkeleton />
      ) : (
        <ComplexScreen
          account={mockAccount}
          transactions={view === "none" ? [] : mockTransactions}
          highlightIds={view === "highlight" ? mockDuplicateIds : undefined}
        />
      )}
    </main>
  )
}
