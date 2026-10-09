# @hostidian/editor-schema — interface contract

Single source of truth for the **BlockNote schema** and the **document ⇄ blocks ⇄ Markdown** transforms. It is imported by:

- `web` (editor UI, public read-only page renderer) — browser, React
- `collab` (Hocuspocus extraction + Markdown import) — Node, no DOM

Owner: the **collab** agent (wave 1). The web agents consume it read-only; if they need changes they request them.

Source is consumed directly as TypeScript (`exports` map below); `web` must list it in `transpilePackages`, `collab` bundles it inline with esbuild (`collab/dist/server.js`).

## Status: implemented (spike result: the React-spec approach works server-side)

`ServerBlockNoteEditor` (`@blocknote/server-util`) handles the custom **React** specs on Node 22 without a provider, so the
README fallback (vanilla DOM specs) was **not** needed. One schema, one set of specs, used by `web` and `collab`.

Facts that matter for consumers:

- **Node >= 22.12 is required** for anything that runs vitest/vite 8 or jsdom 29 (`@blocknote/server-util` -> jsdom 29 needs
  Node ^20.19 || ^22.13). Node 20.11 cannot run the tests or the Markdown transforms. Docker images target Node 22.
- BlockNote does **not** serialise custom nodes to Markdown (a `pageLink` exports as its bare title, a `callout` as its icon
  glyph + text). The transforms therefore swap both for alphanumeric placeholder tokens before calling BlockNote and restore the
  real syntax afterwards (and the reverse on import). Callouts are rendered/parsed by this package itself, recursively, so
  multi-paragraph callouts with lists/code/nested callouts round-trip.
- Rendering custom React specs through `ServerBlockNoteEditor` *without* `withReactContext` leaves a deferred React task that
  crashes (`window.event` of undefined) after the jsdom globals are restored. The transforms never render custom specs (tokens
  only), so this cannot happen through this package's API. If you ever call `blocksToFullHTML`/`blocksToHTMLLossy` yourself on
  Node, wrap it in `editor.withReactContext(...)` (see `src/render.test.tsx`).
- The Markdown functions use the real DOM when one exists (browser, jsdom test env) and otherwise lazy-load
  `@blocknote/server-util` through a non-literal `import()`; so importing this package from `web` does **not** drag jsdom into the
  browser bundle. The Y.Doc functions use only `@blocknote/core` (+ `y-prosemirror`, a peer of `@blocknote/core/yjs`).
- DOM-backed conversions run one at a time through an internal FIFO queue (server-util swaps `globalThis.window/document`).

## Entry points (`package.json` `exports`)

| Import | Contents |
|---|---|
| `@hostidian/editor-schema` | `schema`, `HBlock`/`HPartialBlock`/`HInlineContent`/`HSchema` types, `YDOC_FRAGMENT`, `CALLOUT_KINDS`, `PageLinkContext`, and all transforms (below) |
| `@hostidian/editor-schema/react` | `schema`, `PageLinkContext` (+ types), `pageLinkSpec`, `createCalloutBlockSpec`, `YDOC_FRAGMENT`, `CALLOUT_KINDS` |
| `@hostidian/editor-schema/styles.css` | Styles for the callout block and page-link chip (CSS variables `--callout-*`, `--page-link-*`; dark under `.dark`, `[data-theme=dark]`, `[data-color-scheme=dark]`) |

## How `web` wires it up

```tsx
import "@hostidian/editor-schema/styles.css";
import { withCollaboration } from "@blocknote/core/yjs";
import { schema, PageLinkContext, YDOC_FRAGMENT } from "@hostidian/editor-schema/react";

// BlockNote 0.55 has NO `collaboration` editor option any more: wrap the options in `withCollaboration` (it also swaps the
// local history for Yjs undo and sets the initial block). Passing `{ collaboration }` straight to useCreateBlockNote
// silently gives you an editor that is not connected to the Y.Doc.
const editor = useCreateBlockNote(
  withCollaboration({
    schema,                                            // the SAME object for the editor and the read-only public renderer
    collaboration: { provider, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { name, color } },
  }),
  [doc, provider],
);

<PageLinkContext.Provider value={{ resolve: (id) => cache.get(id) /* {title, icon?} */, onNavigate: (id) => router.push(...) }}>
  <BlockNoteView editor={editor} />
</PageLinkContext.Provider>
```

`src/browser-parity.test.ts` mounts exactly such an editor in jsdom and checks that collab's headless converters read what it wrote.

