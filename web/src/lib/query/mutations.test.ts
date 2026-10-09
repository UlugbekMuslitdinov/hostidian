import type { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDetail, PageSummary } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { errorResponse, fetchMock, jsonResponse } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { makeTestQueryClient } from "@/test/render";
import {
  mutationKeys,
  type CreatePageVars,
  type MovePageVars,
  type PageRefVars,
  type RenamePageVars,
  type ToggleFavoriteVars,
} from "./mutations";

const WS = "ws-1";

function run<TVars>(qc: QueryClient, key: readonly string[], vars: TVars) {
  return qc.getMutationCache().build(qc, { mutationKey: key }).execute(vars);
}

const root = makePage({ id: "root", workspaceId: WS, title: "Root", position: "a0" });
const child = makePage({ id: "child", workspaceId: WS, title: "Child", parentId: "root", position: "a0" });
const grandchild = makePage({ id: "grand", workspaceId: WS, title: "Grandchild", parentId: "child", position: "a0" });
const other = makePage({ id: "other", workspaceId: WS, title: "Other", position: "a1" });

function seed(qc: QueryClient, pages: PageSummary[] = [root, child, grandchild, other]) {
  qc.setQueryData(qk.pages(WS), pages);
  qc.setQueryData(qk.favorites(WS), [child]);
  qc.setQueryData(qk.trash(WS), []);
}

const pages = (qc: QueryClient) => qc.getQueryData<PageSummary[]>(qk.pages(WS))!;
const byId = (qc: QueryClient, id: string) => pages(qc).find((p) => p.id === id);

const createVars = (overrides: Partial<CreatePageVars> = {}): CreatePageVars => ({
  workspaceId: WS,
  id: "0199-new",
  parentId: null,
  position: "a2",
  createdBy: "user-1",
  now: "2026-10-09T12:00:00Z",
  ...overrides,
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe("setupMutationDefaults", () => {
  it("registers every page-tree mutation centrally, so paused ones can be resumed after a reload", () => {
    const qc = makeTestQueryClient();
    for (const key of Object.values(mutationKeys)) {
      const defaults = qc.getMutationDefaults(key);
      expect(defaults?.mutationFn, `mutationFn for ${key.join("/")}`).toBeTypeOf("function");
      expect(defaults?.onMutate, `onMutate for ${key.join("/")}`).toBeTypeOf("function");
      expect(defaults?.onError, `onError for ${key.join("/")}`).toBeTypeOf("function");
      expect(defaults?.scope?.id).toBe("pages");
    }
    expect(Object.keys(mutationKeys).sort()).toEqual([
      "archivePage",
      "createPage",
      "movePage",
      "renamePage",
      "restorePage",
      "toggleFavorite",
      "updatePageMeta",
    ]);
  });
});

describe("createPage", () => {
  it("shows the page immediately with the client id, then adopts the server record", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));

    const done = run(qc, mutationKeys.createPage, createVars({ title: "Draft", visibility: "private" }));

    await vi.waitFor(() => expect(byId(qc, "0199-new")).toBeDefined());
    expect(byId(qc, "0199-new")).toMatchObject({
      title: "Draft",
      visibility: "private",
      parentId: null,
      position: "a2",
      role: "full",
    });
    const detail = qc.getQueryData<PageDetail>(qk.page("0199-new"));
    expect(detail?.page.id).toBe("0199-new");
    expect(detail?.isFavorite).toBe(false);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    expect(new URL(request.url).pathname).toBe(`/api/workspaces/${WS}/pages`);
    await expect(request.clone().json()).resolves.toMatchObject({
      id: "0199-new",
      parentId: null,
      title: "Draft",
      visibility: "private",
    });

    release(jsonResponse({ ...byId(qc, "0199-new"), position: "a5", updatedAt: "2026-10-09T12:00:01Z" }, 201));
    await done;
    expect(byId(qc, "0199-new")?.position).toBe("a5"); // server value wins
  });

  it("children inherit the parent's role and ignore visibility", async () => {
    const qc = makeTestQueryClient();
    seed(qc, [{ ...root, role: "edit" }, child]);
    fetchMock.mockImplementation(async () => new Promise<Response>(() => {}));
    void run(qc, mutationKeys.createPage, createVars({ id: "kid", parentId: "root", visibility: "private" }));
    await vi.waitFor(() => expect(byId(qc, "kid")).toBeDefined());
    expect(byId(qc, "kid")).toMatchObject({ role: "edit", visibility: "workspace", parentId: "root" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = await fetchMock.mock.calls[0]![0].clone().json();
    expect(body.visibility).toBeUndefined();
  });

  it("rolls back when the server rejects it", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    fetchMock.mockResolvedValue(errorResponse(403, "forbidden", "No"));
    await expect(run(qc, mutationKeys.createPage, createVars())).rejects.toMatchObject({ status: 403 });
    expect(byId(qc, "0199-new")).toBeUndefined();
    expect(qc.getQueryData(qk.page("0199-new"))).toBeUndefined();
  });
});

