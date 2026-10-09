/**
 * "Effective online" tracking. `navigator.onLine` only says a network interface is up; it is true behind a
 * dead Wi-Fi, a captive portal or a stopped server. The monitor combines it with what the app actually
 * observes (transport errors on API calls) and an active probe, and feeds the result into TanStack Query's
 * onlineManager, which is what pauses and resumes queries and queued mutations.
 */

export interface ConnectivityEnv {
  getBrowserOnline: () => boolean;
  /** Subscribes to `online` / `offline` / `visible` signals; returns an unsubscribe function. */
  listen: (handlers: { online: () => void; offline: () => void; visible: () => void }) => () => void;
  /** True when the server answered (any HTTP status short of a gateway failure). Must not throw. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface ConnectivityOptions {
  /** Receives the effective state whenever it changes (and once on start). */
  onChange: (online: boolean) => void;
  /** Delay before each successive probe while unreachable; the last value repeats. */
  probeDelaysMs?: readonly number[];
  /** Overrides for the browser bindings (tests). */
  env?: Partial<ConnectivityEnv>;
}

export interface ConnectivityMonitor {
  start(): void;
  stop(): void;
  /** An API call failed at the transport level. */
  reportFailure(): void;
  /** An API call got an HTTP response. */
  reportSuccess(): void;
  readonly online: boolean;
}

export const DEFAULT_PROBE_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
const PROBE_TIMEOUT_MS = 5_000;

export function browserEnv(): ConnectivityEnv {
  return {
    getBrowserOnline: () => navigator.onLine !== false,
    listen: ({ online, offline, visible }) => {
      const onVisibility = () => {
        if (document.visibilityState === "visible") visible();
      };
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      document.addEventListener("visibilitychange", onVisibility);
      return () => {
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
        document.removeEventListener("visibilitychange", onVisibility);
      };
    },
    probe: async (signal) => {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      try {
        const res = await fetch("/api/instance/info", {
          cache: "no-store",
          credentials: "same-origin",
          signal: AbortSignal.any([signal, timeout]),
        });
        return !(res.status >= 502 && res.status <= 504);
      } catch {
        return false;
      }
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function createConnectivityMonitor(options: ConnectivityOptions): ConnectivityMonitor {
  const env: ConnectivityEnv = { ...browserEnv(), ...options.env };
  const delays = options.probeDelaysMs?.length ? options.probeDelaysMs : DEFAULT_PROBE_DELAYS_MS;

  let started = false;
  let browserOnline = true;
  let reachable = true;
  let effective = true;
  let unlisten: (() => void) | null = null;
  let probeTimer: unknown = null;
  let probeAbort: AbortController | null = null;
  let attempt = 0;

  const apply = () => {
    const next = browserOnline && reachable;
    if (next === effective) return;
    effective = next;
    options.onChange(next);
  };

  const cancelProbe = () => {
    if (probeTimer !== null) env.clearTimeout(probeTimer);
    probeTimer = null;
    probeAbort?.abort();
    probeAbort = null;
  };

  const probeNow = async () => {
    cancelProbe();
    if (!started || reachable || !browserOnline) return;
    const abort = new AbortController();
    probeAbort = abort;
    const ok = await env.probe(abort.signal);
    if (abort.signal.aborted || !started) return;
    probeAbort = null;
    if (ok) {
      markReachable();
    } else {
      scheduleProbe();
    }
  };

  const scheduleProbe = () => {
    if (!started || reachable || !browserOnline || probeTimer !== null) return;
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    attempt += 1;
    probeTimer = env.setTimeout(() => {
      probeTimer = null;
      void probeNow();
    }, delay);
  };

  const markReachable = () => {
    if (reachable) return;
    reachable = true;
    attempt = 0;
    cancelProbe();
    apply();
  };

  return {
    start() {
      if (started) return;
      started = true;
      browserOnline = env.getBrowserOnline();
      reachable = true;
      effective = browserOnline;
      options.onChange(effective);
      unlisten = env.listen({
        online: () => {
          browserOnline = true;
          apply();
          // Coming back from an outage we already know about: check right away instead of waiting out the backoff.
          if (!reachable) void probeNow();
        },
        offline: () => {
          browserOnline = false;
          cancelProbe();
          apply();
        },
        visible: () => {
          if (!reachable) void probeNow();
        },
      });
    },
    stop() {
      started = false;
      cancelProbe();
      unlisten?.();
      unlisten = null;
    },
    reportFailure() {
      if (!started || !reachable) return;
      reachable = false;
      attempt = 0;
      apply();
      scheduleProbe();
    },
    reportSuccess() {
      if (started) markReachable();
    },
    get online() {
      return effective;
    },
  };
}
