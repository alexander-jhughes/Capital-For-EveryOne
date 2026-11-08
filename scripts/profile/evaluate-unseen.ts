// Evaluates the profile model and Dial's help-request detector on cases written after training, and writes
// docs/profile-model/UNSEEN-EVALUATION.md with the actual results, wrong answers included.
//
// The profile model doesn't read free text: its inputs are what a person ticks on About you and their saved account
// behaviour. So each case below is a situation described in words AND encoded as those inputs by hand. The help
// detector does read free text (lib/ai/answer-style.ts), so its cases are raw phrasings.
//
// Usage: node --no-warnings --import ./scripts/personalisation/ts-resolve.mjs scripts/profile/evaluate-unseen.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isHelpRequest } from "../../lib/ai/answer-style";
import type { NeedId, PersonType } from "../../lib/profile/catalog";
import { emptyUsage, type ProfileInputs, type Usage } from "../../lib/profile/features";
import { inferProfile } from "../../lib/profile/infer";
import { checkModel } from "../../lib/profile/model-check";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const model = checkModel(JSON.parse(readFileSync(join(root, "lib", "profile", "model.json"), "utf8")));
if (!model) throw new Error("model.json doesn't match the code");

type Kind = "clear" | "ambiguous" | "conflicting";
/** `ok`: the answers that would be right. "ask" means the model should hold back (no type) and ask. */
interface Case {
  kind: Kind;
  situation: string;
  needs?: NeedId[];
  usage?: Partial<Usage>;
  utilisation?: number;
  payments?: ProfileInputs["payments"];
  goals?: string[];
  pause?: boolean;
  simple?: boolean;
  ok: (PersonType | "ask")[];
}

// The demo account uses 71% of its limit; most cases start there, as a real visitor would.
const CASES: Case[] = [
  // ---- Clear ----
  { kind: "clear", situation: "First card at university, reading the Learning Lab guides", needs: ["new_to_credit"], usage: { learn: 3 }, ok: ["building"] },
  { kind: "clear", situation: "Moved to the UK last year, building a credit history, English is a second language", needs: ["new_to_credit", "english"], ok: ["building"] },
  { kind: "clear", situation: "Pays the full bill and is saving for a house deposit", payments: [{ kind: "statement" }], goals: ["save_up"], usage: { detailed: 2 }, utilisation: 0.39, ok: ["steady"] },
  { kind: "clear", situation: "Pays in full and checks Detailed view, ticks nothing", payments: [{ kind: "statement" }], usage: { detailed: 2 }, utilisation: 0.39, ok: ["steady"] },
  { kind: "clear", situation: "Behind on council tax, paying only the minimum", needs: ["behind_bills"], payments: [{ kind: "minimum" }], ok: ["stretched"] },
  { kind: "clear", situation: "Income dropped and money is tight, paying the minimum", needs: ["income_change", "money_tight"], payments: [{ kind: "minimum" }], ok: ["stretched", "life_change"] },
  { kind: "clear", situation: "Partner died recently, sorting out the household money", needs: ["bereavement"], ok: ["life_change"] },
  { kind: "clear", situation: "Just had a baby and is now caring full time", needs: ["caring"], ok: ["life_change"] },
  { kind: "clear", situation: "Dyslexic, wants plain words, uses Simple view", needs: ["reading", "plain_words"], simple: true, ok: ["clear_simple"] },
  { kind: "clear", situation: "Not confident with apps, wants one thing at a time", needs: ["digital", "step_by_step"], ok: ["clear_simple"] },
  { kind: "clear", situation: "Spreadsheet planner: lots of what-if sums, category limits", usage: { whatIf: 6, detailed: 6, goals: 4 }, goals: ["category_cap"], ok: ["planner"] },
  { kind: "clear", situation: "Paying down the balance with a plan and checking progress", goals: ["pay_down"], usage: { whatIf: 3, detailed: 3, goals: 3 }, ok: ["planner"] },
  // ---- Ambiguous: too little to go on ----
  { kind: "ambiguous", situation: "Ticked nothing, opened Dial once", usage: { dial: 1 }, ok: ["ask"] },
  { kind: "ambiguous", situation: "Only asked for short answers", needs: ["short_answers"], ok: ["ask"] },
  { kind: "ambiguous", situation: "Only said they're not confident with numbers", needs: ["numbers"], ok: ["ask", "building", "clear_simple"] },
  { kind: "ambiguous", situation: "Looked at Detailed view twice, nothing else", usage: { detailed: 2 }, ok: ["ask", "planner", "steady"] },
  { kind: "ambiguous", situation: "Only said money makes them anxious", needs: ["money_anxiety"], ok: ["ask", "stretched", "life_change"] },
  { kind: "ambiguous", situation: "Turned Spend Pause on, nothing else", pause: true, ok: ["ask", "stretched"] },
  { kind: "ambiguous", situation: "Set a pay-on-time goal, nothing else", goals: ["pay_on_time"], ok: ["ask", "building"] },
  // ---- Conflicting: signals point different ways ----
  { kind: "conflicting", situation: "New to credit, but runs what-if sums and uses Detailed view a lot", needs: ["new_to_credit"], usage: { whatIf: 5, detailed: 5 }, ok: ["ask", "building", "planner"] },
  { kind: "conflicting", situation: "Pays the full bill, but says money is tight", needs: ["money_tight"], payments: [{ kind: "statement" }], utilisation: 0.39, ok: ["ask", "stretched", "steady"] },
  { kind: "conflicting", situation: "Recently bereaved, but pays in full and is saving", needs: ["bereavement"], payments: [{ kind: "statement" }], goals: ["save_up"], utilisation: 0.39, ok: ["ask", "life_change", "steady"] },
  { kind: "conflicting", situation: "Wants plain words one step at a time, but a heavy what-if user", needs: ["plain_words", "step_by_step"], usage: { whatIf: 5, detailed: 5 }, ok: ["ask", "clear_simple", "planner"] },
  { kind: "conflicting", situation: "Behind on bills, but has a savings goal", needs: ["behind_bills"], goals: ["save_up"], ok: ["ask", "stretched"] },
  { kind: "conflicting", situation: "New to credit and behind on bills", needs: ["new_to_credit", "behind_bills"], ok: ["ask", "building", "stretched"] },
  { kind: "conflicting", situation: "Ticked every box (with health consent)", needs: ["reading", "memory", "money_anxiety", "sight_hearing", "bereavement", "income_change", "caring", "relationship", "money_tight", "irregular_income", "behind_bills", "new_to_credit", "numbers", "english", "digital", "plain_words", "short_answers", "step_by_step"], ok: ["ask", "stretched", "life_change", "clear_simple"] },
];

