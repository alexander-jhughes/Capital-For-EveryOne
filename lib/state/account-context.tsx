"use client";

import { createContext, useContext, useState } from "react";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "@/lib/data/seed";
import { RESET_SPEND_PAUSE } from "@/lib/demo-config";
import type { Account, SpendPauseSettings, Transaction } from "@/lib/types";

interface AccountState {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
}

const AccountContext = createContext<AccountState | null>(null);

/** The one account every screen reads. Starts from the seed; Stage 6 adds payments, purchases and saved settings. */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [state] = useState<AccountState>({ account: SEED_ACCOUNT, transactions: SEED_TRANSACTIONS, settings: RESET_SPEND_PAUSE });
  return <AccountContext.Provider value={state}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
