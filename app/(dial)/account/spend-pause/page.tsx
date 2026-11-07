import { SpendPauseScreen } from "@/components/spend-pause/spend-pause-screen";

export const metadata = { title: "Spend Pause" };

export default async function Page({ searchParams }: { searchParams: Promise<{ confirm?: string }> }) {
  const { confirm } = await searchParams;
  return <SpendPauseScreen requested={confirm} />;
}