- Insert a link with `editor.insertInlineContent([{ type: "pageLink", props: { pageId, title } }, " "])`; insert a callout with
  `editor.insertBlocks([{ type: "callout", props: { kind: "tip" } }], ref, "after")` (add both to the slash menu / `[[` picker).
- The chip shows `resolve(pageId)?.title`, falling back to the title stored in the node (offline, deleted page, SSR, public
  pages). The callout's icon button cycles `note -> tip -> warning -> danger` while the editor is editable.
- `web` needs `y-prosemirror` and `y-protocols` as direct dependencies (peers of `@blocknote/core`) so pnpm resolves **one**
  `@blocknote/core` instance shared with this package; `transpilePackages: ["@hostidian/editor-schema"]`.

## Exports

```ts
export const YDOC_FRAGMENT = "blocknote";
export const schema;                                   // default blocks + `callout` block + `pageLink` inline content
export type HBlock, HPartialBlock, HInlineContent, HSchema;

export function markdownToBlocks(markdown: string): Promise<HBlock[]>;
export function blocksToMarkdown(blocks: HBlock[]): Promise<string>;
export function blocksToPlaintext(blocks: HBlock[]): string;          // visible text only
export function extractPageLinkIds(blocks: HBlock[]): string[];       // distinct, lower-case, document order
export function yDocToBlocks(doc: Y.Doc): Promise<HBlock[]>;          // reads YDOC_FRAGMENT from a COPY of the doc
export function blocksToYDocUpdate(blocks: HBlock[]): Promise<Uint8Array>; // fresh doc -> encodeStateAsUpdate
export function replaceYDocBlocks(doc: Y.Doc, blocks: HBlock[]): void; // in-place diff on a live doc (used by import)

export const PageLinkContext: React.Context<{
  resolve(pageId: string): { title: string; icon?: string | null } | undefined;
  onNavigate(pageId: string): void;
}>;
```

Custom nodes: inline `pageLink` props `{ pageId: string (uuid), title: string }` (atomic); block `callout` props
`{ kind: "note" | "tip" | "warning" | "danger" }`, inline content, may have children.

`yDocToBlocks` reads a copy because y-prosemirror repairs invalid structure while reading (it can delete nodes / merge Y.Text),
and a read must never write to a live shared doc. `blocksToYDocUpdate` creates a doc with **no shared history**: never apply it
to a doc that clients already hold (their content would be duplicated) - use `replaceYDocBlocks` for that.

## Markdown dialect (matches `docs/conventions.md` §8)

- **Page link**: `[[hostidian:<uuid>|<title>]]`. In the title `\` and `]` are backslash-escaped; inside table rows every pipe
  (the id/title separator and any in the title) is written `\|`. Import accepts either separator. Newlines in titles become
  spaces. A link without a valid uuid exports as its plain title.
- **Image**: `![alt](/api/files/<attachmentId>)` (alt = caption, else file name).
- **File / audio / video**: `[name](/api/files/<attachmentId>)` (they come back as links, not file blocks).
- **Callout**: `> [!note] text` (also `tip` / `warning` / `danger`). Body blocks follow after a `>` line, every line prefixed
  with `> ` (lists, code and nested callouts are allowed).
- **Everything else**: what BlockNote's `blocksToMarkdownLossy` / `tryParseMarkdownToBlocks` produce (GFM).

Import extras: Obsidian callout types are mapped (`info/todo/abstract/example -> note`, `hint/important/success -> tip`,
`caution/attention/question/help -> warning`, `error/failure/bug -> danger`, unknown -> `note`); `+`/`-` fold markers and a callout
title (text after `[!x]`) are accepted (the title becomes the callout text); fenced/inline code is never rewritten; unknown
`[[...]]` forms stay plain text; BlockNote's phantom empty table header row and the stray space after a hard break are removed.

Known BlockNote limitations (inherent to its lossy exporter, not fixed here): special characters in text are not escaped on export
(`*x*` typed literally comes back italic), underline/text colour/background are dropped, non-list children of a block are
un-nested, tables lose cell merges and column widths.

## Tests

`pnpm -F @hostidian/editor-schema test` (needs Node >= 22.12): Markdown round trips (nested lists, code, tables, images, hard breaks),
page-link escaping edge cases, callouts (multi-paragraph, nested, Obsidian aliases), link extraction, plaintext, Y.Doc <-> blocks,
in-place replacement merging across peers, concurrent conversions, native-DOM path, server rendering with and without a provider.
