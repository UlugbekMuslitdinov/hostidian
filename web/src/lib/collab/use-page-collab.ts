"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { qk } from "@/lib/api/keys";
import { hasPendingCreate } from "./pending";
import { createPeersStore, EMPTY_PEERS, EMPTY_PEERS_STORE } from "./peers";
import {
  createBrowserDeps,
  createCollabSession,
  type CollabSession,
  type CollabSnapshot,
  type CollabUserInfo,
} from "./session";
import type { PresenceUser } from "@/components/page/presence";

const IDLE_SNAPSHOT: CollabSnapshot = {
  localReady: false,
  contentReady: false,
  connection: "connecting",
  role: null,
  failure: null,
};
const noopSubscribe = () => () => undefined;

/**
 * Owns the collaboration session of one page for the lifetime of the calling component.
 *
 * The session is created in an effect (never during render) so React StrictMode's mount → unmount → mount
 * can't leave a half-built Y.Doc/Awareness behind, and it is destroyed on unmount or page switch.
 */
export function usePageCollab(pageId: string, user: CollabUserInfo) {
  const qc = useQueryClient();
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  });

  const [session, setSession] = useState<CollabSession | null>(null);
  useEffect(() => {
    const created = createCollabSession(
      { pageId, user: userRef.current },
      createBrowserDeps({
        hasPendingCreate: (id) => hasPendingCreate(qc, id),
        // The token endpoint answered 401: let the auth gate re-check the session and redirect to /login.
        onUnauthorized: () => void qc.invalidateQueries({ queryKey: qk.me() }),
      }),
    );
    created.start();
    // Publishing an external object into state is what this effect is for (it owns the object's lifetime).
    setSession(created);
    return () => {
      setSession(null);
      created.destroy();
    };
  }, [pageId, qc]);

  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noopSubscribe,
    session?.getSnapshot ?? (() => IDLE_SNAPSHOT),
    () => IDLE_SNAPSHOT,
  );
  return { session, snapshot };
}

/** Other people currently on the page (excludes the local user), from Yjs awareness. */
export function usePeers(session: CollabSession | null, selfUserId: string): PresenceUser[] {
  const [store, setStore] = useState(EMPTY_PEERS_STORE);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStore(session ? createPeersStore(session.awareness, selfUserId) : EMPTY_PEERS_STORE);
  }, [session, selfUserId]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_PEERS);
}
