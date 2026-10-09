import { describe, expect, it, vi } from "vitest";
import type { PageSummary, WorkspaceEvent } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { makePage } from "@/test/factories";
import { makeTestQueryClient } from "@/test/render";
import { applyWorkspaceEvent, isPageSummary } from "./apply";

const WS = "ws-1";
const event = (type: WorkspaceEvent["type"], extra: Partial<WorkspaceEvent> = {}): WorkspaceEvent => ({
  type,
  workspaceId: WS,
  at: "2026-10-09T12:00:00Z",
  ...extra,
});

describe("applyWorkspaceEvent", () => {
  it("page.updated with a PageSummary patches the tree in place and schedules a detail refresh", () => {
    const qc = makeTestQueryClient();
    const page = makePage({ id: "p", workspaceId: WS, title: "Old" });
    qc.setQueryData(qk.pages(WS), [page]);
    const schedule = vi.fn();
    applyWorkspaceEvent(qc, event("page.updated", { pageId: "p", data: { ...page, title: "New" } }), schedule);
    expect(qc.getQueryData<PageSummary[]>(qk.pages(WS))![0]!.title).toBe("New");
    expect(schedule).toHaveBeenCalledWith(qk.page("p"), expect.any(Number));
  });

  it("page.created inserts unknown pages and does not duplicate known ones", () => {
    const qc = makeTestQueryClient();
    const existing = makePage({ id: "a", workspaceId: WS });
    qc.setQueryData(qk.pages(WS), [existing]);
    const created = makePage({ id: "b", workspaceId: WS });
    applyWorkspaceEvent(qc, event("page.created", { pageId: "b", data: created }), vi.fn());
    applyWorkspaceEvent(qc, event("page.created", { pageId: "b", data: created }), vi.fn());
    expect(qc.getQueryData<PageSummary[]>(qk.pages(WS))!.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("page.archived removes the whole subtree from the cache and refreshes the trash", () => {
    const qc = makeTestQueryClient();
    const a = makePage({ id: "a", workspaceId: WS });
    const b = makePage({ id: "b", workspaceId: WS, parentId: "a" });
    const c = makePage({ id: "c", workspaceId: WS });
    qc.setQueryData(qk.pages(WS), [a, b, c]);
    const schedule = vi.fn();
    applyWorkspaceEvent(qc, event("page.archived", { pageId: "a" }), schedule);
    expect(qc.getQueryData<PageSummary[]>(qk.pages(WS))!.map((p) => p.id)).toEqual(["c"]);
    expect(schedule).toHaveBeenCalledWith(qk.trash(WS));
  });

  it("permissions.changed refreshes the tree, favourites, recents and the page", () => {
    const qc = makeTestQueryClient();
    const schedule = vi.fn();
    applyWorkspaceEvent(qc, event("permissions.changed", { pageId: "p" }), schedule);
    const keys = schedule.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(keys).toEqual(
      expect.arrayContaining([
        JSON.stringify(qk.pages(WS)),
        JSON.stringify(qk.favorites(WS)),
        JSON.stringify(qk.page("p")),
        JSON.stringify(qk.pagePermissions("p")),
      ]),
    );
  });

  it("comment events refresh that page's comments; member events refresh members and the session", () => {
    const qc = makeTestQueryClient();
    const schedule = vi.fn();
    applyWorkspaceEvent(qc, event("comment.created", { pageId: "p" }), schedule);
    expect(schedule).toHaveBeenCalledWith(qk.comments("p"), expect.any(Number));
    schedule.mockClear();
    applyWorkspaceEvent(qc, event("member.changed"), schedule);
    expect(schedule).toHaveBeenCalledWith(qk.members(WS));
    expect(schedule).toHaveBeenCalledWith(qk.me());
  });

  it("does not refetch lists while local tree mutations are in flight (they re-sync when they settle)", async () => {
    const qc = makeTestQueryClient();
    qc.setQueryData(qk.pages(WS), [makePage({ id: "a", workspaceId: WS })]);
    // a never-resolving mutation in the pages scope
    const mutation = qc.getMutationCache().build(qc, {
      mutationKey: ["x"],
      scope: { id: "pages" },
      mutationFn: () => new Promise<void>(() => {}),
    });
    void mutation.execute(undefined);
    await vi.waitFor(() => expect(qc.isMutating()).toBe(1));
    const schedule = vi.fn();
    applyWorkspaceEvent(qc, event("page.moved", { pageId: "a" }), schedule);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("recognises PageSummary payloads", () => {
    expect(isPageSummary(makePage())).toBe(true);
    expect(isPageSummary({ threadId: "x" })).toBe(false);
    expect(isPageSummary(null)).toBe(false);
  });
});