// Help detector. `help`: true should get the free-advice answer; false must not. Written before running.
const HELP: [string, boolean][] = [
  ["I'm drowning in debt", true],
  ["How do I get debt advice?", true],
  ["I can't make this month's payment", true],
  ["I'm really worried I can't pay my card", true],
  ["Is there any free advice?", true],
  ["Who can help me with my debts?", true],
  ["I lost my job and can't pay", true],
  ["I'm in financial trouble", true],
  ["I need help with money", true],
  ["Money is really tight, what can I do?", true],
  ["Struggling to pay my bills", true],
  ["I'm behind on my credit card", true],
  ["Help, I've missed a payment", true],
  ["Is there a debt charity I can talk to?", true],
  ["I don't know how I'll pay this", true],
  ["I'm skint until payday", true],
  ["What is my minimum payment?", false],
  ["When is my bill due?", false],
  ["How much do I owe?", false],
  ["Pay my bill", false],
  ["How do I pay my bill?", false],
  ["Can you help me understand my statement?", false],
  ["Help me find my spending on eating out", false],
  ["Did I pay Tesco twice?", false],
  ["How much interest will I pay?", false],
  ["What did I spend on groceries?", false],
  ["Is my free trial still running?", false],
  ["Can I pay less than the minimum?", false],
];

// A second set, written before the detector was improved after the first run, and never used to tune it.
const HELP_HELDOUT: [string, boolean][] = [
  ["I'm struggling financially", true],
  ["I've got too much debt", true],
  ["My debts are getting on top of me", true],
  ["I can't afford to pay anything this month", true],
  ["Where do I go for money help?", true],
  ["I'm worried about paying my credit card", true],
  ["I'm stuck with my finances, can someone help?", true],
  ["I'm going to miss my payment", true],
  ["My hours were cut and I can't cope with my bills", true],
  ["Feeling overwhelmed by money", true],
  ["I'm broke", true],
  ["Can I talk to someone about my debt?", true],
  ["What's my balance?", false],
  ["Can I make a payment?", false],
  ["Help me change the text size", false],
  ["Which payment is due next?", false],
  ["How do I set a savings goal?", false],
  ["Can you help me with Spend Pause?", false],
  ["How much is my bill?", false],
  ["I paid my bill, did it go through?", false],
  ["Is there free delivery at Argos?", false],
  ["What's the cheapest way to pay?", false],
];

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const rows = CASES.map((c) => {
  const input: ProfileInputs = {
    utilisation: c.utilisation ?? 0.71,
    payments: c.payments ?? [],
    goalKinds: c.goals ?? [],
    spendPauseOn: c.pause ?? false,
    simpleView: c.simple ?? false,
    needs: c.needs ?? [],
    usage: { ...emptyUsage(), ...c.usage },
  };
  const r = inferProfile(model, input);
  const top = (Object.entries(r.probabilities) as [PersonType, number][]).sort((a, b) => b[1] - a[1]);
  const got = r.type ?? "ask";
  const st = r.adaptations.style;
  const wording = [st.plain && "plain", st.brief && "brief", st.stepByStep && "step by step", st.gentle && "calm", r.adaptations.signpost && "free-help signpost"].filter(Boolean).join(", ") || "usual";
  return { ...c, got, confidence: r.confidence, top: top[0][0], second: `${top[1][0]} ${top[1][1].toFixed(2)}`, right: c.ok.includes(got), wording };
});
const help = HELP.map(([q, want]) => ({ q, want, got: isHelpRequest(q) }));
const heldOut = HELP_HELDOUT.map(([q, want]) => ({ q, want, got: isHelpRequest(q) }));

