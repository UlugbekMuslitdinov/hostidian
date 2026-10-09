"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { Me, User, WorkspaceMembership } from "@hostidian/api-types";
import { api } from "./api/client";
import { unwrapVoid } from "./api/unwrap";
import { runLogoutCleanups } from "./session-cleanup";
import { removeStorage, STORAGE_KEYS } from "./storage";

interface SessionValue {
  user: User;
  workspaces: WorkspaceMembership[];
}

const SessionContext = createContext<SessionValue | null>(null);

// Set while an explicit logout is navigating away, so the gate doesn't append `?next=` to /login.
let intentionalLogout = false;
export function wasIntentionalLogout(): boolean {
  return intentionalLogout;
}

export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const value = useMemo<SessionValue>(() => ({ user: me.user, workspaces: me.workspaces }), [me.user, me.workspaces]);
  useEffect(() => {
    intentionalLogout = false;
  }, []);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside the (app) layout");
  return ctx;
}

export function useLogout() {
  const qc = useQueryClient();
  const router = useRouter();
  return useCallback(async () => {
    intentionalLogout = true;
    try {
      await unwrapVoid(api.POST("/auth/logout"));
    } catch {
      // Even if the request fails (offline), drop local state; the cookie expires server-side.
    }
    await runLogoutCleanups();
    removeStorage(STORAGE_KEYS.lastWorkspace);
    qc.clear();
    router.replace("/login");
  }, [qc, router]);
}
