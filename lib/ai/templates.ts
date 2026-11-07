// Template sentences. Each one is built only from a FactSet, so it is correct by construction and needs no model.
import type { FactSet } from "../types";
import { CANT_TELL } from "./guard";

const list = (values: string[]) => values.join("; ");

/**
 * The plain answer for a fact set: at most two sentences, using only the fact values. The facts hold the statement
 * balance but not the current balance, so a question about "balance" is told which one this is.
 */
export function templateAnswer(set: FactSet, question = ""): string {
  const value = (key: string) => set.facts.find((f) => f.key === key)?.value;
  const values = (prefix: string) => set.facts.filter((f) => f.key.startsWith(prefix)).map((f) => f.value);

  switch (set.intent) {
    case "spend_this_month": {
      const top = value("month_top_category");
      const total = `You have spent ${value("month_to_date_total")} so far this month.`;
      return top ? `${total} Your biggest category is ${top}.` : total;
    }
    case "spend_last_month": {
      const total = set.facts.find((f) => f.key === "last_month_total");
      const top = value("last_month_top_category");
      if (!total) return CANT_TELL;
      const sentence = `You spent ${total.value} in ${total.label.replace("Spent in ", "")}.`;
      return top ? `${sentence} Your biggest category was ${top}.` : sentence;
    }
    case "top_items": {
      const items = values("top_item_");
      return items.length > 0 ? `Your biggest purchases this month were: ${list(items)}.` : CANT_TELL;
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
      if (/\bbalance\b/i.test(question)) return `Your statement balance is ${value("statement_balance")}, due on ${value("due_date")}.`;
      return `Your bill of ${value("statement_balance")} is due on ${value("due_date")}. ${when}`;
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
}
