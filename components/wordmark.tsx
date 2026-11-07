import Link from "next/link";

/** The Dial mark: a dial with a red needle (it turns with the view). Original artwork, not a Capital One mark. */
export function DialMark({ className = "size-[1.6em]", tone = "brand" }: { className?: string; tone?: "brand" | "onDark" }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <circle cx="16" cy="16" r="15" fill={tone === "brand" ? "var(--primary)" : "#004977"} />
      <circle cx="16" cy="16" r="9.5" stroke={tone === "brand" ? "var(--primary-foreground)" : "#ffffff"} strokeWidth="2.4" fill="none" />
      <line className="dial-needle" x1="16" y1="16" x2="10" y2="10" stroke="var(--signal)" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.2" fill={tone === "brand" ? "var(--primary-foreground)" : "#ffffff"} />
    </svg>
  );
}

/** Product wordmark. "Dial" is only the assistant. */
export function Wordmark({ stacked = false }: { stacked?: boolean }) {
  return (
    <Link href="/account" className="inline-flex min-h-(--target-min) items-center gap-2 rounded-lg font-bold leading-[1.05] tracking-[-0.01em]">
      <DialMark />
      <span className="text-sm">
        {stacked ? (
          <>
            Capital for
            <br />
            Everyone
          </>
        ) : (
          "Capital for Everyone"
        )}
        <span className="sr-only">, home</span>
      </span>
    </Link>
  );
}
