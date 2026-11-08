// Demo only: pick a synthetic user to see how the app and Dial tailor themselves. Every person here is fictional.
import Link from "next/link";
import { DemoUserButton } from "@/components/profile/demo-user-button";
import { DEMO_USERS } from "@/lib/demo-users/users";
import { PERSON_TYPE_COPY, PERSON_TYPES } from "@/lib/profile/catalog";

export const metadata = { title: "Synthetic demo users" };

export default function DemoUsersPage() {
  return (
    <main className="gutter page-width flex flex-col gap-(--space) py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-bold">Synthetic demo users</h1>
        <p className="text-lg">
          Fictional people with made-up characteristics, for the demo. Choosing one gives this browser a clean start as them: their demo account, &quot;About you&quot; profile and view replace yours, and display settings and anything left in this tab are cleared, as with &quot;Start the demo again&quot;. Then Home opens.
          The model works out each person&apos;s type from their characteristics; it is not told the heading they are listed under.
        </p>
        <Link href="/account/more" className="self-start font-bold text-primary underline underline-offset-4">
          Back to the app
        </Link>
      </div>
      {PERSON_TYPES.map((t) => (
        <section key={t} aria-labelledby={`t-${t}`} className="elevated flex flex-col gap-2 rounded-xl bg-card p-(--space)">
          <h2 id={`t-${t}`} className="text-lg font-bold">
            Written to illustrate: {PERSON_TYPE_COPY[t].title}
          </h2>
          <ul className="flex flex-col gap-2">
            {DEMO_USERS.filter((u) => u.designedAs === t).map((u) => (
              <li key={u.id}>
                <DemoUserButton id={u.id} name={u.name} about={u.about} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
