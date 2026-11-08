"use client";

/**
 * Chooses a synthetic demo user. Before the form submits, the app's own browser storage (keys starting "cfe-") is
 * cleared, so nothing the previous person left in this tab (a pending Spend Pause purchase, its history) carries over.
 * The server's reply also sends Clear-Site-Data; this covers browsers that ignore it.
 */
export function DemoUserButton({ id, name, about }: { id: string; name: string; about: string }) {
  const clearAppStorage = () => {
    for (const get of [() => window.sessionStorage, () => window.localStorage]) {
      try {
        const store = get();
        for (const k of Object.keys(store)) if (k.startsWith("cfe-")) store.removeItem(k);
      } catch {}
    }
  };
  return (
    // A form, not a link: choosing a user replaces this browser's demo data, and prefetching must never do that.
    <form action={`/demo/user/${id}`} method="post" onSubmit={clearAppStorage}>
      <button type="submit" className="flex min-h-(--target-min) w-full flex-col justify-center rounded-lg bg-accent px-3 py-2 text-left text-accent-foreground">
        <span className="font-bold">{name}</span>
        <span className="text-sm">{about}</span>
      </button>
    </form>
  );
}
