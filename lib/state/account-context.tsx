"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEMO_NOW, DEMO_TODAY } from "@/lib/demo-clock";
import { INITIAL_SPEND_PAUSE } from "@/lib/demo-config";
import { evaluatePurchase } from "@/lib/finance";
import { recordPayment, type PaymentResult } from "@/lib/payments/rules";
import type { AccountStateBody } from "@/lib/server/account";
import { initialSpendPauseState, spendPauseReducer, type PauseOutcome, type PauseRecord, type SpendPauseActivity } from "@/lib/spend-pause/state";
import { browserStore, readSession, writeSession } from "@/lib/spend-pause/storage";
import { accountWithPurchases, deriveAccount } from "@/lib/state/derive-account";
import type { Account, PauseDecision, Payment, PendingPurchase, Pence, SpendPauseSettings, Transaction } from "@/lib/types";
import { accountApi, type ApiResult } from "./account-api";

interface AccountState {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
  /** When Spend Pause was last turned on and off. */
  spendPauseActivity: SpendPauseActivity;
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

/**
 * The one account every screen reads. The server keeps what has happened (payments, approved purchases, Spend Pause
 * choices) in a signed session and works every figure out from the seed; this provider mirrors it. Each change is
 * applied here first, so the screen answers at once, then sent to the server, whose reply replaces the local copy.
 * The purchase waiting for an answer and the session's history are only this tab's business, so they stay in sessionStorage.
 */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [pause, dispatch] = useReducer(spendPauseReducer, INITIAL_SPEND_PAUSE, initialSpendPauseState);
  const [ready, setReady] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [paymentsSaved, setPaymentsSaved] = useState(true);
  // Read by makePayment and resolvePurchase, so a second tap sees the first before React has rendered it.
  const latestPayments = useRef<Payment[]>([]);
  const latestPending = useRef<PendingPurchase | null>(null);
  latestPending.current = pause.pendingPurchase;
  // Only the newest server reply counts, so a slow reply to an earlier change can't undo a later one.
  const changes = useRef(0);

  const applyServer = useCallback((state: AccountStateBody) => {
    latestPayments.current = state.payments;
    setPayments(state.payments);
    dispatch({ type: "restore", settings: state.settings, activity: state.spendPauseActivity, session: { purchases: state.purchases } });
    setPaymentsSaved(true);
    setSettingsSaved(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Storage only exists in the browser, so this runs after the server-rendered first paint.
    const saved = readSession(browserStore("sessionStorage"));
    const transient = saved ? { pendingPurchase: saved.pendingPurchase, pendingChecked: saved.pendingChecked, history: saved.history } : {};
    accountApi.load().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        latestPayments.current = result.state.payments;
        setPayments(result.state.payments);
        dispatch({ type: "restore", settings: result.state.settings, activity: result.state.spendPauseActivity, session: { ...transient, purchases: result.state.purchases } });
      } else {
        // No server: the seed, with every screen saying changes won't be kept.
        dispatch({ type: "restore", session: transient });
        setPaymentsSaved(false);
        setSettingsSaved(false);
      }
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const { pendingPurchase, pendingChecked, purchases, history } = pause;
    writeSession(browserStore("sessionStorage"), { pendingPurchase, pendingChecked, purchases, history });
  }, [pause, ready]);

  /** Sends one change. If the server refuses or can't be reached, its account replaces the local guess, or the screen is told nothing is being kept. */
  const sync = useCallback(
    (send: () => Promise<ApiResult>, unsaved: () => void) => {
      const mine = ++changes.current;
      send().then(async (result) => {
        if (result.ok) {
          if (mine === changes.current) applyServer(result.state);
          return;
        }
        const fresh = result.status === 0 ? result : await accountApi.load();
        if (mine !== changes.current) return;
        if (fresh.ok) applyServer(fresh.state);
        else unsaved();
      });
    },
    [applyServer],
  );

  const base = useMemo(() => accountWithPurchases(pause.purchases), [pause.purchases]);
  const { account, transactions } = useMemo(() => deriveAccount(pause.purchases, payments), [pause.purchases, payments]);

  const updatePayments = useCallback((next: Payment[]) => {
    latestPayments.current = next;
    setPayments(next);
  }, []);
  const paymentsUnsaved = useCallback(() => setPaymentsSaved(false), []);
  const makePayment = useCallback(
    (amount: Pence, kind: Payment["kind"], id: string) => {
      const result = recordPayment(latestPayments.current, base, { id, amount, kind, date: DEMO_TODAY });
      if (result.ok && !result.repeat) {
        updatePayments(result.payments);
        sync(() => accountApi.pay({ id, amount, kind }), paymentsUnsaved);
      }
      return result;
    },
    [base, updatePayments, sync, paymentsUnsaved],
  );
  const undoPayment = useCallback(
    (id: string) => {
      if (!latestPayments.current.some((p) => p.id === id)) return;
      updatePayments(latestPayments.current.filter((p) => p.id !== id));
      sync(() => accountApi.undo(id), paymentsUnsaved);
    },
    [updatePayments, sync, paymentsUnsaved],
  );

  const settingsUnsaved = useCallback(() => setSettingsSaved(false), []);
  const updateSettings = useCallback(
    (settings: SpendPauseSettings) => {
      dispatch({ type: "update-settings", settings, at: DEMO_NOW.toISOString() });
      sync(() => accountApi.settings(settings), settingsUnsaved);
    },
    [sync, settingsUnsaved],
  );
  const resolvePurchase = useCallback(
    (id: string, outcome: PauseOutcome) => {
      const held = latestPending.current;
      dispatch({ type: "resolve-purchase", id, outcome });
      if (outcome === "go" && held?.id === id) sync(() => accountApi.purchase(held), paymentsUnsaved);
    },
    [sync, paymentsUnsaved],
  );
  const addPendingPurchase = useCallback(
    (purchase: PendingPurchase) => {
      const held = pause.pendingPurchase ?? purchase;
      const decision = evaluatePurchase(account, transactions, pause.settings, held, DEMO_NOW);
      dispatch({ type: "hold-purchase", purchase, checked: decision.shouldPause });
      return decision;
    },
    [account, transactions, pause.settings, pause.pendingPurchase],
  );

  const value = useMemo(
    () => ({
      account,
      transactions,
      settings: pause.settings,
      spendPauseActivity: pause.activity,
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
    [account, transactions, pause.settings, pause.activity, pause.pendingPurchase, pause.history, ready, payments, paymentsSaved, makePayment, undoPayment, settingsSaved, updateSettings, addPendingPurchase, resolvePurchase],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
