"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { connectivityStore } from "./connectivity-store";
import { installServerSnapshot, installStore, type InstallSnapshot } from "./install";
import { persistStatus, type PersistStatus } from "./persister";
import type { OfflineRuntime } from "./runtime";
import { deriveSyncKind, type SyncKind, type SyncSnapshot } from "./sync-status";

const RuntimeContext = createContext<OfflineRuntime | null>(null);

export function OfflineRuntimeProvider({ runtime, children }: { runtime: OfflineRuntime; children: ReactNode }) {
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

/** The runtime, or null when rendered outside the provider (isolated component tests, error boundaries). */
export function useOptionalOfflineRuntime(): OfflineRuntime | null {
  return useContext(RuntimeContext);
}

export function useOfflineRuntime(): OfflineRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useOfflineRuntime must be used inside <QueryProvider>");
  return runtime;
}

const serverOnline = () => true;

/** Effective connectivity: the browser is online AND the server answers. */
export function useOnline(): boolean {
  return useSyncExternalStore(connectivityStore.subscribe, () => connectivityStore.get().online, serverOnline);
}

const EMPTY_SYNC: SyncSnapshot = { pending: 0, error: null };
const emptySync = () => EMPTY_SYNC;
const noSubscribe = () => () => undefined;

export interface SyncState {
  kind: SyncKind;
  pending: number;
  error: SyncSnapshot["error"];
}

/** Online / offline / syncing / error, plus how many changes are queued. */
export function useSyncState(): SyncState {
  const runtime = useOptionalOfflineRuntime();
  const online = useOnline();
  const snapshot = useSyncExternalStore(
    runtime?.sync.store.subscribe ?? noSubscribe,
    runtime?.sync.store.get ?? emptySync,
    emptySync,
  );
  return { kind: deriveSyncKind({ online, pending: snapshot.pending, error: snapshot.error }), pending: snapshot.pending, error: snapshot.error };
}

const serverPersist: PersistStatus = { state: "ok" };

/** Whether the offline cache is actually being written (full disk, blocked storage). */
export function usePersistStatus(): PersistStatus {
  return useSyncExternalStore(persistStatus.subscribe, persistStatus.get, () => serverPersist);
}

export function useInstallSnapshot(): InstallSnapshot {
  return useSyncExternalStore(installStore.subscribe, installStore.get, installServerSnapshot);
}
