/**
 * The "new version available" flow. A new service worker installs in the background and then *waits*
 * (sw.ts sets `skipWaiting: false`) so a running session is never swapped under the user's hands. When it
 * is waiting we ask once; on acceptance the page tells it to take over (`SKIP_WAITING`) and reloads as soon as
 * it controls the page.
 *
 * The first-ever install also fires "controlling" (the worker claims the open tab), which must NOT reload
 * the page, hence the `accepted` guard.
 */

/** The slice of `@serwist/window`'s Serwist class this flow needs. */
export interface UpdateSource {
  addEventListener(type: "waiting" | "controlling", listener: () => void): void;
  removeEventListener(type: "waiting" | "controlling", listener: () => void): void;
  messageSkipWaiting(): void;
}

export interface UpdateHooks {
  /** Ask the user. `accept` starts the update; call it from the toast action. */
  prompt(accept: () => void): void;
  reload(): void;
}

/** Returns a function that stops listening. */
export function watchForUpdates(source: UpdateSource, hooks: UpdateHooks): () => void {
  let accepted = false;
  let asking = false;

  const onControlling = () => {
    if (accepted) hooks.reload();
  };

  const accept = () => {
    if (accepted) return;
    accepted = true;
    source.messageSkipWaiting();
  };

  const onWaiting = () => {
    // A second waiting worker (another deploy while the toast is open) replaces the first; ask only once.
    if (asking) return;
    asking = true;
    hooks.prompt(accept);
  };

  source.addEventListener("waiting", onWaiting);
  source.addEventListener("controlling", onControlling);
  return () => {
    source.removeEventListener("waiting", onWaiting);
    source.removeEventListener("controlling", onControlling);
  };
}

/** How often a long-lived tab asks the server whether a new worker exists (browsers only do it on navigation). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
