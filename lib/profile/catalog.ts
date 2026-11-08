// What a person can tell us about themselves, and the person types the profile model chooses between.
//
// The needs follow the four drivers of vulnerability that the FCA's guidance (FG21/1) and the Money Advice Trust's
// vulnerability handbook use: health, life events, resilience and capability, plus how the person likes to be spoken to.
// Two rules come from that guidance:
//   1. No need is guessed. Every need is something the person ticked themselves, and they can untick it. (The model
//      does work out which of six ways of tailoring fits, from those ticks and account behaviour, and says why.)
//   2. Health is special category data (UK GDPR article 9), so a health need is only kept with a separate, explicit
//      consent, and the server refuses it otherwise.
// Person-facing words describe what would help, never a label for the person. A test bans words such as
// "vulnerable", "disability" and "diagnosis" from everything in this file.

export const DRIVERS = ["health", "life_event", "resilience", "capability", "communication"] as const;
export type Driver = (typeof DRIVERS)[number];

export const DRIVER_HEADINGS: Record<Driver, { title: string; hint: string }> = {
  health: { title: "Things that affect how you manage", hint: "Kept only if you give the extra consent below." },
  life_event: { title: "Something that has happened", hint: "Big changes can make money harder to think about." },
  resilience: { title: "How money is right now", hint: "So we can put the most useful things first." },
  capability: { title: "Confidence with credit and apps", hint: "So Dial explains things the way that suits you." },
  communication: { title: "How you like Dial to talk", hint: "Dial uses these for every answer." },
};

/** Order matters: the cookie stores needs by their index here. Only ever add to the end. */
export const NEEDS = [
  { id: "reading", driver: "health", label: "Long text or concentrating can be hard" },
  { id: "memory", driver: "health", label: "I find it hard to remember dates and details" },
  { id: "money_anxiety", driver: "health", label: "Thinking about money makes me anxious" },
  { id: "sight_hearing", driver: "health", label: "I have difficulty with my sight or hearing" },
  { id: "bereavement", driver: "life_event", label: "Someone close to me has died" },
  { id: "income_change", driver: "life_event", label: "I've lost my job or my income has dropped" },
  { id: "caring", driver: "life_event", label: "I've become a carer or had a baby" },
  { id: "relationship", driver: "life_event", label: "A relationship has ended" },
  { id: "money_tight", driver: "resilience", label: "Money is tight right now" },
  { id: "irregular_income", driver: "resilience", label: "My income changes from month to month" },
  { id: "behind_bills", driver: "resilience", label: "I'm behind on some bills" },
  { id: "new_to_credit", driver: "capability", label: "I'm new to credit cards" },
  { id: "numbers", driver: "capability", label: "I'm not confident with numbers" },
  { id: "english", driver: "capability", label: "English isn't my first language" },
  { id: "digital", driver: "capability", label: "I'm not confident using apps" },
  { id: "plain_words", driver: "communication", label: "Use plain, everyday words" },
  { id: "short_answers", driver: "communication", label: "Keep answers short" },
  { id: "step_by_step", driver: "communication", label: "One thing at a time" },
] as const satisfies readonly { id: string; driver: Driver; label: string }[];

export type NeedId = (typeof NEEDS)[number]["id"];
export const NEED_IDS: readonly NeedId[] = NEEDS.map((n) => n.id);
export const isNeedId = (v: unknown): v is NeedId => NEED_IDS.includes(v as NeedId);
export const driverOf = (id: NeedId): Driver => NEEDS.find((n) => n.id === id)!.driver;
/** Health needs are special category data: kept only with the extra consent. */
export const isSensitive = (id: NeedId) => driverOf(id) === "health";

// ---- Person types ----

export const PERSON_TYPES = ["building", "steady", "stretched", "life_change", "clear_simple", "planner"] as const;
export type PersonType = (typeof PERSON_TYPES)[number];
export const isPersonType = (v: unknown): v is PersonType => PERSON_TYPES.includes(v as PersonType);

/** How each type is described to the person. "You" language about what they want, never about what they are. */
export const PERSON_TYPE_COPY: Record<PersonType, { title: string; summary: string }> = {
  building: { title: "Building your credit", summary: "Clear explanations, your payment date up front and tips on using credit well." },
  steady: { title: "Steady and in control", summary: "A quick check on your bill, subscriptions and savings goals." },
  stretched: { title: "Staying on top when money is tight", summary: "Your bill and the least you can pay first, a calm screen and where to get free help." },
  life_change: { title: "Going through a big change", summary: "Fewer things to think about, reminders that matter, and help if you want it." },
  clear_simple: { title: "Clear and simple", summary: "Fewer numbers, plain words and one step at a time." },
  planner: { title: "Planning ahead", summary: "Charts, what-if sums and your goals close at hand." },
};

/** Free, impartial UK debt and money advice. Names and websites only, so nothing here can look like a figure. */
export const FREE_HELP = [
  { name: "MoneyHelper", url: "https://www.moneyhelper.org.uk", what: "Free, impartial money guidance backed by the government" },
  { name: "National Debtline", url: "https://www.nationaldebtline.org", what: "Free debt advice from the Money Advice Trust" },
  { name: "StepChange", url: "https://www.stepchange.org", what: "Free debt advice charity" },
] as const;
