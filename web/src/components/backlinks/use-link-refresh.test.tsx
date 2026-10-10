import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEvent } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { publishWorkspaceEvent } from "@/lib/events/bus";
import { affectsLinks, LINK_REFRESH_DELAY_MS, useLinkRefresh } from "./use-link-refresh";

const event = (type: string, workspaceId = "ws1"): WorkspaceEvent =>
  ({ type, workspaceId, pageId: "p1", actorId: "u1", at: "2026-10-09T00:00:00Z" }) as WorkspaceEvent;

function Probe({ workspaceId }: { workspaceId: string }) {
  useLinkRefresh(workspaceId);
  return null;
}

describe("useLinkRefresh", () => {
  let qc: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
    invalidate = vi.spyOn(qc, "invalidateQueries");
  });
  afterEach(() => vi.useRealTimers());

  it("knows which events can change links", () => {
    expect(affectsLinks("page.updated")).toBe(true);
    expect(affectsLinks("permissions.changed")).toBe(true);
    expect(affectsLinks("comment.created")).toBe(false);
  });

  it("invalidates the graph and every backlinks query once after a burst of page events", () => {
    render(<Probe workspaceId="ws1" />, { wrapper });
    act(() => {
      publishWorkspaceEvent(event("page.updated"));
      publishWorkspaceEvent(event("page.updated"));
      publishWorkspaceEvent(event("page.created"));
    });
    expect(invalidate).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(LINK_REFRESH_DELAY_MS));
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate.mock.calls[0]![0]).toEqual({ queryKey: qk.graph("ws1") });
    const predicate = (invalidate.mock.calls[1]![0] as { predicate: (q: { queryKey: unknown[] }) => boolean }).predicate;
    expect(predicate({ queryKey: qk.backlinks("p9") as unknown as unknown[] })).toBe(true);
    expect(predicate({ queryKey: qk.comments("p9") as unknown as unknown[] })).toBe(false);
  });

  it("ignores other workspaces and unrelated events, and stops listening on unmount", () => {
    const { unmount } = render(<Probe workspaceId="ws1" />, { wrapper });
    act(() => {
      publishWorkspaceEvent(event("page.updated", "other"));
      publishWorkspaceEvent(event("comment.created"));
      vi.advanceTimersByTime(LINK_REFRESH_DELAY_MS * 2);
    });
    expect(invalidate).not.toHaveBeenCalled();
    unmount();
    act(() => {
      publishWorkspaceEvent(event("page.updated"));
      vi.advanceTimersByTime(LINK_REFRESH_DELAY_MS * 2);
    });
    expect(invalidate).not.toHaveBeenCalled();
  });
});
