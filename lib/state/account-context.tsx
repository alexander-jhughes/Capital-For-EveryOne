"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SEED_ACCOUNT, SEED_TRANSACTIONS } from "@/lib/data/seed";
import { DEMO_NOW } from "@/lib/demo-clock";
import { INITIAL_SPEND_PAUSE } from "@/lib/demo-config";
import { evaluatePurchase } from "@/lib/finance";
import { initialSpendPauseState, purchasesTotal, spendPauseReducer, type PauseOutcome, type PauseRecord, type SpendPauseActivity } from "@/lib/spend-pause/state";
import { browserStore, readActivity, readSession, readSettings, writeActivity, writeSession, writeSettings } from "@/lib/spend-pause/storage";
import { toClientState, type ClientState } from "@/lib/assistant/client-state";
import type { Account, PauseDecision, PendingPurchase, SpendPauseSettings, Transaction } from "@/lib/types";

interface AccountState {
  account: Account;
  transactions: Transaction[];
  settings: SpendPauseSettings;
  /** When Spend Pause was last turned on and off. */
  spendPauseActivity: SpendPauseActivity;
  /** What has happened since the seed, for Dial's backend. See docs/SPEND-PAUSE.md. */
  dialState: ClientState;
  /** False until saved settings have been read. Show a loading state rather than the defaults. */
  ready: boolean;
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

/** The one account every screen reads. Starts from the seed; Stage 6 adds payments, purchases and saved settings. */
export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [pause, dispatch] = useReducer(spendPauseReducer, INITIAL_SPEND_PAUSE, initialSpendPauseState);
  const [ready, setReady] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const skipFirstSave = useRef(true);

  // Storage only exists in the browser, so this runs after the server-rendered first paint.
  useEffect(() => {
    const saved = browserStore("localStorage");
    dispatch({ type: "restore", settings: readSettings(saved), activity: readActivity(saved), session: readSession(browserStore("sessionStorage")) });
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

  const account = useMemo(
    // evaluatePurchase promises this balance before the person decides, so an approved purchase has to deliver it.
    () => ({ ...SEED_ACCOUNT, currentBalance: SEED_ACCOUNT.currentBalance + purchasesTotal(pause.purchases) }),
    [pause.purchases],
  );
  const transactions = useMemo(() => [...SEED_TRANSACTIONS, ...pause.purchases], [pause.purchases]);

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

  const dialState = useMemo(() => toClientState({ settings: pause.settings, activity: pause.activity, purchases: pause.purchases }), [pause.settings, pause.activity, pause.purchases]);

  const value = useMemo(
    () => ({
      account,
      transactions,
      settings: pause.settings,
      spendPauseActivity: pause.activity,
      dialState,
      ready,
      settingsSaved,
      updateSettings,
      addPendingPurchase,
      resolvePurchase,
      pendingPurchase: pause.pendingPurchase,
      pauseHistory: pause.history,
    }),
    [account, transactions, pause.settings, pause.activity, dialState, pause.pendingPurchase, pause.history, ready, settingsSaved, updateSettings, addPendingPurchase, resolvePurchase],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const ctx = useContext(AccountContext);
  if (!ctx) throw new Error("useAccount must be used inside AccountProvider");
  return ctx;
}
