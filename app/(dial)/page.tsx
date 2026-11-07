import Link from "next/link";
import { DialMark } from "@/components/wordmark";

// First-run screen. The full "choose your view" onboarding is Stage 7.
export default function Welcome() {
  return (
    <div className="flex flex-col gap-(--space) py-6">
      <DialMark className="size-16" />
      <h1 className="text-xl font-bold tracking-tight">Credit, made accessible.</h1>
      <p className="text-lg text-muted-foreground">
        Capital for Everyone shows your credit card the way that suits you. Dial, the assistant, answers questions about your money and can reshape the app when you ask.
      </p>
      <p>Choose Simple or Detailed view with the switch at the top. You can change it at any time.</p>
      <Link href="/account" className="elevated flex min-h-(--target-min) items-center justify-center rounded-xl bg-primary px-6 text-lg font-bold text-primary-foreground sm:self-start">
        Sign in
      </Link>
    </div>
  );
}
