"use client";

import { useMode } from "@/lib/state/mode-context";

/** The one place a page's content differs by mode. Only the chosen tree is mounted. */
export function ModeView({ simple, complex }: { simple: React.ReactNode; complex: React.ReactNode }) {
  return <>{useMode().mode === "simple" ? simple : complex}</>;
}
