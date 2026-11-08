// Splits one utterance into separate instructions ("Show my groceries for October, then take me to settings").
//
// A split is only kept when every part is a complete request on its own. So "groceries and eating out" and
// "compare October and September" stay whole: "eating out" and "September" mean nothing alone. Pure.

/** Strong joins: "and then", "then", ", and", "and also", "also", and sentence ends. */
const STRONG = /(\s*,?\s+and then\s+|\s*,?\s+then\s+|\s*,\s*and also\s+|\s+and also\s+|\s*,\s*and\s+|\s*,?\s+also\s+|(?<=[.?!;])\s+)/i;
/** A plain "and" or a comma only joins two instructions when what follows starts like one ("..., take me to settings"). */
const AND_VERB =
  /((?:\s+and\s+|\s*,\s+)(?=(?:please\s+)?(?:take|go|open|show|switch|turn|make|use|set|put|hide|read|compare|navigate|bring|give|tell|move)\b))/i;

const clean = (s: string) => s.replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").replace(/^(?:and|then|also)\s+/i, "").trim();

/** Parts and the separators between them, so a part that has to be joined back gets its own words back. */
function pieces(text: string, re: RegExp): { parts: string[]; seps: string[] } {
  const tokens = text.split(re);
  const parts: string[] = [];
  const seps: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    parts.push(tokens[i]);
    if (i + 1 < tokens.length) seps.push(tokens[i + 1]);
  }
  return { parts, seps };
}

/**
 * Joins any part that isn't standalone back onto the part before it, then keeps the split only if every remaining
 * part is standalone. One join that doesn't work never stops the others.
 */
function settle(text: string, re: RegExp, standalone: (part: string) => boolean): string[] | null {
  const { parts, seps } = pieces(text, re);
  if (parts.length < 2) return null;
  const raw: string[] = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const p = clean(parts[i]);
    if (p && standalone(p) && clean(raw[raw.length - 1]) && standalone(clean(raw[raw.length - 1]))) raw.push(parts[i]);
    else raw[raw.length - 1] += seps[i - 1] + parts[i];
  }
  const out = raw.map(clean).filter(Boolean);
  return out.length > 1 && out.every(standalone) ? out : null;
}

/** The instructions in `text`, in order. `standalone` says whether a part plans to a known step on its own. */
export function segment(text: string, standalone: (part: string) => boolean): string[] {
  const whole = clean(text);
  if (!whole) return [];
  const strong = settle(whole, STRONG, standalone) ?? [whole];
  return strong.flatMap((part) => settle(part, AND_VERB, standalone) ?? [part]);
}
