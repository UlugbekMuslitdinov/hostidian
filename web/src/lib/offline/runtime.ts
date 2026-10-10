import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { persistQueryClientSave, type PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import type { Me } from "@hostidian/api-types";
import type { Middleware } from "openapi-fetch";
import { api as defaultApi } from "../api/client";
import { qk } from "../api/keys";
import { createQueryClient } from "../query/client";
import { setupMutationDefaults } from "../query/mutations";
import { registerLogoutCleanup } from "../session-cleanup";
import { clearOfflineData, type CleanupDeps, type CleanupReport } from "./cleanup";
import { createConnectivityMonitor, type ConnectivityEnv, type ConnectivityMonitor } from "./connectivity";
import { connectivityStore } from "./connectivity-store";
import { OFFLINE_KEYS } from "./keys";
import {
  PERSIST_BUSTER,
  PERSIST_MAX_AGE_MS,
  createIdbKeyValueStore,
  createOfflinePersister,
  dehydrateOptions,
  type KeyValueStore,
  type OfflinePersister,
} from "./persister";
import { createSyncMonitor, type SyncMonitor } from "./sync-status";
import { createUserScope, type UserScope } from "./user-scope";

/**
 * Everything the offline layer owns, assembled in one place so the provider, the auth gate and the tests all
 * see the same wiring:
 *
 *   query cache <-> IndexedDB (persister, per-user namespace, buster)      queued mutations survive reloads
 *   connectivity monitor -> TanStack onlineManager                          pause / resume queries and mutations
 *   API middleware -> monitor                                              transport failures flip us offline
 *   identify(me)                                                           another account => wipe the device
 *   logout cleanup                                                         wipe the device on explicit logout
 */

export type IdentityDecision =
  /** The cached data already belongs to this user. */
  | "same"
  /** Nothing is cached for anyone: this user becomes the owner of the device's offline data. */
  | "adopt"
  /** Somebody else's data is cached: it must be wiped before this user sees anything. */
  | "switch";

/** Whose data is on the device versus who just signed in. Pure. */
export function decideIdentity(cachedUserId: string | null, signedInUserId: string): IdentityDecision {
  if (cachedUserId === null) return "adopt";
  return cachedUserId === signedInUserId ? "same" : "switch";
}

export interface OfflineRuntimeOptions {
  queryClient?: QueryClient;
  store?: KeyValueStore;
  scope?: UserScope;
  /** Test seam for the connectivity monitor's browser bindings. */
  connectivityEnv?: Partial<ConnectivityEnv>;
  /** Test seam for IndexedDB / CacheStorage / localStorage used by the wipe. */
  cleanupDeps?: CleanupDeps;
  /** The API client whose transport errors feed the monitor. */
  api?: { use(...middleware: Middleware[]): void; eject(...middleware: Middleware[]): void };
  /** Test seam: skip registering the logout hook / cross-tab listener. */
  window?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

export interface OfflineRuntime {
  readonly queryClient: QueryClient;
  readonly store: KeyValueStore;
  readonly persister: OfflinePersister;
  readonly scope: UserScope;
  readonly sync: SyncMonitor;
  readonly persistOptions: Omit<PersistQueryClientOptions, "queryClient">;
  /** When this runtime was created (ms since epoch): cached data older than this came from a previous session. */
  readonly startedAt: number;
  /** The monitor, available after `start()`. */
  readonly connectivity: ConnectivityMonitor | null;
  /** Synchronous verdict used to decide whether children may render before {@link identify} finishes. */
  peekIdentity(userId: string): IdentityDecision;
  /** Make `me` the owner of the device's offline data, wiping another user's first. */
  identify(me: Me): Promise<IdentityDecision>;
  /** Wipe the offline data of the signed-in user (explicit logout). */
  wipeForLogout(): Promise<CleanupReport>;
  /** "Retry" in the indicator: re-probe the server, replay queued changes, refetch what is on screen. */
  retrySync(): Promise<void>;
  /** Start monitoring; returns the stop function. Idempotent per call pair (StrictMode safe). */
  start(): () => void;
}

export function createOfflineRuntime(options: OfflineRuntimeOptions = {}): OfflineRuntime {
  const queryClient =
    options.queryClient ??
    (() => {
      const qc = createQueryClient();
      // Must be registered before any mutation is created *or restored* from storage.
      setupMutationDefaults(qc);
      return qc;
    })();
  const store = options.store ?? createIdbKeyValueStore();
  const scope = options.scope ?? createUserScope();
  const persister = createOfflinePersister({ store, getUserId: () => scope.get() });
  const sync = createSyncMonitor(queryClient);
  const api = options.api ?? defaultApi;

  // Until the monitor runs, trust the browser: a cold start without a network must not look "online".
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    onlineManager.setOnline(false);
    connectivityStore.set({ online: false });
  }

  const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
    persister,
    maxAge: PERSIST_MAX_AGE_MS,
    buster: PERSIST_BUSTER,
    dehydrateOptions,
  };

  let monitor: ConnectivityMonitor | null = null;
  const identifying = new Map<string, Promise<IdentityDecision>>();

  const wipe = (extra: { resetQueryClient?: boolean; keepQueries?: { queryKey: readonly unknown[]; data: unknown }[] } = {}) =>
    clearOfflineData({ store, persister, scope, queryClient, deps: options.cleanupDeps, ...extra });

  const middleware: Middleware = {
    onResponse({ response }) {
      // Gateway errors mean the app server is down behind a live proxy: that is "offline" for our purposes.
      if (response.status >= 502 && response.status <= 504) monitor?.reportFailure();
      else monitor?.reportSuccess();
    },
    onError({ error }) {
      // Deliberate aborts (query cancellation) say nothing about the network.
      if (!(error instanceof DOMException && error.name === "AbortError")) monitor?.reportFailure();
    },
  };

  const startedAt = Date.now();
  const runtime: OfflineRuntime = {
    startedAt,
    queryClient,
    store,
    persister,
    scope,
    sync,
    persistOptions,
    get connectivity() {
      return monitor;
    },

    peekIdentity: (userId) => decideIdentity(scope.get(), userId),

    identify(me) {
      const userId = me.user.id;
      // React StrictMode (and a re-render during the wipe) can ask twice; the wipe must run once.
      const running = identifying.get(userId);
      if (running) return running;

      const job = (async (): Promise<IdentityDecision> => {
        const decision = decideIdentity(scope.get(), userId);
        if (decision === "same") return decision;

        if (decision === "switch") {
          // Another account's titles, pages and queued edits must be gone before this one renders.
          await wipe({ resetQueryClient: true, keepQueries: [{ queryKey: qk.me(), data: me }] });
        } else {
          // Nobody owned the cache; drop leftovers of accounts that were never cleaned up properly.
          await store.clear().catch(() => undefined);
        }
        scope.set(userId);
        // Persist what is already in memory (the identity itself) without waiting for the next cache event.
        await persistQueryClientSave({ queryClient, ...persistOptions }).catch(() => undefined);
        await persister.flush().catch(() => undefined);
        return decision;
      })().finally(() => identifying.delete(userId));
      identifying.set(userId, job);
      return job;
    },

    wipeForLogout: () => wipe(),

    async retrySync() {
      sync.clearError();
      monitor?.checkNow();
      await queryClient.resumePausedMutations();
      await queryClient.invalidateQueries();
    },

    start() {
      // Our monitor replaces TanStack's default window online/offline listeners: `navigator.onLine` alone is
      // true behind a dead Wi-Fi, which would resume queued mutations into a wall.
      const created = createConnectivityMonitor({
        env: options.connectivityEnv,
        onChange: (online) => {
          connectivityStore.set({ online });
          onlineManager.setOnline(online);
        },
      });
      monitor = created;
      onlineManager.setEventListener(() => () => undefined);
      created.start();
      api.use(middleware);

      const unregisterLogout = registerLogoutCleanup(async () => {
        await runtime.wipeForLogout();
      });

      // Another tab logged out or switched account: stop writing into the old namespace and re-check the session.
      const target = options.window === undefined ? (typeof window === "undefined" ? null : window) : options.window;
      const onStorage = (event: Event) => {
        if ((event as StorageEvent).key !== OFFLINE_KEYS.lastUser) return;
        scope.refresh();
        void queryClient.invalidateQueries({ queryKey: qk.me() });
      };
      target?.addEventListener("storage", onStorage);

      // The persister batches writes; a tab that is going away must not take the last ones with it.
      const flush = () => void persister.flush().catch(() => undefined);
      const onVisibility = () => {
        if (document.visibilityState === "hidden") flush();
      };
      target?.addEventListener("pagehide", flush);
      if (target) document.addEventListener("visibilitychange", onVisibility);

      return () => {
        target?.removeEventListener("storage", onStorage);
        target?.removeEventListener("pagehide", flush);
        if (target) document.removeEventListener("visibilitychange", onVisibility);
        unregisterLogout();
        api.eject(middleware);
        created.stop();
        if (monitor === created) monitor = null;
      };
    },
  };
  return runtime;
}
