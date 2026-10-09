import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@hostidian/api-types";
import { qk } from "@/lib/api/keys";
import { makePage } from "@/test/factories";
import { makeTestQueryClient } from "@/test/render";
import { onWorkspaceEvent } from "./bus";
import { backoffDelay, connectWorkspaceEvents } from "./use-workspace-events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

const WS = "ws-1";

function connect(isOnline = () => true) {
  const qc = makeTestQueryClient();
  const dispose = connectWorkspaceEvents({
    workspaceId: WS,
    queryClient: qc,
    createSource: (url) => new FakeEventSource(url) as unknown as EventSource,
    isOnline,
  });
  return { qc, dispose, source: () => FakeEventSource.instances.at(-1)! };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("connectWorkspaceEvents", () => {
  it("subscribes to the workspace stream and patches the cache per event type", () => {
    const { qc, dispose, source } = connect();
    expect(source().url).toBe(`/api/workspaces/${WS}/events`);
    const page = makePage({ id: "p", workspaceId: WS, title: "Old" });
    qc.setQueryData(qk.pages(WS), [page]);
    source().emit("page.updated", {
      type: "page.updated",
      workspaceId: WS,
      pageId: "p",
      at: "x",
      data: { ...page, title: "New" },
    });
    expect(qc.getQueryData<PageSummary[]>(qk.pages(WS))![0]!.title).toBe("New");
    dispose();
  });

  it("publishes parsed events on the bus and ignores malformed frames", () => {
    const { source, dispose } = connect();
    const seen = vi.fn();
    const off = onWorkspaceEvent(seen);
    source().emit("comment.created", { type: "comment.created", workspaceId: WS, pageId: "p", at: "x" });
    source().listeners.get("comment.created")?.({ data: "not json" } as MessageEvent<string>);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    dispose();
  });

  it("reconnects with backoff after the stream closes and refetches the workspace once it is back", () => {
    const { qc, dispose, source } = connect();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    source().onopen?.(); // first connect: nothing to catch up on
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: qk.workspace(WS) });

    const first = source();
    first.fail();
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(FakeEventSource.instances).toHaveLength(2);
    source().onopen?.();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.workspace(WS) });
    dispose();
  });

  it("backs off exponentially, with a cap", () => {
    const fixed = () => 1;
    expect(backoffDelay(0, fixed)).toBe(1000);
    expect(backoffDelay(1, fixed)).toBe(2000);
    expect(backoffDelay(3, fixed)).toBe(8000);
    expect(backoffDelay(20, fixed)).toBe(30_000);
    expect(backoffDelay(2, () => 0)).toBe(2000);
  });

  it("closes while offline and reconnects when the browser is back online", () => {
    let online = true;
    const { source, dispose } = connect(() => online);
    const first = source();
    online = false;
    window.dispatchEvent(new Event("offline"));
    expect(first.readyState).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    online = true;
    window.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(2);
    dispose();
  });

  it("does not open a stream while offline and stops everything on dispose", () => {
    const { dispose } = connect(() => false);
    expect(FakeEventSource.instances).toHaveLength(0);
    dispose();
    window.dispatchEvent(new Event("online"));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
