// localStorage can throw (private mode, blocked site data, SSR). Every access goes through here.

export const STORAGE_KEYS = {
  lastWorkspace: "hostidian:lastWorkspace",
  sidebarOpen: "hostidian:sidebarOpen",
  recentPages: (workspaceId: string) => `hostidian:recent:${workspaceId}`,
  treeExpanded: (userId: string, workspaceId: string) => `hostidian:tree:${userId}:${workspaceId}`,
  sectionsCollapsed: (userId: string) => `hostidian:sections:${userId}`,
} as const;

export function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  } catch {
    // ignore: persistence is best effort
  }
}

export function removeStorage(key: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function readJSON<T>(key: string, fallback: T): T {
  const raw = readStorage(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    writeStorage(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export function readStringArray(key: string): string[] {
  const value = readJSON<unknown>(key, []);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
