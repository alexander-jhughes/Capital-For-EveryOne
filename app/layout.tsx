import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next } from "next/font/google";
import { cookies } from "next/headers";
import { AnnouncerProvider } from "@/components/live-region";
import { MODE_KEY } from "@/lib/demo-config";
import { PreferencesProvider } from "@/lib/preferences/provider";
import { decodePrefs, prefAttributes, PREFS_COOKIE } from "@/lib/preferences/schema";
import { AccountProvider } from "@/lib/state/account-context";
import { ModeProvider } from "@/lib/state/mode-context";
import type { Mode } from "@/lib/types";
import "./globals.css";

// Designed by the Braille Institute for low-vision readers. Variable weight for a real type hierarchy.
const atkinson = Atkinson_Hyperlegible_Next({ subsets: ["latin"], variable: "--font-atkinson", adjustFontFallback: false });

export const metadata: Metadata = {
  title: { default: "Capital for Everyone", template: "%s · Capital for Everyone" },
  description:
    "Credit, made accessible. An independent hackathon concept with Dial, a voice assistant that can reshape the interface. Not an official Capital One product.",
};

// viewport-fit=cover makes env(safe-area-inset-*) work on notched phones.
export const viewport: Viewport = { viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const mode: Mode = jar.get(MODE_KEY)?.value === "simple" ? "simple" : "complex";
  // Saved preferences are applied on the server, so a saved look never flashes on load.
  const prefs = decodePrefs(jar.get(PREFS_COOKIE)?.value);
  return (
    <html lang="en-GB" data-mode={mode} {...prefAttributes(prefs)} className={atkinson.variable}>
      <body className="antialiased">
        <AnnouncerProvider>
          <ModeProvider initialMode={mode}>
            <PreferencesProvider initial={prefs}>
              <AccountProvider>{children}</AccountProvider>
            </PreferencesProvider>
          </ModeProvider>
        </AnnouncerProvider>
      </body>
    </html>
  );
}
