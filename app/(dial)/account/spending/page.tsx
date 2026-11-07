import { ComplexSpending } from "@/components/account/complex-spending";
import { SimpleSpending } from "@/components/account/simple-spending";
import { ModeView } from "@/components/mode-view";
import { parseSpendingFilters } from "@/lib/dial/spending-filters";

export const metadata = { title: "Spending" };

// Everything the screen shows is in the URL, so a reload, back/forward and a Dial switch keep it:
// ?category= ?month= ?merchant= ?sort= narrow the list, ?txn= opens one transaction, and ?highlight=<ids> comes from
// Ask Dial evidence (AskResponse.evidenceIds). parseSpendingFilters drops anything not allowlisted.
export default async function SpendingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filters = parseSpendingFilters(await searchParams);
  return <ModeView simple={<SimpleSpending filters={filters} />} complex={<ComplexSpending filters={filters} />} />;
}
