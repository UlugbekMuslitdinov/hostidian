# @hostidian/editor-schema — interface contract

Single source of truth for the **BlockNote schema** and the **document ⇄ blocks ⇄ Markdown** transforms. It is imported by:

- `web` (editor UI, public read-only page renderer) — browser, React
- `collab` (Hocuspocus extraction + Markdown import) — Node, no DOM

Owner: the **collab** agent (wave 1). The web agents consume it read-only; if they need changes they request them.

Dependencies are already installed (`@blocknote/core`, `@blocknote/react`, `yjs`, `react`, `react-dom`; dev: vitest, typescript, eslint 9). Source is consumed directly as TypeScript (`main`/`types` → `src/index.ts`); `web` must list it in `transpilePackages`, `collab` bundles it via `tsx`/`tsc`.

## Required exports (`src/index.ts`)

```ts
/** Y.Doc XML fragment name BlockNote collaborates on. MUST equal what the editor uses. */
export const YDOC_FRAGMENT = "blocknote";

/** BlockNote schema = default blocks + `callout` block + `pageLink` inline content. */
export const schema: BlockNoteSchema</* … */>;
export type HBlock = typeof schema.Block;
export type HPartialBlock = typeof schema.PartialBlock;

/* ---- custom nodes ------------------------------------------------------------------
 * inline `pageLink`   props: { pageId: string (uuid), title: string }   (atomic, not editable)
 * block  `callout`    props: { kind: "note" | "tip" | "warning" | "danger" }  content: inline
 */

/* ---- server-safe transforms (no DOM; used by collab, tests and web) ------------------ */
export function markdownToBlocks(markdown: string): Promise<HBlock[]>;
export function blocksToMarkdown(blocks: HBlock[]): Promise<string>;
export function blocksToPlaintext(blocks: HBlock[]): string;          // visible text only
export function extractPageLinkIds(blocks: HBlock[]): string[];       // distinct, in document order
export function yDocToBlocks(doc: Y.Doc): Promise<HBlock[]>;          // reads YDOC_FRAGMENT
export function blocksToYDocUpdate(blocks: HBlock[]): Promise<Uint8Array>; // fresh doc -> encodeStateAsUpdate

/* ---- React (browser) — import from "@hostidian/editor-schema/react" --------------- */
export const PageLinkContext: React.Context<{
  resolve(pageId: string): { title: string; icon?: string | null } | undefined;
  onNavigate(pageId: string): void;
}>;
```

## Markdown dialect (must match `docs/conventions.md` §8 exactly)

| Construct | Markdown |
|---|---|
| Page link | `[[hostidian:<uuid>\|<title>]]` (pipe escaped as needed inside tables) |
| Image | `![alt](/api/files/<attachmentId>)` |
| File | `[name](/api/files/<attachmentId>)` |
| Callout | `> [!note] text` / `tip` / `warning` / `danger` (multi-paragraph callouts: continue with `> `) |
| Everything else | what `@blocknote/server-util` `blocksToMarkdownLossy` / `tryParseMarkdownToBlocks` already produce (GFM) |

`markdownToBlocks(blocksToMarkdown(x))` must round-trip page links and callouts losslessly (tested). Unknown `[[…]]` forms (e.g. Obsidian `[[Title]]`) are left as plain text — the Go importer resolves those *before* calling collab.

## React rendering rules

- `pageLink` renders as an inline chip: icon + **current** title from `PageLinkContext.resolve(pageId)`; falls back to the stored `props.title` when the context has no answer (offline, deleted page, server-side rendering, public pages). Clicking calls `onNavigate`.
- The server (`ServerBlockNoteEditor`) renders these specs without a provider — fallbacks must therefore not throw.
- `callout` has an emoji/icon by kind and a tinted background using CSS variables (`--callout-*`) so it themes with light/dark.

## Tests (vitest, in this package)
Round-trip Markdown; link extraction; plaintext; Y.Doc ⇄ blocks; schema renders on the server without a provider.

## Fallback if BlockNote's server-util cannot handle the custom React specs
Keep the schema's inline/block **spec definitions** vanilla (`createInlineContentSpec`/`createBlockSpec` with `render` functions that build DOM nodes) so they work identically on server and client, and drop the React-only `PageLinkContext` in favour of a DOM-level resolver registered by `web`. Document the choice in this README.
