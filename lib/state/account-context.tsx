"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { INITIAL_SPEND_PAUSE } from "@/lib/demo-config";
import { evaluatePurchase } from "@/lib/finance";
import { recordPayment, type PaymentResult } from "@/lib/payments/rules";
import { paymentStore, readPayments, writePayments } from "@/lib/payments/storage";
import { initialSpendPauseState, spendPauseReducer, type PauseOutcome, type PauseRecord, type SpendPauseActivity } from "@/lib/spend-pause/state";
import { browserStore, readActivity, readSession, readSettings, writeActivity, writeSession, writeSettings } from "@/lib/spend-pause/storage";
import { toClientState, type ClientState } from "@/lib/assistant/client-state";
import { accountWithPurchases, deriveAccount } from "@/lib/state/derive-account";
import type { Account, PauseDecision, Payment, PendingPurchase, Pence, SpendPauseSettings, Transaction } from "@/lib/types";

interface AccountState {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
  /** When Spend Pause was last turned on and off. */
  spendPauseActivity: SpendPauseActivity;
  /** What has happened since the seed, for Dial's backend. See docs/SPEND-PAUSE.md. */
  dialState: ClientState;
  /** False until saved state has been read. Show a loading state rather than seed figures or defaults. */
  ready: boolean;
  /** Payments made this session, oldest first. */
  payments: Payment[];
  /** False if payments can't be saved here, so they only last until the page reloads. */
  paymentsSaved: boolean;
  /** Safe to repeat: the same `id` can only ever be paid once. */
  makePayment: (amount: Pence, kind: Payment["kind"], id: string) => PaymentResult;
  /** Removes a payment made this session. Every figure goes back, because nothing else was stored. */
  undoPayment: (id: string) => void;
  /** False if settings can't be saved here, so they only last until the app closes. */
  settingsSaved: boolean;
  updateSettings: (next: SpendPauseSettings) => void;
  /** Runs evaluatePurchase and holds the purchase for an answer. If one is already held, that one's decision is returned. */
  addPendingPurchase: (purchase: PendingPurchase) => PauseDecision;
  /** "go" adds it as a pending transaction. "cancel" changes nothing but the session history. */
  resolvePurchase: (id: string, outcome: PauseOutcome) => void;
  pendingPurchase: PendingPurchase | null;
  pauseHistory: PauseRecord[];
}

const AccountContext = createContext<AccountState | null>(null);

/** The one account every screen reads. Worked out from the seed and what has happened since; never stored as figures. */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [pause, dispatch] = useReducer(spendPauseReducer, INITIAL_SPEND_PAUSE, initialSpendPauseState);
  const [ready, setReady] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const skipFirstSave = useRef(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsSaved, setPaymentsSaved] = useState(true);
  // Read by makePayment, so a second tap sees the first before React has rendered it.
  const latestPayments = useRef<Payment[]>([]);

  // Storage only exists in the browser, so this runs after the server-rendered first paint.
  useEffect(() => {
    const saved = browserStore("localStorage");
    const session = readSession(browserStore("sessionStorage"));
    dispatch({ type: "restore", settings: readSettings(saved), activity: readActivity(saved), session });
    // Checked against the balance with the saved purchases in it: a payment can cover those too.
    const paid = readPayments(paymentStore(), accountWithPurchases(session?.purchases ?? []));
    latestPayments.current = paid;
    setPayments(paid);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    const saved = browserStore("localStorage");
    setSettingsSaved(writeSettings(saved, pause.settings) && writeActivity(saved, pause.activity));
    const { pendingPurchase, pendingChecked, purchases, history } = pause;
    writeSession(browserStore("sessionStorage"), { pendingPurchase, pendingChecked, purchases, history });
  }, [pause, ready]);

  const base = useMemo(() => accountWithPurchases(pause.purchases), [pause.purchases]);
  const { account, transactions } = useMemo(() => deriveAccount(pause.purchases, payments), [pause.purchases, payments]);

  const updatePayments = useCallback((next: Payment[]) => {
    latestPayments.current = next;
    setPayments(next);
    setPaymentsSaved(writePayments(paymentStore(), next));
  }, []);
  const makePayment = useCallback(
    (amount: Pence, kind: Payment["kind"], id: string) => {
      const result = recordPayment(latestPayments.current, base, { id, amount, kind, date: DEMO_TODAY });
      if (result.ok && !result.repeat) updatePayments(result.payments);
      return result;
    },
    [base, updatePayments],
  );
  const undoPayment = useCallback(
    (id: string) => {
      if (latestPayments.current.some((p) => p.id === id)) updatePayments(latestPayments.current.filter((p) => p.id !== id));
    },
    [updatePayments],
  );

  const updateSettings = useCallback((settings: SpendPauseSettings) => dispatch({ type: "update-settings", settings, at: DEMO_NOW.toISOString() }), []);
  const resolvePurchase = useCallback((id: string, outcome: PauseOutcome) => dispatch({ type: "resolve-purchase", id, outcome }), []);
  const addPendingPurchase = useCallback(
    (purchase: PendingPurchase) => {
      const held = pause.pendingPurchase ?? purchase;
      const decision = evaluatePurchase(account, transactions, pause.settings, held, DEMO_NOW);
      dispatch({ type: "hold-purchase", purchase, checked: decision.shouldPause });
      return decision;
    },
    [account, transactions, pause.settings, pause.pendingPurchase],
  );

  const dialState = useMemo(() => toClientState({ settings: pause.settings, activity: pause.activity, purchases: pause.purchases, payments }), [pause.settings, pause.activity, pause.purchases, payments]);

  const value = useMemo(
    () => ({
      account,
      transactions,
      settings: pause.settings,
      spendPauseActivity: pause.activity,
      dialState,
      ready,
      payments,
      paymentsSaved,
      makePayment,
      undoPayment,
      settingsSaved,
      updateSettings,
      addPendingPurchase,
      resolvePurchase,
      pendingPurchase: pause.pendingPurchase,
      pauseHistory: pause.history,
    }),
    [account, transactions, pause.settings, pause.activity, dialState, pause.pendingPurchase, pause.history, ready, payments, paymentsSaved, makePayment, undoPayment, settingsSaved, updateSettings, addPendingPurchase, resolvePurchase],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
