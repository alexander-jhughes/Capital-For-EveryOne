// Turns what someone says into one allowlisted intent. Deterministic and local: no AI call, no network.
// Interface requests become validated UiActions; money questions are passed on to /api/ask unchanged.
import { stepTextSize, type TextSize, type UiAction, type WidgetId } from "../preferences/schema";
import type { Mode } from "../types";

export type Route = "/account" | "/account/spending" | "/account/pay" | "/account/spend-pause" | "/account/settings";

export type Interpretation =
  | { kind: "ui"; actions: UiAction[] }
  | { kind: "mode"; mode: Mode }
  | { kind: "navigate"; to: Route | "back" }
  | { kind: "control"; command: "yes" | "no" | "stop" | "undo" | "reset" | "exit" | "help" | "readPage" | "readBalance" | "save" }
  | { kind: "question"; text: string }
  | { kind: "unknown" };

const has = (s: string, re: RegExp) => re.test(s);

/** Lower case, plain words, padded with a space at each end so every pattern can use " word " boundaries. */
export const normaliseUtterance = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\bactually\b/g, " ") // "what did I actually spend" asks the same thing as "what did I spend"
    .replace(/\s+/g, " ")
    .trim()} `;

/** Words that make "reset" or "help" about money or a goal, not about the app. */
const ABOUT_MONEY = / (budget|goal|goals|spend pause|payment|payments|bill|card|spending|save|saving) /;

/** "Stop reading long explanations" is about how Dial answers: a setting, not a stop. */
const NO_LONG_ANSWERS = / (stop|no more|skip|without) ([a-z]+ ){0,3}long (answers?|explanations?|replies|responses) /;

/** Short replies only: "no" inside a longer sentence is not a "no". */
function control(s: string, words: number): Interpretation | null {
  const short = words <= 5;
  if ((has(s, / (stop (talking|speaking|reading)|be quiet|quiet please|shush|stop it) /) && !has(s, NO_LONG_ANSWERS)) || (words <= 2 && has(s, / stop /))) return { kind: "control", command: "stop" };
  if (short && has(s, / (undo|undo that|put it back|change it back|go back to how it was|revert) /)) return { kind: "control", command: "undo" };
  // "Reset my budget" is about Spend Pause, not the look of the app.
  if ((has(s, / (reset|start again|default (look|settings)|original look) /) && !has(s, ABOUT_MONEY)) || has(s, / (everything|it all|all of it|it) back to (normal|default|the default|how it was) /) || has(s, /^ (go )?back to normal $/))
    return { kind: "control", command: "reset" };
  if (short && has(s, / (save it|save (that|this|them|my settings)|remember (that|this|it)|keep it for next time) /)) return { kind: "control", command: "save" };
  if (short && has(s, / (exit|close|leave( voice)?|goodbye|bye|that's all|i'm done|finish) /)) return { kind: "control", command: "exit" };
  // "Help" on its own, not "help me stay within my budget", which is a request in its own right.
  if ((words <= 3 && has(s, / help /) && !has(s, ABOUT_MONEY)) || has(s, / (what can i say|what can you do|what can dial do|how does this work|what can i ask|who are you|what are you|are you (an? )?(ai|bot|robot|human|real|chatbot|assistant)|are you chat ?gpt|what is dial|what's dial|what does dial do|introduce yourself) /))
    return { kind: "control", command: "help" };
  if (has(s, / read [a-z ]*(aloud|out loud) /) || has(s, /^ (please )?(can you )?read (this|the page|the screen|everything|it|all of it|this page)( to me)?( please)? $/))
    return { kind: "control", command: "readPage" };
  if (has(s, / (read|tell me|say) (out )?my balance /)) return { kind: "control", command: "readBalance" };
  if (short && has(s, /^ (yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|keep it|sounds good|that's good|that's better|perfect|great|lovely)( please| thanks| thank you)? $/))
    return { kind: "control", command: "yes" };
  if (short && has(s, /^ (no|nope|not now|no thanks|no thank you|don't|cancel|never mind|leave it)( thanks| thank you)? $/)) return { kind: "control", command: "no" };
  return null;
}

/** "More detail in your answers" is about how Dial answers (answerStyle), not Detailed view. */
const ABOUT_ANSWERS = / (answers?|replies|responses|explanations?) /;

function mode(s: string): Interpretation | null {
  if (has(s, / (simple (view|mode|version)|switch to simple|go simple) /)) return { kind: "mode", mode: "simple" };
  if (has(s, / (detailed (view|mode|version)|switch to detailed) /)) return { kind: "mode", mode: "complex" };
  if (!has(s, ABOUT_ANSWERS) && has(s, / ((show|give) me (more|all the|the full) (detail|details|information|info)|more detail|everything in detail) /))
    return { kind: "mode", mode: "complex" };
  return null;
}

const PAGES: [RegExp, Route][] = [
  [/ (settings|display( settings)?|preferences|accessibility settings) /, "/account/settings"],
  [/ (spend pause|pause page) /, "/account/spend-pause"],
  [/ (payments?|pay|pay page|paying) /, "/account/pay"],
  [/ (spending|transactions|spending page) /, "/account/spending"],
  [/ (home|home page|start|dashboard|main page) /, "/account"],
];

/** Placement and visibility words mean "change the layout", not "go to a page". */
const PLACE = / (top|first|before anything|before everything|up front|front|higher|more visible|more prominent|prominent|stand out|bigger on the screen|easier to (find|see|spot)|struggle|can't find|cannot find|hard to find|find out|where is|miss|missing|notice) /;
const HIDE = / (hide|remove|get rid of|take away|take off|don't (need|want|care about)|do not (need|want)|turn off|no longer need) /;
const SHOW = / (show|bring back|add|display|i want to see|i'd like to see|put back) /;

function navigate(s: string): Interpretation | null {
  if (has(s, /^ (please )?(go back|back|previous page|the previous page|previous screen|take me back|go back a page|back a page|go to the previous (page|screen)|last page)( please)? $/))
    return { kind: "navigate", to: "back" };
  if (has(s, PLACE) || has(s, HIDE)) return null;
  // "Go back to the dashboard" is a place, not the browser's back button.
  if (!has(s, / (go to|go back to|take me|open|navigate to|show me the|switch to|bring up|i want to go to|let me see the) /) && !has(s, /^ (home|settings|payments|spending) $/)) return null;
  for (const [re, to] of PAGES) if (has(s, re)) return { kind: "navigate", to };
  return null;
}

/** The part of the screen someone is talking about. Order matters: "spending chart" is the chart. */
function widget(s: string): WidgetId | null {
  if (has(s, / (chart|graph|daily spending|bar chart) /)) return "chart";
  if (has(s, / (spend pause|pause) /)) return "pause";
  if (has(s, / (insight|insights|dial noticed|alert|alerts|warning|warnings|duplicate|unusual|things to check) /)) return "insights";
  if (has(s, / (transaction|transactions|recent|activity|purchases|what i bought) /)) return "recent";
  if (has(s, / (budget) /)) return "budget";
  if (has(s, / (bill|payment|payments|due date|due|pay by|next payment|statement|minimum|deadline|upcoming) /)) return "bill";
  if (has(s, / (balance|credit|owe|limit|available) /)) return "balance";
  if (has(s, / (spending|spend|spent|money going|where my money goes) /)) return "budget";
  return null;
}

function ui(s: string, textSize: TextSize): UiAction[] {
  const actions: UiAction[] = [];
  const target = widget(s);
  const aboutButtons = has(s, / (button|buttons|tap|taps|press|click|targets?|controls|links) /);

  if (aboutButtons && has(s, / (bigger|larger|easier|hard|harder|difficult|miss|missing|fiddly|small|tiny) /)) actions.push({ type: "targets", value: "large" });
  else if (has(s, / (smaller|shrink|too big|too large|zoom out|less big) /)) actions.push({ type: "textSize", value: stepTextSize(textSize, -1) });
  else if (!target && has(s, / (bigger|larger|enlarge|increase|zoom in|magnify|can't read|cannot read|hard to read|too small|tiny|squint|bigger text|larger text|text size) /))
    actions.push({ type: "textSize", value: stepTextSize(textSize, 1) });

  if (has(s, / (less contrast|normal contrast|standard contrast|lower contrast) /)) actions.push({ type: "contrast", value: "standard" });
  else if (has(s, / (contrast|stronger colou?rs?|bolder colou?rs?|hard to see|washed out|faded|can't see|cannot see|too pale|pale|clearer colou?rs?) /))
    actions.push({ type: "contrast", value: "high" });

  if (has(s, / (dark|darker|night|dim|too bright|glare|hurts my eyes) /)) actions.push({ type: "theme", value: "dark" });
  else if (has(s, / (light (mode|theme|interface|background)|lighter|brighter|white background) /)) actions.push({ type: "theme", value: "light" });
  else if (has(s, / (follow my (phone|device)|match my (phone|device)|automatic theme) /)) actions.push({ type: "theme", value: "system" });

  if (has(s, / (space|spacing|spaced|cramped|crowded|squashed|squeezed|breathing room|spread|too close together) /) && !has(s, / spend pause /))
    actions.push({ type: "spacing", value: "roomy" });

  if (has(s, / (animation|animations|motion|moving|movement|dizzy|distracting|sliding|jumping) /)) actions.push({ type: "motion", value: "reduced" });

  if (has(s, / (step by step|one step at a time|in steps|walk me through|break it down) /)) actions.push({ type: "explanations", value: "stepByStep" });
  // "Make this easier to understand": plainer explanations and less on screen, with everything still a tap away.
  const easier = has(s, / (easier to (understand|follow)|hard to (understand|follow)|plain english|plainer|simpler words|too complicated|too complex) /) && !has(s, ABOUT_MONEY);
  if (easier && !actions.some((a) => a.type === "explanations")) actions.push({ type: "explanations", value: "stepByStep" });
  // Fewer numbers means shorter answers (the key figure first) and a calmer home screen.
  const fewerNumbers = has(s, / (fewer|less|not so many|not as many|too many) (numbers|figures|digits) /);
  if (fewerNumbers || has(s, NO_LONG_ANSWERS) || has(s, / (shorter|brief|briefer|short|quicker|concise) (answers?|explanations?|replies|responses)|keep (it|things|them|answers|your answers|my answers|explanations|your explanations) (short|shorter|brief)|be (brief|briefer|concise|quicker)|fewer words|less detail in (your |the |my )?(answers|replies|explanations)|less wordy|too wordy|too long winded|get to the point /))
    actions.push({ type: "answerStyle", value: "brief" });
  else if (has(s, / ((longer|fuller|full|more detailed|normal|standard) (answers|explanations|replies)|more detail in (your |the |my )?(answers|explanations|replies)) /))
    actions.push({ type: "answerStyle", value: "standard" });
  // How the microphone listens. Each still previews first and needs "Keep it", like every other setting.
  if (has(s, / (keep listening|listen continuously|keep the (mic|microphone) on|hands free) /)) actions.push({ type: "listenMode", value: "continuous" });
  else if (has(s, / (push to talk|hold to talk|listen (only )?while i hold) /)) actions.push({ type: "listenMode", value: "hold" });
  else if (has(s, / (one question at a time|tap to talk|listen once|stop listening automatically) /)) actions.push({ type: "listenMode", value: "tap" });
  if (has(s, / (rather talk|prefer talking|prefer to talk|talk instead|voice first|use my voice|speak instead|talking first) /)) actions.push({ type: "voiceFirst", value: true });
  else if (has(s, / (rather tap|prefer tapping|tapping first|stop voice first) /)) actions.push({ type: "voiceFirst", value: false });

  if ((!target && has(s, / (too much|overwhelm|overwhelming|overwhelmed|busy|clutter|cluttered|less information|less info|less on (the|my) screen|simpler|simplify|calmer|going on|confusing|confused|a lot) /)) || fewerNumbers || easier)
    actions.push({ type: "density", value: "calm" });
  else if (has(s, / (show everything|all the sections|everything back|full dashboard) /)) actions.push({ type: "density", value: "standard" });

  if (target) {
    if (has(s, HIDE)) actions.push({ type: "hide", widget: target });
    else if (has(s, PLACE)) {
      actions.push({ type: "moveToTop", widget: target });
      if (has(s, / (visible|prominent|stand out|easier|struggle|can't find|cannot find|hard to find|find out|notice|miss|bigger) /)) actions.push({ type: "emphasize", widget: target });
    } else if (has(s, SHOW) && !isQuestion(s)) actions.push({ type: "show", widget: target });
  }
  return actions;
}

const isQuestion = (s: string) =>
  has(s, /^ (how|what|what's|whats|when|when's|did|do|does|is|are|was|were|have|has|had|can i|could i|which|why|where|who|will|am i|tell me) /);

/** True for a question, in the sense the planner needs: question words first, a question mark, or "explain". */
export function isQuestionText(text: string): boolean {
  const s = normaliseUtterance(text);
  return isQuestion(s) || text.trim().endsWith("?") || has(s, /^ (explain|tell me|help me understand|show me why|i want to know|i'd like to know|do you know|can you tell me|could you tell me) /);
}

/** Interprets one utterance. `textSize` lets "bigger" and "smaller" step from the current size. */
export function interpret(utterance: string, ctx: { textSize: TextSize } = { textSize: 100 }): Interpretation {
  const s = normaliseUtterance(utterance);
  const words = s.trim() ? s.trim().split(" ").length : 0;
  if (words === 0) return { kind: "unknown" };

  const c = control(s, words);
  if (c) return c;
  const m = mode(s);
  if (m) return m;
  const n = navigate(s);
  if (n) return n;
  const actions = ui(s, ctx.textSize);
  if (actions.length > 0) return { kind: "ui", actions };
  if (isQuestion(s) || utterance.trim().endsWith("?") || has(s, / (spend|spent|owe|bill|refund|charged|payment|balance|subscription|tesco|amazon|netflix) /))
    return { kind: "question", text: utterance.trim() };
  return { kind: "unknown" };
}
