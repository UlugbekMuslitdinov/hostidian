import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { qk } from "@/lib/api/keys";
import { OfflineRuntimeProvider } from "@/lib/offline/context";
import { persistKey } from "@/lib/offline/persister";
import { createOfflineRuntime } from "@/lib/offline/runtime";
import { createMemoryStore } from "@/lib/offline/test-helpers";
import { makeMe, makeUser } from "@/test/factories";
import { IdentityGate } from "./identity-gate";

function runtimeFor(owner: string | null) {
  let value = owner;
  const store = createMemoryStore({ [persistKey("alice")]: { v: 1 } });
  const qc = new QueryClient();
  qc.setQueryData(qk.pages("ws"), [{ id: "p", title: "Alice's private title" }]);
  const runtime = createOfflineRuntime({
    queryClient: qc,
    store,
    scope: { get: () => value, set: (v) => void (value = v), clear: () => void (value = null), refresh() {} },
    window: null,
    cleanupDeps: { indexedDB: {
        deleteDatabase: () => {
          const request = {} as { onsuccess?: () => void };
          queueMicrotask(() => request.onsuccess?.());
          return request as unknown as IDBOpenDBRequest;
        },
        databases: async () => [],
      }, caches: { keys: async () => [], delete: async () => true }, localStorage: { length: 0, key: () => null, removeItem() {} } },
  });
  return { runtime, qc };
}

function Child({ qc }: { qc: QueryClient }) {
  // What the sidebar would render: whatever titles are in the cache at the moment the child mounts.
  const titles = (qc.getQueryData<Array<{ title: string }>>(qk.pages("ws")) ?? []).map((p) => p.title).join(",");
  return <p data-testid="child">{titles || "empty"}</p>;
}

describe("<IdentityGate/>", () => {
  it("renders the same account's data at once", () => {
    const { runtime, qc } = runtimeFor("alice");
    render(
      <OfflineRuntimeProvider runtime={runtime}>
        <IdentityGate me={makeMe({ user: makeUser({ id: "alice" }) })}>
          <Child qc={qc} />
        </IdentityGate>
      </OfflineRuntimeProvider>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("Alice's private title");
  });

  it("never lets a different account see the previous account's cache, not even for one frame", async () => {
    const { runtime, qc } = runtimeFor("alice");
    render(
      <OfflineRuntimeProvider runtime={runtime}>
        <IdentityGate me={makeMe({ user: makeUser({ id: "bob" }) })}>
          <Child qc={qc} />
        </IdentityGate>
      </OfflineRuntimeProvider>,
    );
    expect(screen.queryByTestId("child")).not.toBeInTheDocument(); // blocked while wiping
    expect(screen.getByText("Switching account…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("child")).toBeInTheDocument());
    expect(screen.getByTestId("child")).toHaveTextContent("empty");
  });

  it("lets the first account on a device straight in", async () => {
    const { runtime, qc } = runtimeFor(null);
    await act(async () => {
      render(
        <OfflineRuntimeProvider runtime={runtime}>
          <IdentityGate me={makeMe({ user: makeUser({ id: "carol" }) })}>
            <Child qc={qc} />
          </IdentityGate>
        </OfflineRuntimeProvider>,
      );
    });
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
