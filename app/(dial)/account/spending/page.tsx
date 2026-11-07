import { ComplexSpending } from "@/components/account/complex-spending";
import { SimpleSpending } from "@/components/account/simple-spending";
import { ModeView } from "@/components/mode-view";

export const metadata = { title: "Spending" };

// ?highlight=<ids> comes from Ask Dial evidence (AskResponse.evidenceIds) and survives a Dial switch.
export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ highlight?: string }> }) {
  const { highlight } = await searchParams;
  const ids = highlight ? highlight.split(",").filter(Boolean) : [];
  return <ModeView simple={<SimpleSpending highlightIds={ids} />} complex={<ComplexSpending highlightIds={ids} />} />;
}
