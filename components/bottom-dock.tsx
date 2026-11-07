"use client";

import { MessageCircleQuestion } from "lucide-react";
import { usePathname } from "next/navigation";
import { useAskDial } from "./assistant/ask-dial";
import { TabBar } from "./tab-bar";

/** Ask Dial bar above the tab bar. Sticky only on screens tall enough; at 400% zoom it scrolls with the page. */
export function BottomDock() {
  const path = usePathname();
  const { openAsk } = useAskDial();
  if (!path.startsWith("/account")) return null; // no account UI before sign-in

  return (
    <div className="z-40 [@media(min-height:480px)]:sticky [@media(min-height:480px)]:bottom-0">
      <div className="gutter border-t-2 bg-card py-2">
        <button
          type="button"
          onClick={() => openAsk()}
          aria-haspopup="dialog"
          className="flex min-h-(--target-min) w-full items-center gap-2 rounded-full border-2 border-input bg-background px-4 text-left font-bold"
        >
          <MessageCircleQuestion aria-hidden className="size-[1.3em] shrink-0" />
          Ask Dial about your money
        </button>
      </div>
      <TabBar />
    </div>
  );
}
