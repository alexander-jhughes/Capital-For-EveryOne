import { ComplexSpending } from "@/components/account/complex-spending";

export const metadata = { title: "Spending" };

// Stage 5 adds the Simple spending view here; until then both modes show this screen at their own sizes.
export default async function SpendingPage({ searchParams }: { searchParams: Promise<{ highlight?: string }> }) {
  const { highlight } = await searchParams;
  return <ComplexSpending highlightIds={highlight ? highlight.split(",").filter(Boolean) : []} />;
}
