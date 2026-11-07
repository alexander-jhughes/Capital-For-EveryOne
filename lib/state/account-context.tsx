"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "@/lib/data/seed";
import { DEMO_TODAY } from "@/lib/demo-clock";
import { RESET_SPEND_PAUSE } from "@/lib/demo-config";
import { accountAfterPayments, paymentTransaction, recordPayment, type PaymentResult } from "@/lib/payments/rules";
import { paymentStore, readPayments, writePayments } from "@/lib/payments/storage";
import type { Account, Payment, Pence, SpendPauseSettings, Transaction } from "@/lib/types";

interface AccountState {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
  /** False until saved state has been read. Show a loading state rather than seed figures. */
  ready: boolean;
  /** Payments made this session, oldest first. */
  payments: Payment[];
  /** False if payments can't be saved here, so they only last until the page reloads. */
  paymentsSaved: boolean;
  /** Safe to repeat: the same `id` can only ever be paid once. */
  makePayment: (amount: Pence, kind: Payment["kind"], id: string) => PaymentResult;
  /** Removes a payment made this session. Every figure goes back, because nothing else was stored. */
  undoPayment: (id: string) => void;
}

const AccountContext = createContext<AccountState | null>(null);

/** The one account every screen reads. Worked out from the seed and what has happened since; never stored as figures. */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [ready, setReady] = useState(false);
  const [paymentsSaved, setPaymentsSaved] = useState(true);
  // Read by makePayment, so a second tap sees the first before React has rendered it.
  const latest = useRef<Payment[]>([]);

  const update = useCallback((next: Payment[]) => {
    latest.current = next;
    setPayments(next);
    setPaymentsSaved(writePayments(paymentStore(), next));
  }, []);

  // Storage only exists in the browser, so this runs after the server-rendered first paint.
  useEffect(() => {
    const saved = readPayments(paymentStore(), SEED_ACCOUNT);
    latest.current = saved;
    setPayments(saved);
    setReady(true);
  }, []);

  const makePayment = useCallback(
    (amount: Pence, kind: Payment["kind"], id: string) => {
      const result = recordPayment(latest.current, SEED_ACCOUNT, { id, amount, kind, date: DEMO_TODAY });
      if (result.ok && !result.repeat) update(result.payments);
      return result;
    },
    [update],
  );

  const undoPayment = useCallback(
    (id: string) => {
      if (latest.current.some((p) => p.id === id)) update(latest.current.filter((p) => p.id !== id));
    },
    [update],
  );

  const value = useMemo(
    () => ({
      account: accountAfterPayments(SEED_ACCOUNT, payments),
      transactions: [...SEED_TRANSACTIONS, ...payments.map(paymentTransaction)],
      settings: RESET_SPEND_PAUSE,
      ready,
      payments,
      paymentsSaved,
      makePayment,
      undoPayment,
    }),
    [payments, ready, paymentsSaved, makePayment, undoPayment],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
