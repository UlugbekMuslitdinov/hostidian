"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { UserAvatar } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Presence is a one-way pipe: the editor (wave 2) reads Yjs awareness and calls
 * `usePublishPresence(users)`; the page header renders whatever was published via <PresenceStack/>.
 * Nothing here knows about Yjs.
 */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

interface PresenceContextValue {
  users: PresenceUser[];
  publish: (users: PresenceUser[]) => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  // Stable identity: publishers list it as an effect dependency, so it must not change with `users`.
  const publish = useCallback(
    (next: PresenceUser[]) => setUsers((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
    [],
  );
  const value = useMemo<PresenceContextValue>(() => ({ users, publish }), [users, publish]);
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

/** Users currently viewing the page (excluding the local user, by convention). */
export function usePresence(): PresenceUser[] {
  return useContext(PresenceContext)?.users ?? [];
}

/** For the editor: publish the awareness users; cleared on unmount. */
export function usePublishPresence(users: PresenceUser[]): void {
  const ctx = useContext(PresenceContext);
  const publish = ctx?.publish;
  const serialized = JSON.stringify(users);
  useEffect(() => {
    publish?.(JSON.parse(serialized) as PresenceUser[]);
    return () => publish?.([]);
  }, [publish, serialized]);
}

export function PresenceStack({ users, max = 4 }: { users: PresenceUser[]; max?: number }) {
  if (users.length === 0) return null;
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <ul
      className="flex items-center -space-x-1.5"
      aria-label={`${users.length} other ${users.length === 1 ? "person" : "people"} here`}
    >
      {shown.map((user) => (
        <li key={user.id}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block rounded-full ring-2 ring-background">
                <UserAvatar name={user.name} color={user.color} className="size-6 text-[11px]" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{user.name}</TooltipContent>
          </Tooltip>
        </li>
      ))}
      {extra > 0 && (
        <li className="relative z-10 grid size-6 place-items-center rounded-full bg-secondary text-[11px] font-medium ring-2 ring-background">
          +{extra}
        </li>
      )}
    </ul>
  );
}
