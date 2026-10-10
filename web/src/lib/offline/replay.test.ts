import { MutationObserver, QueryClient, onlineManager } from "@tanstack/react-query";
import { persistQueryClientRestore, persistQueryClientSave } from "@tanstack/react-query-persist-client";
import type { PageSummary } from "@hostidian/api-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "../api/keys";
import {
  mutationKeys,
  setupMutationDefaults,
  type CreatePageVars,
  type MovePageVars,
  type RenamePageVars,
} from "../query/mutations";
import { createQueryClient } from "../query/client";
import { fetchMock, jsonResponse } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { createOfflineRuntime } from "./runtime";
import { persistKey } from "./persister";
import { createMemoryStore } from "./test-helpers";
import type { UserScope } from "./user-scope";

/**
 * The offline promise end to end, minus the browser: tree changes made while offline (create a page, create a
 * child under that not-yet-existing page, rename, move) are queued, survive a reload through the persisted cache,
 * and are replayed against the server in the order they were made once the connection is back.
 */

const WS = "ws-1";
const USER = "user-1";

function memoryScope(initial: string | null): UserScope {
  let value = initial;
  return {
    get: () => value,
    set: (v) => void (value = v),
    clear: () => void (value = null),
    refresh: () => undefined,
  };
}

function newClient(): QueryClient {
  const qc = createQueryClient();
  qc.setDefaultOptions({ ...qc.getDefaultOptions(), queries: { ...qc.getDefaultOptions().queries, retry: false } });
  setupMutationDefaults(qc);
  return qc;
}

/** What `usePageActions` does: one mutation observer per call, `mutate(vars)`. */
function mutate<V>(qc: QueryClient, key: readonly string[], variables: V) {
  const observer = new MutationObserver(qc, { mutationKey: key });
  void observer.mutate(variables as never).catch(() => undefined);
}

const createVars = (id: string, parentId: string | null, position: string): CreatePageVars => ({
  workspaceId: WS,
  id,
  parentId,
  title: `Page ${id}`,
  position,
  createdBy: USER,
  now: "2026-10-09T10:00:00Z",
});

