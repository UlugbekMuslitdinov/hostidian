import { readStorage, removeStorage, writeStorage } from "@/lib/storage";
import { OFFLINE_KEYS } from "./keys";

/**
 * Which user's data is cached on this device. The id is mirrored to localStorage so a cold (possibly offline)
 * start knows which persisted-cache namespace to restore before `/auth/me` has answered. Falls back to memory
 * when localStorage is unavailable (then nothing survives a reload, which is the safe direction).
 */
export interface UserScope {
  get(): string | null;
  set(userId: string): void;
  clear(): void;
  /** Forget the in-memory copy and re-read localStorage (another tab changed it). */
  refresh(): void;
}

export function createUserScope(): UserScope {
  let memory: string | null | undefined;
  return {
    get() {
      if (memory === undefined) {
        if (typeof window === "undefined") return null; // SSR: nothing to read, and don't cache that
        memory = readStorage(OFFLINE_KEYS.lastUser);
      }
      return memory;
    },
    set(userId) {
      memory = userId;
      writeStorage(OFFLINE_KEYS.lastUser, userId);
    },
    clear() {
      memory = null;
      removeStorage(OFFLINE_KEYS.lastUser);
    },
    refresh() {
      memory = undefined;
    },
  };
}
