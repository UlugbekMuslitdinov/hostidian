import { describe, expect, it, vi } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createPeersStore } from "./peers";

/** A second client's awareness state, delivered the way the provider would. */
function remote(local: Awareness, user: { id: string; name: string; color: string } | null) {
  const other = new Awareness(new Y.Doc());
  other.setLocalState(user ? { user } : {});
  applyAwarenessUpdate(local, encodeAwarenessUpdate(other, [other.clientID]), "test");
  return other;
}

describe("createPeersStore", () => {
  it("tracks other users joining and leaving, and keeps the snapshot stable otherwise", () => {
    const awareness = new Awareness(new Y.Doc());
    awareness.setLocalStateField("user", { id: "me", name: "Me", color: "#111111" });
    const store = createPeersStore(awareness, "me");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(store.getSnapshot()).toEqual([]);
    const empty = store.getSnapshot();

    const bea = remote(awareness, { id: "u-b", name: "Bea", color: "#00aa00" });
    expect(store.getSnapshot()).toEqual([{ id: "u-b", name: "Bea", color: "#00aa00" }]);

    // A cursor move changes the awareness state but not the people: same snapshot identity.
    const before = store.getSnapshot();
    bea.setLocalState({ user: { id: "u-b", name: "Bea", color: "#00aa00" }, cursor: { anchor: 1 } });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(bea, [bea.clientID]), "test");
    expect(store.getSnapshot()).toBe(before);

    bea.setLocalState(null);
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(bea, [bea.clientID]), "test");
    expect(store.getSnapshot()).toBe(empty);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    awareness.destroy();
  });

  it("ignores the local user's other clients", () => {
    const awareness = new Awareness(new Y.Doc());
    const store = createPeersStore(awareness, "me");
    remote(awareness, { id: "me", name: "Me on phone", color: "#111111" });
    expect(store.getSnapshot()).toEqual([]);
    awareness.destroy();
  });
});
