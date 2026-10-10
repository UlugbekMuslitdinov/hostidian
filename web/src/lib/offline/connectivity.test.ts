import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROBE_DELAYS_MS,
  VISIBLE_REPROBE_MS,
  createConnectivityMonitor,
  type ConnectivityEnv,
} from "./connectivity";

function setup(initial: { browserOnline?: boolean; serverUp?: boolean } = {}) {
  let handlers: { online(): void; offline(): void; visible(): void } | null = null;
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const state = { browserOnline: initial.browserOnline ?? true, serverUp: initial.serverUp ?? true, probes: 0 };
  const changes: boolean[] = [];

  const env: ConnectivityEnv = {
    getBrowserOnline: () => state.browserOnline,
    listen: (h) => {
      handlers = h;
      return () => {
        handlers = null;
      };
    },
    probe: async () => {
      state.probes += 1;
      return state.serverUp;
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimeout: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => clock,
  };
  const monitor = createConnectivityMonitor({ onChange: (online) => changes.push(online), env });

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      await flush();
    }
    await flush();
  };
  return { monitor, state, changes, env, flush, advance, handlers: () => handlers!, pendingTimers: () => timers.length };
}

describe("connectivity monitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts from the browser's word, then confirms it with a probe", async () => {
    const t = setup();
    t.monitor.start();
    expect(t.changes).toEqual([true]);
    await t.flush();
    expect(t.state.probes).toBe(1);
    expect(t.monitor.online).toBe(true);
  });

  it("starts offline without probing when the browser says offline", async () => {
    const t = setup({ browserOnline: false });
    t.monitor.start();
    await t.flush();
    expect(t.changes).toEqual([false]);
    expect(t.state.probes).toBe(0);
  });

  it("catches a server that is unreachable although navigator.onLine is true", async () => {
    const t = setup({ serverUp: false });
    t.monitor.start();
    await t.flush();
    expect(t.monitor.online).toBe(false);
    expect(t.changes).toEqual([true, false]);
  });

  it("goes offline on a reported transport failure and recovers when a probe succeeds", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.monitor.reportFailure();
    expect(t.monitor.online).toBe(false);

    t.state.serverUp = false;
    await t.advance(DEFAULT_PROBE_DELAYS_MS[0]);
    expect(t.monitor.online).toBe(false); // still down: back-off continues
    t.state.serverUp = true;
    await t.advance(DEFAULT_PROBE_DELAYS_MS[1]);
    expect(t.monitor.online).toBe(true);
    expect(t.changes).toEqual([true, false, true]);
    expect(t.pendingTimers()).toBe(0); // no probing once reachable
  });

  it("backs off between probes and caps the delay", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.state.serverUp = false;
    t.monitor.reportFailure();
    const before = t.state.probes;
    for (const delay of [...DEFAULT_PROBE_DELAYS_MS, DEFAULT_PROBE_DELAYS_MS.at(-1)!]) await t.advance(delay);
    expect(t.state.probes - before).toBe(DEFAULT_PROBE_DELAYS_MS.length + 1);
  });

  it("any HTTP answer marks the server reachable", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.monitor.reportFailure();
    t.monitor.reportSuccess();
    expect(t.monitor.online).toBe(true);
  });

  it("follows the browser's offline event immediately and stops probing", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.state.browserOnline = false;
    t.handlers().offline();
    expect(t.monitor.online).toBe(false);
    const probes = t.state.probes;
    await t.advance(60_000);
    expect(t.state.probes).toBe(probes);
  });

  it("after the browser's online event it stays offline until the server answers", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.handlers().offline();
    expect(t.monitor.online).toBe(false);

    t.state.serverUp = false; // captive portal: interface up, no uplink
    t.state.browserOnline = true;
    t.handlers().online();
    await t.flush();
    expect(t.monitor.online).toBe(false);

    t.state.serverUp = true;
    await t.advance(DEFAULT_PROBE_DELAYS_MS[0]);
    expect(t.monitor.online).toBe(true);
  });

  it("re-checks the server when the tab becomes visible, but not on every flip", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    const probes = t.state.probes;
    t.handlers().visible();
    await t.flush();
    expect(t.state.probes).toBe(probes); // probed just now
    await t.advance(VISIBLE_REPROBE_MS);
    t.handlers().visible();
    await t.flush();
    expect(t.state.probes).toBe(probes + 1);
  });

  it("checkNow() probes immediately (the Retry button)", async () => {
    const t = setup();
    t.monitor.start();
    await t.flush();
    t.monitor.reportFailure();
    const probes = t.state.probes;
    t.monitor.checkNow();
    await t.flush();
    expect(t.state.probes).toBe(probes + 1);
    expect(t.monitor.online).toBe(true);
  });

  it("stop() cancels timers and listeners; start() is idempotent", async () => {
    const t = setup();
    t.monitor.start();
    t.monitor.start();
    await t.flush();
    expect(t.changes).toEqual([true]);
    t.monitor.reportFailure();
    t.monitor.stop();
    expect(t.pendingTimers()).toBe(0);
    await t.advance(60_000);
    expect(t.state.probes).toBe(1);
  });
});
