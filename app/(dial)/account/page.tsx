import { ComplexHome } from "@/components/account/complex-home";
import { SimpleHome } from "@/components/account/simple-home";
import { ModeView } from "@/components/mode-view";

export const metadata = { title: "Home" };

export default function HomePage() {
  return <ModeView simple={<SimpleHome />} complex={<ComplexHome />} />;
}
