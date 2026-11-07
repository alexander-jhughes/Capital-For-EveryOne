import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { cookies } from "next/headers";
import { AnnouncerProvider } from "@/components/live-region";
import { MODE_KEY } from "@/lib/demo-config";
import { ModeProvider } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import "./globals.css";

// Designed by the Braille Institute for low-vision readers.
const atkinson = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-atkinson" });

export const metadata: Metadata = {
  title: { default: "Dial", template: "%s · Dial" },
  description: "Your credit card, in the view that suits you: Simple or Complex.",
};

// viewport-fit=cover makes env(safe-area-inset-*) work on notched phones.
export const viewport: Viewport = { viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mode: Mode = (await cookies()).get(MODE_KEY)?.value === "simple" ? "simple" : "complex";
  return (
    <html lang="en-GB" data-mode={mode} className={atkinson.variable}>
      <body className="antialiased sm:bg-secondary">
        <AnnouncerProvider>
          <ModeProvider initialMode={mode}>{children}</ModeProvider>
        </AnnouncerProvider>
      </body>
    </html>
  );
}
