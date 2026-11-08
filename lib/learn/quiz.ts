// Credit knowledge quiz. Fixed questions, checked here (never by a model). Progress is the person's own answers,
// kept on this device only (components/learn/quiz.tsx), and read back through sanitizeAnswers.

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** Index into options. */
  answer: number;
  explanation: string;
}

export const QUIZ: QuizQuestion[] = [
  {
    id: "utilisation",
    prompt: "What is credit utilisation?",
    options: ["Your balance as a share of your credit limit", "Your card's interest rate", "How many cards you have", "Your credit score"],
    answer: 0,
    explanation: "Utilisation compares what you owe with your limit. £300 owed on a £1,000 limit is 30%.",
  },
  {
    id: "minimum",
    prompt: "Your bill is £486.20 and the minimum payment is £25. If you pay only £25, what happens to the rest?",
    options: ["It carries over to next month, and interest is usually charged on it", "It's written off", "It's taken from your bank automatically", "Nothing: the bill is cleared"],
    answer: 0,
    explanation: "Paying the minimum keeps the account up to date, but what's left carries over. Interest is usually charged on it, depending on your card's terms.",
  },
  {
    id: "apr",
    prompt: "What does APR stand for?",
    options: ["Annual percentage rate", "Average payment required", "Account payment record", "Approved purchase rate"],
    answer: 0,
    explanation: "APR is a yearly interest rate. Monthly interest is roughly a twelfth of it.",
  },
  {
    id: "current-vs-statement",
    prompt: "Which figure includes spending since your last statement?",
    options: ["Current balance", "Statement balance", "Minimum payment", "Credit limit"],
    answer: 0,
    explanation: "The statement balance is fixed when the statement is made. The current balance keeps changing as you spend and pay.",
  },
  {
    id: "pending",
    prompt: "What is a pending transaction?",
    options: ["A payment the shop has started but not finished, so the amount can still change or drop off", "A payment that failed", "A refund you've asked for", "A purchase Spend Pause blocked"],
    answer: 0,
    explanation: "Pending items are still being processed. They usually settle within a few days, sometimes for a slightly different amount.",
  },
  {
    id: "available",
    prompt: "Your limit is £1,500 and your balance is £1,069.89. How much credit is available?",
    options: ["£430.11", "£1,500.00", "£1,069.89", "£486.20"],
    answer: 0,
    explanation: "Available credit is the limit minus the current balance: £1,500.00 − £1,069.89 = £430.11.",
  },
  {
    id: "pay-more",
    prompt: "Compared with paying only the minimum, paying more each month usually…",
    options: ["Clears the balance sooner and costs less interest overall", "Costs more interest", "Makes no difference", "Lowers your credit limit"],
    answer: 0,
    explanation: "Each extra pound reduces the balance that interest is charged on. Try it in the minimum payment explainer.",
  },
  {
    id: "missed",
    prompt: "What can happen if a payment is missed?",
    options: ["A late fee, and the missed payment can be recorded on your credit file", "Nothing at all", "Your limit always goes up", "The balance is frozen"],
    answer: 0,
    explanation: "Missed payments can bring fees and can appear on your credit file. Paying at least the minimum on time avoids that.",
  },
];

/**
 * Answer order on screen. The right answer isn't always first: options are rotated by a fixed amount per question,
 * so the order is the same on every visit and in every test.
 */
export function shuffledOptions(q: QuizQuestion): { text: string; index: number }[] {
  const shift = [...q.id].reduce((s, c) => s + c.charCodeAt(0), 0) % q.options.length;
  return q.options.map((_, i) => {
    const index = (i + shift) % q.options.length;
    return { text: q.options[index], index };
  });
}

export type QuizAnswers = Record<string, number>;

/** Keeps only answers to real questions with a valid option index. Anything else in storage is dropped. */
export function sanitizeAnswers(v: unknown): QuizAnswers {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const out: QuizAnswers = {};
  for (const q of QUIZ) {
    const a = (v as Record<string, unknown>)[q.id];
    if (Number.isInteger(a) && (a as number) >= 0 && (a as number) < q.options.length) out[q.id] = a as number;
  }
  return out;
}

export function quizProgress(answers: QuizAnswers) {
  const answered = QUIZ.filter((q) => q.id in answers);
  return { answered: answered.length, correct: answered.filter((q) => answers[q.id] === q.answer).length, total: QUIZ.length };
}
