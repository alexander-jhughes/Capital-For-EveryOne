// Plays an adaptation one change at a time, so the person sees each change land with its reason
// ("darker... stronger contrast... bigger text") instead of the whole screen snapping at once.
// Each step is a cross-fade through the View Transitions API where the browser has it, and a CSS colour/size
// transition otherwise. With reduced motion (the app's setting or the device's), everything appears at once.
import { flushSync } from "react-dom";

/** Time between changes. Matches the card's stagger (--reveal-gap in globals.css). */
export const REVEAL_GAP_MS = 750;

export const prefersReducedMotion = (appSetting: "system" | "reduced") =>
  appSetting === "reduced" || (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true);

type ViewTransitionDoc = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/** Runs `update` inside a view transition when available, so the old and new screens cross-fade. */
function transition(update: () => void) {
  const doc = document as ViewTransitionDoc;
  if (!doc.startViewTransition) return update();
  try {
    doc.startViewTransition(() => flushSync(update));
  } catch {
    update();
  }
}

/**
 * Shows steps 1, 1+2, 1+2+3... `show(n)` must render the first n changes. Returns a cancel function, which stops
 * the sequence where it is (the caller decides what to keep). Pure timing: no state of its own.
 */
export function reveal(count: number, show: (n: number) => void, opts: { reduced: boolean; gapMs?: number }): () => void {
  if (count <= 0) return () => {};
  if (opts.reduced || count === 1) {
    show(count);
    return () => {};
  }
  const gap = opts.gapMs ?? REVEAL_GAP_MS;
  const timers: ReturnType<typeof setTimeout>[] = [];
  document.documentElement.setAttribute("data-revealing", "true");
  for (let n = 1; n <= count; n++) {
    timers.push(
      setTimeout(() => {
        transition(() => show(n));
        if (n === count) document.documentElement.removeAttribute("data-revealing");
      }, (n - 1) * gap),
    );
  }
  return () => {
    timers.forEach(clearTimeout);
    document.documentElement.removeAttribute("data-revealing");
  };
}
