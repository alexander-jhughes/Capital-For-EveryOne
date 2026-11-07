import type { Metadata } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { cookies } from "next/headers";
import { Header } from "@/components/header";
import { AnnouncerProvider } from "@/components/live-region";
import { MODE_KEY } from "@/lib/demo-config";
import { ModeProvider } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import "./globals.css";

// Designed by the Braille Institute for low-vision readers.
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-atkinson" });

export const metadata: Metadata = {
  title: { default: "Capital For EveryOne", template: "%s · Capital For EveryOne" },
  description: "Your credit card account, in the view that suits you. Dial: Simple or Complex view.",
};

// Runs before hydration so the page never flashes the wrong mode's sizes.
const noFlash = `try{var m=localStorage.getItem("${MODE_KEY}");if(m==="simple"||m==="complex")document.documentElement.dataset.mode=m}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const saved = (await cookies()).get(MODE_KEY)?.value;
  const mode: Mode = saved === "simple" ? "simple" : "complex";
  return (
    <html lang="en-GB" data-mode={mode} className={atkinson.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body className="antialiased">
        <AnnouncerProvider>
          <ModeProvider initialMode={mode}>
            <Header />
            <main id="main" tabIndex={-1} className="mx-auto max-w-5xl px-4 py-(--space) focus:outline-none">
              {children}
            </main>
          </ModeProvider>
        </AnnouncerProvider>
      </body>
    </html>
  );
}
