// SYNTHETIC demo users. Fictional people, made up for the demo: no real person's data.
//
// Each one has characteristics (what they told us on About you, how they use the app) and account history. The
// history is stored as EVENTS on top of the one demo account in lib/data/seed.ts (payments, approved purchases, goals,
// Spend Pause), never as balances, so lib/finance stays the only source of every figure. Build them with
// buildDemoUser() (./build.ts), which applies each event through the same validated functions the API uses.
//
// `designedAs` is the person type each user was written to illustrate. It is NOT given to the model: the model works
// the type out from the characteristics, and lib/demo-users/users.test.ts reports how often it agrees.
// These six person types are not demo financial scenarios: every user here shares the same demo account.
import type { GoalSpec } from "../dial/types";
import type { NeedId, PersonType } from "../profile/catalog";
import type { Usage } from "../profile/features";
import type { Pence, SpendPauseSettings } from "../types";

export interface DemoUser {
  id: string;
  /** A fictional first name. */
  name: string;
  /** One line about this synthetic person, for the demo picker. */
  about: string;
  designedAs: PersonType;
  view: "simple" | "complex";
  profile: { sensitiveConsent: boolean; needs: NeedId[] };
  usage: Partial<Usage>;
  events: {
    payments?: { kind: "minimum" | "statement" | "custom"; amount?: Pence }[];
    purchases?: { merchant: string; item: string; amount: Pence }[];
    goals?: GoalSpec[];
    spendPause?: SpendPauseSettings;
  };
}

const PAUSE_ON: SpendPauseSettings = { enabled: true, singlePurchaseThreshold: 5000, monthlyBudget: 30000, quietHours: { start: "22:00", end: "07:00" } };

