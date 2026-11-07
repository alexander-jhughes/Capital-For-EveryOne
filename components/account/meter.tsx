/** A labelled bar. The visible text (from lib/finance) carries the figures; the bar width is decoration. */
export function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const percent = max > 0 ? Math.min(Math.max(Math.round((value * 100) / max), 0), 100) : 0;
  return (
    <div>
      <p className="pb-1 text-sm tabular-nums">{text}</p>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={text}
        className="h-3 overflow-hidden rounded-full border border-input bg-muted"
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
