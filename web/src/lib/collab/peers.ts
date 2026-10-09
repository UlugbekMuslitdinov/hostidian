import type { Awareness } from "y-protocols/awareness";
import type { PresenceUser } from "@/components/page/presence";
import { presenceFromStates } from "./awareness";

export interface PeersStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PresenceUser[];
}

export const EMPTY_PEERS: PresenceUser[] = [];
export const EMPTY_PEERS_STORE: PeersStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => EMPTY_PEERS,
};

const sameUsers = (a: PresenceUser[], b: PresenceUser[]) =>
  a.length === b.length && a.every((u, i) => u.id === b[i]!.id && u.name === b[i]!.name && u.color === b[i]!.color);

/**
 * `useSyncExternalStore` source for "who else is on this page". Awareness fires `change` on every cursor
 * move, so the snapshot only changes identity when the set of people (or their names/colours) does.
 */
export function createPeersStore(awareness: Awareness, selfUserId: string): PeersStore {
  let snapshot: PresenceUser[] = EMPTY_PEERS;
  const recompute = () => {
    const next = presenceFromStates(awareness.getStates() as Map<number, Record<string, unknown>>, awareness.clientID, selfUserId);
    if (!sameUsers(snapshot, next)) snapshot = next.length === 0 ? EMPTY_PEERS : next;
  };
  recompute();
  return {
    subscribe(listener) {
      const handler = () => {
        recompute();
        listener();
      };
      awareness.on("change", handler);
      return () => awareness.off("change", handler);
    },
    getSnapshot: () => snapshot,
  };
}
