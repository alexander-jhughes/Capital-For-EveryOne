import { ExternalLink } from "lucide-react";
import { FREE_HELP } from "@/lib/profile/catalog";

/** Free, impartial UK money and debt advice. Shown to everyone on About you, and on Home when the profile asks for it. */
export function FreeHelp() {
  return (
    <ul className="flex flex-col gap-2">
      {FREE_HELP.map((h) => (
        <li key={h.name}>
          <a href={h.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-(--target-min) items-center gap-1.5 font-bold text-primary underline underline-offset-4">
            {h.name}
            <ExternalLink aria-hidden className="size-[0.9em]" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <span className="block text-muted-foreground">{h.what}</span>
        </li>
      ))}
    </ul>
  );
}
