// Template sentences. Each one is built only from a FactSet, so it is correct by construction and needs no model.
import type { AnswerFactSet } from "./answer-facts";
import { CANT_TELL } from "./guard";
import { billQuestion, spendQuestion } from "./intent";

const list = (values: string[]) => values.join("; ");

/**
 * The plain answer for a fact set: at most two sentences, using only the fact values. The question only picks which
 * bill facts to say: the statement balance is what's due now, and the current balance is everything owed.
 */
export function templateAnswer(set: AnswerFactSet, question = ""): string {
  const value = (key: string) => set.facts.find((f) => f.key === key)?.value;
  const values = (prefix: string) => set.facts.filter((f) => f.key.startsWith(prefix)).map((f) => f.value);

  switch (set.intent) {
    case "spend_this_month": {
      const top = value("month_top_category");
      const kind = spendQuestion(question);
      if (kind === "category" && top) return `Your biggest category this month is ${top}.`;
      if (kind === "compare") {
        const change = value("change_vs_same_days_last_month");
        const previous = value("same_days_last_month_total");
        const spent = `You have spent ${value("month_to_date_total")} so far this month`;
        return change === "The same" ? `${spent}, the same as the same days last month.` : `${spent}, ${change} than the same days last month, when you spent ${previous}.`;
      }
      const total = `You have spent ${value("month_to_date_total")} so far this month.`;
      return top ? `${total} Your biggest category is ${top}.` : total;
    }
    case "spend_last_month": {
      const total = set.facts.find((f) => f.key === "last_month_total");
      const top = value("last_month_top_category");
      if (!total) return CANT_TELL;
      if (spendQuestion(question) === "category" && top) return `Your biggest category last month was ${top}.`;
      const sentence = `You spent ${total.value} in ${total.label.replace("Spent in ", "")}.`;
      return top ? `${sentence} Your biggest category was ${top}.` : sentence;
    }
    case "top_items": {
      const items = values("top_item_");
      const when = set.facts[0]?.label.includes("last month") ? "last month" : "this month";
      return items.length > 0 ? `Your biggest purchases ${when} were: ${list(items)}.` : CANT_TELL;
    }
    case "duplicates": {
      if (value("no_duplicates")) return "I can't see any possible duplicate charges.";
      return `You may have been charged twice: ${list(values("duplicate_"))}.`;
    }
    case "price_changes": {
      if (value("no_price_changes")) return "I can't see any subscription price changes.";
      return `${list(values("price_change_"))}.`;
    }
    case "days_until_due": {
      const left = value("days_until_due");
      const when = left === "Today" ? "That is today." : left?.startsWith("Overdue") ? `It is ${left.toLowerCase()}.` : `That is in ${left}.`;
      const statement = value("statement_balance");
      const current = value("current_balance");
      const due = value("due_date");
      const minimum = value("minimum_payment");
      switch (billQuestion(question)) {
        case "current":
          return `Your current balance is ${current}.`;
        case "owed":
          return `Your current balance is ${current}, which is everything on the card right now, and not all of it is due yet. Your latest bill, the statement balance, is ${statement}, and the minimum payment on it is ${minimum}, by ${due}.`;
        case "balance":
          return `Your current balance is ${current}. Your statement balance is ${statement}, due on ${due}.`;
        case "pay":
          return `Your full statement balance, the amount on your latest bill, is ${statement}. The minimum payment is ${minimum}, and both are due by ${due}.`;
        case "last_payment":
          return `Your last payment was ${value("last_payment")?.replace(", on", " on")}.`;
        case "bill":
          return `Your bill, the statement balance, is ${statement}, due on ${due}.`;
        case "due":
          return `Your bill of ${statement} is due on ${due}. ${when}`;
      }
      break;
    }
    case "subscription_list": {
      if (value("no_subscriptions")) return "I can't see any subscriptions in your transactions.";
      const active = values("subscription_");
      const lapsed = values("lapsed_subscription_");
      const paying = active.length > 0 ? `You are paying for these subscriptions: ${list(active)}.` : "I can't see any subscription with a recent charge.";
      return lapsed.length > 0 ? `${paying} These have stopped being charged: ${list(lapsed)}.` : paying;
    }
    case "transaction_lookup":
      return value("no_transaction") ? "I can't find a transaction with that reference." : `That transaction is ${value("transaction")}.`;
    case "merchant_refunds": {
      if (value("no_refunds")) return `I can't see any refund${set.merchant ? ` from ${set.merchant}` : ""} in your transactions.`;
      const describe = (prefix: string, status = "") =>
        list(
          set.facts
            .filter((f) => f.key.startsWith(prefix))
            .map((f) => {
              const [, amount, date, purchase] = f.value.match(/^(£[\d,.]*\d), on (.+?)(?:, for your £[\d,.]*\d purchase on (.+))?$/) ?? [];
              const shop = f.label.replace(/^(?:Pending|Completed) /, "").replace(/ refund.*$/, "");
              const reversed = purchase ? ` for your purchase on ${purchase}` : "";
              return { text: `${amount} ${shop} refund${reversed}`, date };
            })
            .map(({ text, date }) => `Your ${text}${prefix === "refund_completed_" ? ` arrived on ${date}` : status}`),
        );
      const waiting = describe("refund_pending_", " is pending");
      const arrived = describe("refund_completed_");
      const several = set.facts.filter((f) => f.key.startsWith("refund_pending_")).length > 1;
      return [waiting && `${waiting}, so ${several ? "they have" : "it has"} not arrived yet.`, arrived && `${arrived}.`].filter(Boolean).join(" ");
    }
    case "merchant_transactions": {
      const period = /(?:this|last) month/.exec(set.facts[0].label)?.[0];
      const when = period ? ` ${period}` : "";
      if (value("no_transactions")) return `I can't see any ${set.merchant} transactions${when}.`;
      const total = set.facts.find((f) => f.key === "merchant_total");
      const count = Number(value("merchant_transactions"));
      const latest = value("transaction_1") ?? "";
      const onDate = latest.replace(/^£[\d,.]*\d on /, "").replace(/ \(.*\)$/, "");
      if (count === 1 && latest.endsWith("(purchase)")) return `You spent ${total?.value} at ${set.merchant} on ${onDate}.`;
      const note = total?.label.match(/, (?:after refunds|counting pending items).*$/)?.[0] ?? "";
      const noun = count === 1 ? "transaction" : "transactions";
      return `You have ${count} ${set.merchant} ${noun}${when}, totalling ${total?.value}${note}. The latest is ${latest.replace(" (purchase)", "")}.`;
    }
    case "minimum_payment":
      return `Your minimum payment is ${value("minimum_payment")}, due on ${value("due_date")}.`;
    case "spend_pause": {
      const status = `Spend Pause is ${value("spend_pause_status")?.toLowerCase()}.`;
      const threshold = value("check_over");
      const left = value("budget_left");
      const over = value("budget_over");
      const budget = left ? `you have ${left} left in your budget this month` : over ? `you are ${over} over your budget this month` : null;
      const checks = threshold ? `It checks any purchase over ${threshold}` : null;
      if (checks && budget) return `${status} ${checks}, and ${budget}.`;
      if (checks) return `${status} ${checks}.`;
      return budget ? `${status} Right now ${budget}.` : status;
    }
  }
  return CANT_TELL;
}
