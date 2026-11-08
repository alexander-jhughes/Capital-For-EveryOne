// Asks instead of guessing. Two kinds of request get a question back rather than a change:
//   - a contradiction about one thing ("make the text bigger and smaller"), where any change would be a guess;
//   - a request too vague to act on ("make it better", "change it").
// Pure and deterministic, so it runs before the rules and the on-device model and costs nothing.
import { normaliseUtterance } from "../voice/interpret";

/** What Dial says when it can't tell what would help. Lists real options, so the next sentence is easy. */
export const WHAT_WOULD_HELP =
  "I can change how the app works for you. For example: bigger text, stronger contrast, a calmer home screen, bigger buttons, no animations, or talking instead of typing. What would help?";

const PAIRS: { a: RegExp; b: RegExp; ask: string }[] = [
  { a: / (bigger|larger|enlarge) /, b: / (smaller|shrink|tinier) /, ask: "Do you want it bigger or smaller?" },
  // Directions only: "it's too dark, make it lighter" describes the problem, then asks for one thing.
  { a: / (darker|dark (mode|theme|screen)) /, b: / (lighter|brighter|light (mode|theme|screen)) /, ask: "Would you like a dark screen or a light one?" },
  { a: / (more|stronger|higher) contrast /, b: / (less|softer|lower|normal) contrast /, ask: "Do you want stronger contrast or softer contrast?" },
  { a: / (more|bigger) (space|spacing) /, b: / (less|smaller) (space|spacing) /, ask: "Do you want more space between things, or less?" },
];

/** The things a display request can be about. Two different ones ("text bigger, buttons smaller") isn't a contradiction. */
const SUBJECTS = / (text|writing|words|font|buttons?|controls?|links?|chart|graph|screen|background|everything|it|this|app|numbers) /g;

/** Whole requests that name no change at all. Matched exactly, so "make it better for my eyes" is not vague. */
const VAGUE =
  /^ (please )?(can you |could you )?(make (it|this|the app|things) (better|nicer|work for me|easier)|change (it|this|the app|things)|fix (it|this|the app)|improve (it|this|the app)|adjust (it|this)|i don't like (it|this|the app)|it's not working for me|this isn't working for me|help me with the (screen|app|display)|can you change something)( please)? $/;

/** A question to ask instead of acting, or null when the request is clear enough for the rules and the model. */
export function clarify(text: string): string | null {
  const s = normaliseUtterance(text);
  if (VAGUE.test(s)) return WHAT_WOULD_HELP;
  const subjects = new Set(s.match(SUBJECTS)?.map((w) => w.trim().replace(/s$/, "")) ?? []);
  if (subjects.size > 1) return null;
  for (const p of PAIRS) if (p.a.test(s) && p.b.test(s)) return p.ask;
  return null;
}