export const DEMO_USERS: DemoUser[] = [
  // ---- Building your credit ----
  {
    id: "amara",
    name: "Amara",
    about: "First credit card, reading up on how credit works",
    designedAs: "building",
    view: "simple",
    profile: { sensitiveConsent: false, needs: ["new_to_credit", "plain_words"] },
    usage: { learn: 4, dial: 2 },
    events: { goals: [{ kind: "pay_on_time" }] },
  },
  {
    id: "jonah",
    name: "Jonah",
    about: "New to credit and not keen on numbers",
    designedAs: "building",
    view: "complex",
    profile: { sensitiveConsent: false, needs: ["new_to_credit", "numbers"] },
    usage: { learn: 3 },
    events: { payments: [{ kind: "minimum" }] },
  },
  {
    id: "mei",
    name: "Mei",
    about: "Recently moved to the UK, building a credit history",
    designedAs: "building",
    view: "complex",
    profile: { sensitiveConsent: false, needs: ["new_to_credit", "english"] },
    usage: { learn: 5, dial: 1 },
    events: { goals: [{ kind: "pay_on_time" }] },
  },
  // ---- Steady and in control ----
  {
    id: "priya",
    name: "Priya",
    about: "Pays in full every month and is saving for a holiday",
    designedAs: "steady",
    view: "complex",
    profile: { sensitiveConsent: false, needs: ["short_answers"] },
    usage: { detailed: 3, goals: 2 },
    events: {
      payments: [{ kind: "statement" }],
      goals: [{ kind: "save_up", purpose: "purchase", target: 120000, by: "2027-06", saved: 30000, log: [["2026-11-01", 30000]], label: "Holiday" }],
    },
  },
  {
    id: "tom",
    name: "Tom",
    about: "Clears the bill and pays extra, building an emergency fund",
    designedAs: "steady",
    view: "complex",
    profile: { sensitiveConsent: false, needs: [] },
    usage: { detailed: 2, goals: 2 },
    events: {
      payments: [{ kind: "statement" }, { kind: "custom", amount: 20000 }],
      goals: [{ kind: "save_up", purpose: "emergency", target: 100000, by: "2027-12", saved: 45000, log: [["2026-11-01", 45000]] }],
    },
  },
  {
    id: "grace",
    name: "Grace",
    about: "Keeps an eye on eating out and pays in full",
    designedAs: "steady",
    view: "complex",
    profile: { sensitiveConsent: false, needs: [] },
    usage: { goals: 3, detailed: 3 },
    events: { payments: [{ kind: "statement" }], goals: [{ kind: "category_cap", category: "Eating out", monthlyLimit: 8000 }] },
  },
  // ---- Staying on top when money is tight ----
  {
    id: "dan",
    name: "Dan",
    about: "Hours were cut; paying the minimum and behind on a bill",
    designedAs: "stretched",
    view: "simple",
    profile: { sensitiveConsent: false, needs: ["money_tight", "behind_bills"] },
    usage: { dial: 2 },
    events: { payments: [{ kind: "minimum" }], purchases: [{ merchant: "Asda", item: "Weekly shop", amount: 12000 }], spendPause: PAUSE_ON },
  },
  {
    id: "leah",
    name: "Leah",
    about: "Freelance income that changes month to month",
    designedAs: "stretched",
    view: "complex",
    profile: { sensitiveConsent: false, needs: ["money_tight", "irregular_income"] },
    usage: { dial: 2, goals: 1 },
    events: { payments: [{ kind: "minimum" }], goals: [{ kind: "pay_down", target: 60000, by: "2027-03", startBalance: 104489 }] },
  },
  {
    id: "kofi",
    name: "Kofi",
    about: "Behind on bills and finds money stressful",
    designedAs: "stretched",
    view: "simple",
    profile: { sensitiveConsent: true, needs: ["behind_bills", "money_anxiety"] },
    usage: { dial: 1 },
    events: { purchases: [{ merchant: "Currys", item: "Washing machine", amount: 22000 }] },
  },
  // ---- Going through a big change ----
  {
    id: "ruth",
    name: "Ruth",
    about: "Recently bereaved, taking over the household bills",
    designedAs: "life_change",
    view: "simple",
    profile: { sensitiveConsent: false, needs: ["bereavement", "short_answers"] },
    usage: { dial: 1 },
    events: {},
  },
  {
    id: "sam",
    name: "Sam",
    about: "Lost their job and has become a carer",
    designedAs: "life_change",
    view: "complex",
    profile: { sensitiveConsent: false, needs: ["income_change", "caring"] },
    usage: {},
    events: { payments: [{ kind: "minimum" }] },
  },
  {
    id: "ella",
    name: "Ella",
    about: "Just separated, wants one thing at a time",
    designedAs: "life_change",
    view: "simple",
    profile: { sensitiveConsent: true, needs: ["relationship", "money_anxiety", "step_by_step"] },
    usage: { dial: 1 },
    events: {},
  },
  // ---- Clear and simple ----
  {
    id: "arthur",
    name: "Arthur",
    about: "Finds small print hard to read and prefers to talk",
    designedAs: "clear_simple",
    view: "simple",
    profile: { sensitiveConsent: true, needs: ["reading", "sight_hearing", "plain_words", "step_by_step"] },
    usage: { dial: 3 },
    events: { payments: [{ kind: "statement" }] },
  },
  {
    id: "nadia",
    name: "Nadia",
    about: "Not confident with apps; English is a second language",
    designedAs: "clear_simple",
    view: "simple",
    profile: { sensitiveConsent: false, needs: ["english", "digital", "plain_words"] },
    usage: { dial: 2 },
    events: {},
  },
  {
    id: "joe",
    name: "Joe",
    about: "Forgets dates and likes things explained step by step",
    designedAs: "clear_simple",
    view: "simple",
    profile: { sensitiveConsent: true, needs: ["memory", "numbers", "step_by_step"] },
    usage: { dial: 2 },
    events: { goals: [{ kind: "pay_on_time" }] },
  },
  // ---- Planning ahead ----
  {
    id: "ivy",
    name: "Ivy",
    about: "Runs what-if sums and tracks spending by category",
    designedAs: "planner",
    view: "complex",
    profile: { sensitiveConsent: false, needs: [] },
    usage: { whatIf: 5, detailed: 5, goals: 3 },
    events: {
      payments: [{ kind: "statement" }],
      goals: [
        { kind: "category_cap", category: "Shopping", monthlyLimit: 15000 },
        { kind: "pay_down", target: 20000, by: "2027-02", startBalance: 58369 },
      ],
    },
  },
  {
    id: "raj",
    name: "Raj",
    about: "Planning to spend less and save for a car",
    designedAs: "planner",
    view: "complex",
    profile: { sensitiveConsent: false, needs: [] },
    usage: { whatIf: 4, detailed: 4, dial: 2 },
    events: {
      goals: [
        { kind: "spend_reduction", target: 10000, by: "2026-12", baselineMonth: "2026-10" },
        { kind: "save_up", purpose: "purchase", target: 300000, by: "2027-09", saved: 50000, log: [["2026-11-01", 50000]], label: "Car" },
      ],
    },
  },
  {
    id: "zoe",
    name: "Zoe",
    about: "Watches her credit utilisation closely",
    designedAs: "planner",
    view: "complex",
    profile: { sensitiveConsent: false, needs: [] },
    usage: { whatIf: 6, detailed: 3, dial: 2 },
    events: { payments: [{ kind: "statement" }], goals: [{ kind: "utilisation", percent: 30, by: "2027-01", startBalance: 58369 }] },
  },
];

export const demoUser = (id: string) => DEMO_USERS.find((u) => u.id === id) ?? null;
