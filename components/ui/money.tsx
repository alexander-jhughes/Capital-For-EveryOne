import { formatPence } from "@/lib/format";

/** A money figure with the pence set smaller, for large balances. Screen readers hear the whole amount once. */
export function Money({ pence }: { pence: number }) {
  const text = formatPence(pence);
  const dot = text.lastIndexOf(".");
  if (dot < 0) return <>{text}</>;
  return (
    <span>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {text.slice(0, dot)}
        <span className="text-[0.6em] tracking-normal">{text.slice(dot)}</span>
      </span>
    </span>
  );
}
