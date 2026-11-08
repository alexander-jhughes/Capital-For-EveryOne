import { AppNav } from "@/components/app-nav";
import { AskDialProvider } from "@/components/assistant/ask-dial";
import { DialSessionProvider } from "@/components/dial/session";
import { GoalsProvider } from "@/lib/goals/provider";
import { ModeSwitch } from "@/components/mode-switch";
import { StylePreviewProvider } from "@/components/personalise/style-preview";
import { PersonalisationProvider } from "@/lib/personalisation/provider";
import { Wordmark } from "@/components/wordmark";

/** App shell. Phone: header, page, bottom tabs. Desktop (1024px+): side rail, wide page. One component tree for both. */
export default function DialLayout({ children }: { children: React.ReactNode }) {
  return (
    <PersonalisationProvider>
      <GoalsProvider>
      <DialSessionProvider>
      <AskDialProvider>
        <StylePreviewProvider>
          <div className="flex min-h-dvh flex-col lg:flex-row">
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-3 focus:text-primary-foreground"
            >
              Skip to main content
            </a>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="gutter page-width flex flex-wrap items-center justify-between gap-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] lg:px-10 lg:pt-6">
                <span className="lg:hidden">
                  <Wordmark stacked />
                </span>
                <p className="hidden text-sm text-muted-foreground lg:block">Credit card ending 4417</p>
                <ModeSwitch />
              </header>
              <main id="main" tabIndex={-1} className="gutter page-width flex-1 pb-8 pt-(--space) focus:outline-none lg:px-10">
                {children}
                <p className="mt-10 text-sm text-muted-foreground lg:hidden">
                  Capital for Everyone is an independent hackathon concept, not an official Capital One product.
                </p>
              </main>
            </div>
            <AppNav />
          </div>
        </StylePreviewProvider>
      </AskDialProvider>
      </DialSessionProvider>
      </GoalsProvider>
    </PersonalisationProvider>
  );
}
