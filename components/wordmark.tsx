import Link from "next/link";

/** Text wordmark with a small dial knob. The needle points left in Simple and right in Complex (CSS in globals.css). */
export function Wordmark() {
  return (
    <Link href="/account" className="inline-flex min-h-(--target-min) items-center gap-2 rounded-md text-lg font-bold">
      <svg viewBox="0 0 24 24" aria-hidden className="size-[1.2em]">
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <line className="dial-needle" x1="12" y1="12" x2="12" y2="5" stroke="var(--primary)" strokeWidth="3.5" strokeLinecap="round" />
      </svg>
      Dial<span className="sr-only">, home</span>
    </Link>
  );
}
