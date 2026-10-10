import "fake-indexeddb/auto";
import { useIsRestoring } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdbKeyValueStore, PERSIST_BUSTER, persistKey } from "@/lib/offline/persister";
import { OFFLINE_KEYS, pageDbName } from "@/lib/offline/keys";
import { runLogoutCleanups } from "@/lib/session-cleanup";
import { fetchMock, jsonResponse } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { QueryProvider } from "./provider";

const USER = "user-1";

function Probe() {
  return <p data-testid="restoring">{String(useIsRestoring())}</p>;
}

async function seedSnapshot() {
  const store = createIdbKeyValueStore();
  await store.set(persistKey(USER), {
    timestamp: Date.now(),
    buster: PERSIST_BUSTER,
    clientState: {
      queries: [],
      mutations: [
        {
          mutationKey: ["createPage"],
          scope: { id: "pages" },
          state: {
            context: undefined,
            data: undefined,
            error: null,
            failureCount: 0,
            failureReason: null,
            isPaused: true,
            status: "pending",
            variables: {
              workspaceId: "ws-1",
              id: "offline-page",
              parentId: null,
              title: "Written offline",
              position: "a0",
              createdBy: USER,
              now: "2026-10-09T10:00:00Z",
            },
            submittedAt: Date.now(),
          },
        },
      ],
    },
  });
}

describe("<QueryProvider/>", () => {
  beforeEach(async () => {
    // The key-value database stays open for the life of the module (idb-keyval), so empty it instead of deleting it.
    await createIdbKeyValueStore().clear();
    for (const db of await indexedDB.databases()) if (db.name?.startsWith("page:")) indexedDB.deleteDatabase(db.name);
    window.localStorage.clear();
    // The connectivity monitor probes `/api/instance/info` with the global fetch.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores the persisted cache and replays the queued mutations of the signed-in user after hydrating", async () => {
    window.localStorage.setItem(OFFLINE_KEYS.lastUser, USER);
    await seedSnapshot();
    const posted: unknown[] = [];
    fetchMock.mockImplementation(async (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/api/workspaces/ws-1/pages") {
        posted.push(await request.json());
        return jsonResponse(makePage({ id: "offline-page", workspaceId: "ws-1", title: "Written offline" }), 201);
      }
      return jsonResponse([]);
    });

    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("restoring")).toHaveTextContent("false"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ id: "offline-page", title: "Written offline", parentId: null });
  });

  it("ignores a snapshot that belongs to another user", async () => {
    window.localStorage.setItem(OFFLINE_KEYS.lastUser, "someone-else");
    await seedSnapshot(); // belongs to USER, not to the device's current owner
    fetchMock.mockImplementation(async () => jsonResponse([]));
    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("restoring")).toHaveTextContent("false"));
    expect(fetchMock.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
  });

  it("discards a snapshot from another schema version", async () => {
    window.localStorage.setItem(OFFLINE_KEYS.lastUser, USER);
    await createIdbKeyValueStore().set(persistKey(USER), {
      timestamp: Date.now(),
      buster: "schema-0",
      clientState: {
        queries: [{ queryKey: ["me"], queryHash: '["me"]', state: { data: { stale: true }, dataUpdateCount: 1, dataUpdatedAt: 1, error: null, errorUpdateCount: 0, errorUpdatedAt: 0, fetchFailureCount: 0, fetchFailureReason: null, fetchMeta: null, isInvalidated: false, status: "success", fetchStatus: "idle" } }],
        mutations: [],
      },
    });
    fetchMock.mockImplementation(async () => jsonResponse([]));
    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("restoring")).toHaveTextContent("false"));
    await waitFor(async () => expect(await createIdbKeyValueStore().get(persistKey(USER))).toBeUndefined());
  });

  it("logout wipes the persisted cache, page documents and the owner marker through the registered cleanup", async () => {
    window.localStorage.setItem(OFFLINE_KEYS.lastUser, USER);
    await seedSnapshot();
    await new Promise<void>((resolve) => {
      const request = indexedDB.open(pageDbName("p1"), 1);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    fetchMock.mockImplementation(async () => jsonResponse([]));
    render(
      <QueryProvider>
        <Probe />
      </QueryProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("restoring")).toHaveTextContent("false"));

    await runLogoutCleanups();

    expect(await createIdbKeyValueStore().get(persistKey(USER))).toBeUndefined();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(pageDbName("p1"));
    expect(window.localStorage.getItem(OFFLINE_KEYS.lastUser)).toBeNull();
  });
});
