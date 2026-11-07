// Owned by the Stage 6 developer for this screen; this placeholder only carries the shared design. See docs/INTEGRATION.md.
export const metadata = { title: "Pay" };

export default function Page() {
  return (
    <div className="flex flex-col gap-(--space)">
      <h1 className="text-xl font-bold tracking-tight">Pay</h1>
      <div className="elevated flex flex-col gap-2 rounded-xl bg-card p-(--space)">
        <p className="text-lg">Pay your bill in full, the minimum, or an amount you choose, with a clear confirmation and an undo.</p>
        <p className="text-muted-foreground">This screen is being built by another member of the team.</p>
      </div>
    </div>
  );
}