describe("movePage", () => {
  const vars = (overrides: Partial<MovePageVars> = {}): MovePageVars => ({
    workspaceId: WS,
    pageId: "other",
    parentId: "root",
    afterId: "child",
    position: "a0V",
    ...overrides,
  });

  it("re-parents optimistically and rolls back on failure", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const done = run(qc, mutationKeys.movePage, vars());
    await vi.waitFor(() => expect(byId(qc, "other")?.parentId).toBe("root"));
    expect(byId(qc, "other")?.position).toBe("a0V");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const request = fetchMock.mock.calls[0]![0];
    await expect(request.clone().json()).resolves.toEqual({ parentId: "root", afterId: "child" });

    release(errorResponse(422, "validation_failed", "cycle"));
    await expect(done).rejects.toMatchObject({ status: 422 });
    expect(byId(qc, "other")).toMatchObject({ parentId: null, position: "a1" });
  });
});

describe("archivePage / restorePage", () => {
  it("removes the subtree from the tree and favourites, files the root under Trash, and can roll back", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    let release!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const done = run<PageRefVars>(qc, mutationKeys.archivePage, { workspaceId: WS, pageId: "root" });

    await vi.waitFor(() => expect(pages(qc).map((p) => p.id)).toEqual(["other"]));
    expect(qc.getQueryData<PageSummary[]>(qk.favorites(WS))).toEqual([]);
    expect(qc.getQueryData<PageSummary[]>(qk.trash(WS))?.map((p) => p.id)).toEqual(["root"]);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    release(errorResponse(403, "forbidden", "need full"));
    await expect(done).rejects.toMatchObject({ status: 403 });
    expect(
      pages(qc)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["child", "grand", "other", "root"]);
    expect(qc.getQueryData<PageSummary[]>(qk.trash(WS))).toEqual([]);
    expect(qc.getQueryData<PageSummary[]>(qk.favorites(WS))?.map((p) => p.id)).toEqual(["child"]);
  });

  it("restore drops the page from the trash list and puts the server record back", async () => {
    const qc = makeTestQueryClient();
    seed(qc, [other]);
    const archived = { ...root, archivedAt: "2026-10-09T10:00:00Z" };
    qc.setQueryData(qk.trash(WS), [archived]);
    fetchMock.mockResolvedValue(jsonResponse({ ...root, archivedAt: null }));
    await run<PageRefVars>(qc, mutationKeys.restorePage, { workspaceId: WS, pageId: "root" });
    expect(qc.getQueryData<PageSummary[]>(qk.trash(WS))).toEqual([]);
    expect(byId(qc, "root")?.archivedAt).toBeNull();
  });
});

describe("renamePage / toggleFavorite", () => {
  it("patches the title in the tree, favourites and page detail at once", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    qc.setQueryData<PageDetail>(qk.page("child"), { page: child, breadcrumbs: [], isFavorite: true });
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    void run<RenamePageVars>(qc, mutationKeys.renamePage, { workspaceId: WS, pageId: "child", title: "Renamed" });
    await vi.waitFor(() => expect(byId(qc, "child")?.title).toBe("Renamed"));
    expect(qc.getQueryData<PageSummary[]>(qk.favorites(WS))?.[0]?.title).toBe("Renamed");
    expect(qc.getQueryData<PageDetail>(qk.page("child"))?.page.title).toBe("Renamed");
  });

  it("toggles favourites optimistically in both directions", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    fetchMock.mockResolvedValue(jsonResponse(null, 204));
    await run<ToggleFavoriteVars>(qc, mutationKeys.toggleFavorite, {
      workspaceId: WS,
      pageId: "other",
      favorite: true,
    });
    expect(fetchMock.mock.calls[0]![0].method).toBe("PUT");
    // the settle() re-sync is mocked away: seed what the optimistic update produced
    expect(qc.getQueryData<PageSummary[]>(qk.favorites(WS))?.map((p) => p.id)).toEqual(
      expect.arrayContaining(["child", "other"]),
    );

    await run<ToggleFavoriteVars>(qc, mutationKeys.toggleFavorite, {
      workspaceId: WS,
      pageId: "child",
      favorite: false,
    });
    expect(fetchMock.mock.calls.at(-1)![0].method).toBe("DELETE");
  });
});

describe("ordering", () => {
  it("runs queued tree mutations one at a time, in the order they were issued", async () => {
    const qc = makeTestQueryClient();
    seed(qc);
    const resolvers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));

    const first = run(qc, mutationKeys.createPage, createVars({ id: "p1" }));
    const second = run<RenamePageVars>(qc, mutationKeys.renamePage, { workspaceId: WS, pageId: "p1", title: "Named" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The rename is queued behind the create (it would 404 on the server otherwise)...
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...but its optimistic effect is already visible.
    expect(byId(qc, "p1")?.title).toBe("Named");

    resolvers[0]!(jsonResponse({ ...byId(qc, "p1"), title: "" }, 201));
    await first;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URL(fetchMock.mock.calls[1]![0].url).pathname).toBe("/api/pages/p1");
    resolvers[1]!(jsonResponse({ ...byId(qc, "p1"), title: "Named" }));
    await second;
  });
});
