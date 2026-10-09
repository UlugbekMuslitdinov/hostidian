import type { WorkspaceEvent } from "@hostidian/api-types";

/**
 * Tiny pub/sub for workspace SSE events. The connection (use-workspace-events) publishes every
 * parsed event here after applying its own cache patches, so feature code can react without
 * opening a second EventSource. Wave 2 (comments, graph, backlinks) subscribes via this.
 */
type Listener = (event: WorkspaceEvent) => void;

const listeners = new Set<Listener>();

export function onWorkspaceEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishWorkspaceEvent(event: WorkspaceEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      console.error("workspace event listener failed", error);
    }
  }
}
