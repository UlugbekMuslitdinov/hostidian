"use client";

import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import type { WorkspaceEvent } from "@hostidian/api-types";
import { qk } from "../api/keys";
import { applyWorkspaceEvent, WORKSPACE_EVENT_TYPES } from "./apply";
import { publishWorkspaceEvent } from "./bus";

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(exp / 2 + random() * (exp / 2)); // equal jitter
}

export interface ConnectOptions {
  workspaceId: string;
  queryClient: QueryClient;
  createSource?: (url: string) => EventSource;
  isOnline?: () => boolean;
}

/**
 * Open (and keep open) the workspace SSE stream. Reconnects with exponential backoff, closes while the
 * browser is offline, and refetches the workspace's queries after every reconnect because events are
 * not replayed (conventions §5). Returns a disposer.
 */
export function connectWorkspaceEvents(options: ConnectOptions): () => void {
  const { workspaceId, queryClient: qc } = options;
  const createSource = options.createSource ?? ((url: string) => new EventSource(url, { withCredentials: true }));
  const isOnline = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);

  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let wasConnected = false;
  let disposed = false;
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (key: QueryKey, delayMs = 250) => {
    const id = JSON.stringify(key);
    const existing = scheduled.get(id);
    if (existing) clearTimeout(existing);
    scheduled.set(
      id,
      setTimeout(() => {
        scheduled.delete(id);
        void qc.invalidateQueries({ queryKey: key });
      }, delayMs),
    );
  };

  const close = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    source?.close();
    source = null;
  };

  const connect = () => {
    if (disposed || source || !isOnline()) return;
    const es = createSource(`/api/workspaces/${workspaceId}/events`);
    source = es;

    es.onopen = () => {
      attempt = 0;
      if (wasConnected) {
        // Anything could have happened while we were away.
        void qc.invalidateQueries({ queryKey: qk.workspace(workspaceId) });
      }
      wasConnected = true;
    };

    const onMessage = (message: MessageEvent<string>) => {
      let event: WorkspaceEvent;
      try {
        event = JSON.parse(message.data) as WorkspaceEvent;
      } catch {
        return; // keep-alive noise or malformed frame
      }
      if (!event || typeof event.type !== "string") return;
      applyWorkspaceEvent(qc, event, schedule);
      publishWorkspaceEvent(event);
    };
    for (const type of WORKSPACE_EVENT_TYPES) es.addEventListener(type, onMessage as EventListener);

    es.onerror = () => {
      // EventSource retries by itself while CONNECTING; a CLOSED source (HTTP error, 401, proxy reset) never will.
      if (es.readyState !== EventSource.CLOSED && isOnline()) return;
      es.close();
      if (source === es) source = null;
      if (disposed || !isOnline()) return;
      // A closed stream may mean the session ended: let the gate find out.
      if (attempt >= 1) void qc.invalidateQueries({ queryKey: qk.me() });
      retryTimer = setTimeout(connect, backoffDelay(attempt++));
    };
  };

  const onOffline = () => close();
  const onOnline = () => {
    close();
    attempt = 0;
    connect();
  };
  window.addEventListener("offline", onOffline);
  window.addEventListener("online", onOnline);
  connect();

  return () => {
    disposed = true;
    window.removeEventListener("offline", onOffline);
    window.removeEventListener("online", onOnline);
    close();
    scheduled.forEach((timer) => clearTimeout(timer));
    scheduled.clear();
  };
}

/** Live tree/comment/member updates for the current workspace. Mount once, in the workspace shell. */
export function useWorkspaceEvents(workspaceId: string | undefined): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId) return;
    return connectWorkspaceEvents({ workspaceId, queryClient: qc });
  }, [workspaceId, qc]);
}
