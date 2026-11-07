import { HomeScreen } from "@/components/home/home-screen";
import { HOME_SECTIONS, type HomeSection } from "@/lib/dial/types";

export const metadata = { title: "Home" };

// ?focus=<section> (from Dial, e.g. "show me my balance") scrolls to that section and focuses its heading.
// Anything that isn't a Home section is ignored.
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).focus;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const focus = (HOME_SECTIONS as readonly string[]).includes(value ?? "") ? (value as HomeSection) : undefined;
  return <HomeScreen focus={focus} />;
}
