import type { KeyValueStore } from "./persister";

/** In-memory {@link KeyValueStore} with optional failure injection (tests only). */
export function createMemoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const store = {
    data,
    failSetWith: undefined as unknown,
    failSetTimes: 0,
    sets: [] as string[],
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key: string, value: unknown) {
      if (store.failSetTimes > 0) {
        store.failSetTimes -= 1;
        throw store.failSetWith;
      }
      store.sets.push(key);
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async clear() {
      data.clear();
    },
  };
  return store satisfies KeyValueStore & Record<string, unknown>;
}

export class QuotaError extends Error {
  constructor() {
    super("The quota has been exceeded.");
    this.name = "QuotaExceededError";
  }
}
