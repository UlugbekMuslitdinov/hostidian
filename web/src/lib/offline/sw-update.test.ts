import { describe, expect, it, vi } from "vitest";
import { watchForUpdates, type UpdateSource } from "./sw-update";

function fakeSource() {
  const listeners = { waiting: new Set<() => void>(), controlling: new Set<() => void>() };
  const skip = vi.fn();
  const source: UpdateSource & { skip: typeof skip; emit(type: "waiting" | "controlling"): void } = {
    addEventListener: (type, fn) => void listeners[type].add(fn),
    removeEventListener: (type, fn) => void listeners[type].delete(fn),
    messageSkipWaiting: () => skip(),
    skip,
    emit: (type) => listeners[type].forEach((fn) => fn()),
  };
  return { source, listeners };
}

describe("watchForUpdates", () => {
  it("asks once when a new worker is waiting, and only swaps it in after the user accepts", () => {
    const { source } = fakeSource();
    const hooks = { prompt: vi.fn(), reload: vi.fn() };
    watchForUpdates(source, hooks);

    source.emit("waiting");
    expect(hooks.prompt).toHaveBeenCalledTimes(1);
    expect(source.skip).not.toHaveBeenCalled();

    source.emit("waiting"); // another deploy while the toast is open
    expect(hooks.prompt).toHaveBeenCalledTimes(1);

    hooks.prompt.mock.calls[0]![0]();
    expect(source.skip).toHaveBeenCalledTimes(1); // SKIP_WAITING is posted
    expect(hooks.reload).not.toHaveBeenCalled(); // not before the new worker controls the page

    source.emit("controlling");
    expect(hooks.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for the first-ever install claiming the tab, or when the update was not accepted", () => {
    const { source } = fakeSource();
    const hooks = { prompt: vi.fn(), reload: vi.fn() };
    watchForUpdates(source, hooks);
    source.emit("controlling");
    expect(hooks.reload).not.toHaveBeenCalled();
    source.emit("waiting");
    source.emit("controlling");
    expect(hooks.reload).not.toHaveBeenCalled();
  });

  it("accepting twice posts one message", () => {
    const { source } = fakeSource();
    const hooks = { prompt: vi.fn(), reload: vi.fn() };
    watchForUpdates(source, hooks);
    source.emit("waiting");
    const accept = hooks.prompt.mock.calls[0]![0] as () => void;
    accept();
    accept();
    expect(source.skip).toHaveBeenCalledTimes(1);
  });

  it("stops listening when torn down", () => {
    const { source, listeners } = fakeSource();
    const stop = watchForUpdates(source, { prompt: vi.fn(), reload: vi.fn() });
    expect(listeners.waiting.size + listeners.controlling.size).toBe(2);
    stop();
    expect(listeners.waiting.size + listeners.controlling.size).toBe(0);
  });
});
