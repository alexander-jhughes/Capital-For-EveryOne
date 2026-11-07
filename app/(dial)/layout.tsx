import { ModeSwitch } from "@/components/mode-switch";
import { TabBar } from "@/components/tab-bar";
import { Wordmark } from "@/components/wordmark";

/** The Dial app shell: header, page, bottom tabs. A centred phone-width column on desktop. */
export default function DialLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[30rem] flex-col bg-background sm:border-x-2">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <header className="gutter flex flex-wrap items-center justify-between gap-2 border-b-2 bg-card pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Wordmark />
        <ModeSwitch />
      </header>
      <main id="main" tabIndex={-1} className="gutter flex-1 py-(--space) focus:outline-none">
        {children}
      </main>
      <TabBar />
    </div>
  );
}