const byKind = (k: Kind) => rows.filter((r) => r.kind === k);
const summary = (["clear", "ambiguous", "conflicting"] as Kind[]).map((k) => {
  const rs = byKind(k);
  return `| ${k} | ${rs.length} | ${rs.filter((r) => r.right).length} | ${rs.filter((r) => r.got === "ask").length} |`;
});
const helpTP = help.filter((h) => h.want && h.got).length;
const helpFN = help.filter((h) => h.want && !h.got);
const helpFP = help.filter((h) => !h.want && h.got);

let md = `# Profile model and help detector: unseen cases

Generated by \`scripts/profile/evaluate-unseen.ts\` against the committed model (\`${model.version}\`, threshold ${model.threshold}).
Every case was written for this evaluation, after training, and none were changed after seeing the results.

The profile model doesn't read free text. Each case is a situation in words, encoded by hand as the ticks and account
behaviour the model actually sees. "Ask" means the model held back (top probability below the threshold): no type is
shown and About you asks the person instead.

## Profile model

| Kind | Cases | Acceptable answer | Asked instead of guessing |
|---|---|---|---|
${summary.join("\n")}

"Dial wording" is what the person's own ticks do to Dial's answers whatever the type: a need they stated is always
honoured, even when the model picks a type that doesn't match it, or holds back.

| Kind | Situation | Acceptable | Got | Confidence | Runner-up | Right? | Dial wording |
|---|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.kind} | ${r.situation} | ${r.ok.join(", ")} | **${r.got}**${r.got === "ask" ? ` (leaning ${r.top})` : ""} | ${pct(r.confidence)} | ${r.second} | ${r.right ? "yes" : "**no**"} | ${r.wording} |`).join("\n")}

## Help-request detector (free text)

Questions that should get the fixed free-advice answer, and ones that must not.

**History, so these numbers aren't misread.** On its first run the detector caught only 6 of these 16 requests for
help (and 3 of 12 in the held-out set below, with no false alarms in either). It was then widened using this first
set's misses and general distress wording. So the first set now measures nothing: it was used for tuning. The
held-out set, written before the change and never used to tune it, is the fair measure. A false alarm is low-harm by
design: the fixed answer has no figures and only points to free advice. An independent code review then found false
alarms outside both sets ("I'm struggling to find my statement", "Why can't I make a payment?", "Why can't I pay with
Apple Pay?"). The patterns were narrowed, those questions became negative tests, and both sets were re-run: unchanged.

- Requests for help caught: ${helpTP} of ${help.filter((h) => h.want).length}
- Ordinary questions wrongly treated as requests for help: ${helpFP.length} of ${help.filter((h) => !h.want).length}

| Question | Should be help | Detected | Right? |
|---|---|---|---|
${help.map((h) => `| ${h.q} | ${h.want ? "yes" : "no"} | ${h.got ? "yes" : "no"} | ${h.want === h.got ? "yes" : "**no**"} |`).join("\n")}
`;

const heldTP = heldOut.filter((h) => h.want && h.got).length;
const heldFP = heldOut.filter((h) => !h.want && h.got);
md += `
### Held-out phrasings

Written before the detector was widened after its first run, and never used to tune it.

- Requests for help caught: ${heldTP} of ${heldOut.filter((h) => h.want).length}
- Ordinary questions wrongly treated as requests for help: ${heldFP.length} of ${heldOut.filter((h) => !h.want).length}

| Question | Should be help | Detected | Right? |
|---|---|---|---|
${heldOut.map((h) => `| ${h.q} | ${h.want ? "yes" : "no"} | ${h.got ? "yes" : "no"} | ${h.want === h.got ? "yes" : "**no**"} |`).join("\n")}
`;

writeFileSync(join(root, "docs", "profile-model", "UNSEEN-EVALUATION.md"), md);
console.log(summary.join("\n"));
console.log(`help: caught ${helpTP}/${help.filter((h) => h.want).length}, false alarms ${helpFP.length}`);
for (const r of rows.filter((r) => !r.right)) console.log(`WRONG ${r.kind}: ${r.situation} -> ${r.got} ${r.confidence}`);
for (const r of rows.filter((r) => r.kind !== "clear")) console.log(`${r.kind}: ${r.situation} -> ${r.got} ${r.confidence} (top ${r.top}, 2nd ${r.second})`);
for (const h of helpFN) console.log(`MISSED help: ${h.q}`);
for (const h of helpFP) console.log(`FALSE help: ${h.q}`);
console.log(`held-out help: caught ${heldTP}/${heldOut.filter((h) => h.want).length}, false alarms ${heldFP.length}`);
for (const h of heldOut.filter((h) => h.want !== h.got)) console.log(`HELD-OUT ${h.want ? "MISSED" : "FALSE"}: ${h.q}`);
