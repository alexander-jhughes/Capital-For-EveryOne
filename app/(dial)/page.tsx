import { redirect } from "next/navigation";
import { Onboarding } from "@/components/onboarding/onboarding";

// First run: welcome, then a short skippable setup. /?demo=reset starts the whole demo again.
export default async function Welcome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  if (q.demo === "reset") redirect("/demo/reset");
  return <Onboarding reset={q.reset === "done"} />;
}
