import { AppNav } from "@/components/app-nav";
import { AskDialProvider } from "@/components/assistant/ask-dial";
import { DialSessionProvider } from "@/components/dial/session";
import { GoalsProvider } from "@/lib/goals/provider";
import { ModeSwitch } from "@/components/mode-switch";
import { MoreButton } from "@/components/more-menu";
import { StylePreviewProvider } from "@/components/personalise/style-preview";
import { PersonalisationProvider } from "@/lib/personalisation/provider";
import { ProfileProvider } from "@/lib/profile/provider";
import { Wordmark } from "@/components/wordmark";

/** App shell. Phone: header, page, bottom tabs. Desktop (1024px+): side rail, wide page. One component tree for both. */
export default function DialLayout({ children }: { children: React.ReactNode }) {
  return (
    <PersonalisationProvider>
      <ProfileProvider>
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
              <header className="app-header gutter page-width flex flex-wrap items-center justify-between gap-2 pb-1 pt-[max(0.5rem,env(safe-area-inset-top))] lg:px-10 lg:pt-6">
                <span className="lg:hidden">
                  <Wordmark stacked />
                </span>
                <p className="hidden text-sm text-muted-foreground lg:block">
                  Credit card ending 4417{" "}
                  <span className="ml-1 rounded-full bg-warning-surface px-2 py-0.5 font-bold text-warning">Demo data</span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <MoreButton />
                  <ModeSwitch />
                </div>
              </header>
              <main id="main" tabIndex={-1} className="@container gutter page-width flex-1 pb-8 pt-(--space) focus:outline-none lg:px-10">
                {children}
                <p className="mt-10 text-sm text-muted-foreground lg:hidden">
                  Demo data only: a fictional card, not a real account. Capital for Everyone is an independent hackathon concept, not an official Capital One product.
                </p>
              </main>
            </div>
            <AppNav />
          </div>
        </StylePreviewProvider>
      </AskDialProvider>
      </DialSessionProvider>
      </GoalsProvider>
      </ProfileProvider>
    </PersonalisationProvider>
  );
}
