import Link from "next/link";

// Placeholder: the first-run "How would you like Dial to look?" screen arrives in Stage 7.
export default function Welcome() {
  return (
    <>
      <h1 className="text-xl font-bold">Welcome to Dial</h1>
      <p className="mt-(--space)">Choose Simple or Complex view with the switch at the top of every screen.</p>
      <Link href="/account" className="mt-(--space) inline-flex min-h-(--target-min) items-center rounded-lg bg-primary px-6 font-bold text-primary-foreground">
        Sign in
      </Link>
    </>
  );
}
