/**
 * Browser entry (`@hostidian/editor-schema/react`). The schema itself is the same object as the root export; this
 * entry adds the React pieces `web` needs to wire up page links and callouts.
 */
export { schema, type HBlock, type HPartialBlock, type HSchema } from "./schema";
export { PageLinkContext, type PageLinkContextValue, type PageLinkInfo } from "./page-link-context";
export { pageLinkSpec, createCalloutBlockSpec } from "./specs";
export { CALLOUT_KINDS, YDOC_FRAGMENT, type CalloutKind } from "./constants";
