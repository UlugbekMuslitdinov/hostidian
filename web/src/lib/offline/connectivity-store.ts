import { createStore } from "./store";

/**
 * The *effective* connectivity (browser says online AND the server answers), as maintained by the monitor in
 * connectivity.ts. Module-level so non-React code (prefetcher, collab) and hooks read the same value.
 * Starts as "online": during SSR and the first client render there is nothing to report yet.
 */
export interface ConnectivityState {
  online: boolean;
}

export const connectivityStore = createStore<ConnectivityState>({ online: true });
