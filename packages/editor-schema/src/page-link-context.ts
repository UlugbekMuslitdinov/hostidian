import { createContext } from "react";

export interface PageLinkInfo {
  title: string;
  icon?: string | null;
}

export interface PageLinkContextValue {
  /** Current title/icon of a page, from the client cache. `undefined` = unknown (offline, deleted, no access). */
  resolve(pageId: string): PageLinkInfo | undefined;
  /** Called when the user activates a page-link chip. */
  onNavigate(pageId: string): void;
}

/**
 * Supplies live page titles/icons to `pageLink` chips and handles navigation.
 * The default value (no provider: server rendering, public pages, tests) resolves nothing, so chips fall back to the
 * title stored in the node, and navigation is a no-op.
 */
export const PageLinkContext = createContext<PageLinkContextValue>({
  resolve: () => undefined,
  onNavigate: () => {},
});