describe("offline create -> rename -> move replay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    onlineManager.setOnline(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    onlineManager.setOnline(true);
  });

  it("survives a reload and replays in order, including a child created under an offline-created parent", async () => {
    const store = createMemoryStore();
    const scope = memoryScope(USER);
    const existing = makePage({ id: "existing", workspaceId: WS, position: "a0" });

    // ---------------------------------------------------------------- session 1: offline
    const first = createOfflineRuntime({ queryClient: newClient(), store, scope, window: null });
    first.queryClient.setQueryData(qk.pages(WS), [existing]);
    onlineManager.setOnline(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    mutate(first.queryClient, mutationKeys.createPage, createVars("parent", null, "a1"));
    mutate(first.queryClient, mutationKeys.createPage, createVars("child", "parent", "a0"));
    mutate(first.queryClient, mutationKeys.renamePage, { workspaceId: WS, pageId: "child", title: "Renamed child" } satisfies RenamePageVars);
    mutate(first.queryClient, mutationKeys.movePage, {
      workspaceId: WS,
      pageId: "child",
      parentId: "existing",
      position: "a0",
    } satisfies MovePageVars);
    await vi.advanceTimersByTimeAsync(3_000);

    // The optimistic tree is what the user sees offline.
    const optimistic = first.queryClient.getQueryData<PageSummary[]>(qk.pages(WS))!;
    expect(optimistic.map((p) => p.id).sort()).toEqual(["child", "existing", "parent"]);
    expect(optimistic.find((p) => p.id === "child")).toMatchObject({ title: "Renamed child", parentId: "existing" });

    // "Reload": persist (the persister throttles; flushing is what pagehide does), then forget everything in memory.
    await persistQueryClientSave({ queryClient: first.queryClient, ...first.persistOptions });
    await first.persister.flush();
    const saved = store.data.get(persistKey(USER)) as { clientState: { mutations: Array<{ mutationKey: string[]; state: { isPaused: boolean; variables: { id?: string; pageId?: string } } }> } };
    expect(saved.clientState.mutations.map((m) => m.mutationKey[0])).toEqual(["createPage", "createPage", "renamePage", "movePage"]);
    expect(saved.clientState.mutations.every((m) => m.state.isPaused)).toBe(true);

    // ---------------------------------------------------------------- session 2: reload while still offline
    fetchMock.mockReset();
    const second = createOfflineRuntime({ queryClient: newClient(), store, scope, window: null });
    await persistQueryClientRestore({ queryClient: second.queryClient, ...second.persistOptions });

    expect(second.queryClient.getMutationCache().getAll()).toHaveLength(4);
    const restored = second.queryClient.getQueryData<PageSummary[]>(qk.pages(WS))!;
    expect(restored.find((p) => p.id === "child")).toMatchObject({ title: "Renamed child", parentId: "existing" });

    // ---------------------------------------------------------------- the connection returns
    const requests: string[] = [];
    const server = new Map<string, PageSummary>([["existing", existing]]);
    fetchMock.mockImplementation(async (request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api/, "");
      const key = `${request.method} ${path}`;
      const body = request.method === "GET" ? undefined : ((await request.clone().json()) as Record<string, unknown>);
      if (request.method !== "GET") requests.push(`${key} ${JSON.stringify(body)}`);

      if (key === `POST /workspaces/${WS}/pages`) {
        const b = body as { id: string; parentId: string | null; title: string };
        if (b.parentId && !server.has(b.parentId)) return jsonResponse({ error: { code: "not_found", message: "parent" } }, 404);
        const page = makePage({ id: b.id, workspaceId: WS, parentId: b.parentId, title: b.title });
        server.set(page.id, page);
        return jsonResponse(page, 201);
      }
      const patch = /^PATCH \/pages\/(.+)$/.exec(key);
      if (patch) {
        const page = { ...server.get(patch[1]!)!, ...(body as Partial<PageSummary>) };
        server.set(page.id, page);
        return jsonResponse(page);
      }
      const move = /^POST \/pages\/(.+)\/move$/.exec(key);
      if (move) {
        const page = { ...server.get(move[1]!)!, parentId: (body as { parentId: string | null }).parentId };
        server.set(page.id, page);
        return jsonResponse(page);
      }
      if (key === `GET /workspaces/${WS}/pages`) return jsonResponse([...server.values()]);
      return jsonResponse([]);
    });

    onlineManager.setOnline(true);
    await second.queryClient.resumePausedMutations(); // what the provider does after a restore
    await vi.advanceTimersByTimeAsync(1_000);

    expect(requests).toEqual([
      `POST /workspaces/${WS}/pages ${JSON.stringify({ id: "parent", parentId: null, title: "Page parent" })}`,
      `POST /workspaces/${WS}/pages ${JSON.stringify({ id: "child", parentId: "parent", title: "Page child" })}`,
      `PATCH /pages/child ${JSON.stringify({ title: "Renamed child" })}`,
      `POST /pages/child/move ${JSON.stringify({ parentId: "existing" })}`,
    ]);
    expect(server.get("child")).toMatchObject({ parentId: "existing", title: "Renamed child" });
    expect(second.sync.store.get().pending).toBe(0);
    // Everything replayed: the queue is empty and nothing is left to persist as pending.
    expect(second.queryClient.getMutationCache().getAll().every((m) => m.state.status === "success")).toBe(true);
  });

  it("resumes the queue on its own when the connectivity monitor reports the server reachable", async () => {
    const qc = newClient();
    qc.mount();
    onlineManager.setOnline(false);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    mutate(qc, mutationKeys.createPage, createVars("p1", null, "a0"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(qc.getMutationCache().getAll()[0]!.state.isPaused).toBe(true);

    const seen: string[] = [];
    fetchMock.mockImplementation(async (request) => {
      seen.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === "POST") return jsonResponse(makePage({ id: "p1", workspaceId: WS }), 201);
      return jsonResponse([]);
    });
    onlineManager.setOnline(true); // the monitor's onChange does exactly this
    await vi.advanceTimersByTimeAsync(1_000);

    expect(seen[0]).toBe(`POST /api/workspaces/${WS}/pages`);
    expect(qc.getMutationCache().getAll()[0]!.state.status).toBe("success");
    qc.unmount();
  });
});
