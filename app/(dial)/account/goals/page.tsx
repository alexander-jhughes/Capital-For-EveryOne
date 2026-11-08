import { GoalsScreen } from "@/components/goals/goals-screen";
import { GoalsProvider } from "@/lib/goals/provider";

export const metadata = { title: "Goals" };

// One screen for both views: sizes and spacing follow the Simple or Detailed tokens. GoalsProvider is safe to keep
// here if it is later hoisted to the layout too: a nested provider passes straight through to the outer one.
export default function GoalsPage() {
  return (
    <GoalsProvider>
      <GoalsScreen />
    </GoalsProvider>
  );
}
