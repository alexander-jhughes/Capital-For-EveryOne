// The Learning Lab's topics, readable on the server (routes, page titles) and in the browser (the hub).
export const TOPICS = [
  { slug: "utilisation", title: "Credit utilisation", blurb: "How much of your limit you use, and what a payment changes." },
  { slug: "minimum-payments", title: "Minimum payments", blurb: "What paying only the minimum costs, and what a little more saves." },
  { slug: "interest", title: "APR and interest", blurb: "Work out the time and interest to clear a balance." },
  { slug: "statement", title: "Your statement, explained", blurb: "Every figure on a statement, with yours beside it." },
  { slug: "quiz", title: "Credit quiz", blurb: "Eight short questions, each with an explanation." },
] as const;
export type TopicSlug = (typeof TOPICS)[number]["slug"];
export const isTopic = (v: string): v is TopicSlug => TOPICS.some((t) => t.slug === v);
