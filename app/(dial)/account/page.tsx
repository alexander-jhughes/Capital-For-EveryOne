import { ComplexHome } from "@/components/account/complex-home";

export const metadata = { title: "Home" };

// Stage 5 adds the Simple home here; until then both modes show this screen at their own sizes.
export default function HomePage() {
  return <ComplexHome />;
}
