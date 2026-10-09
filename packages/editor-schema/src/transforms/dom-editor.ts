import { BlockNoteEditor } from "@blocknote/core";
import { schema, type HBlock } from "../schema";

export type HEditor = BlockNoteEditor<
  typeof schema.blockSchema,
  typeof schema.inlineContentSchema,
  typeof schema.styleSchema
>;

let coreEditor: HEditor | undefined;

/**
 * Headless editor used for everything that does not touch the DOM (ProseMirror <-> blocks <-> Y.Doc). Pure core, so it
 * is safe to import in the browser bundle too.
 */
export function getCoreEditor(): HEditor {
  coreEditor ??= BlockNoteEditor.create({ schema });
  return coreEditor;
}

/** What the Markdown transforms need from BlockNote; both implementations need a DOM, hence "engine". */
export interface MarkdownEngine {
  parse(markdown: string): Promise<HBlock[]>;
  serialize(blocks: unknown[]): Promise<string>;
}

// Decided once, at import time: ServerBlockNoteEditor swaps `document` in and out while it works, so checking per call
// could mistake that temporary jsdom for a real browser DOM.
const HAS_NATIVE_DOM = typeof document !== "undefined";

async function createEngine(): Promise<MarkdownEngine> {
  if (HAS_NATIVE_DOM) {
    // Browser (or a jsdom vitest environment): BlockNote can use the real DOM directly.
    const editor = getCoreEditor();
    return {
      parse: async (markdown) => editor.tryParseMarkdownToBlocks(markdown) as unknown as HBlock[],
      serialize: async (blocks) => editor.blocksToMarkdownLossy(blocks as never),
    };
  }
  // Node: @blocknote/server-util (jsdom) is loaded lazily and through a non-literal specifier so that bundlers for the
  // browser (Next/webpack/Turbopack) neither resolve nor ship jsdom when `web` imports this package.
  const specifier = "@blocknote/server-util";
  const { ServerBlockNoteEditor } = (await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier
  )) as typeof import("@blocknote/server-util");
  const server = ServerBlockNoteEditor.create({ schema });
  return {
    parse: async (markdown) => (await server.tryParseMarkdownToBlocks(markdown)) as unknown as HBlock[],
    serialize: (blocks) => server.blocksToMarkdownLossy(blocks as never),
  };
}

let engine: Promise<MarkdownEngine> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` with the Markdown engine, one operation at a time.
 *
 * ServerBlockNoteEditor swaps `globalThis.window/document` for a jsdom instance while its async functions run;
 * interleaved calls would restore the globals under each other. So every DOM-backed operation goes through this FIFO
 * queue. Never call `withMarkdownEngine` from inside `fn` (it would wait on itself).
 */
export function withMarkdownEngine<T>(fn: (engine: MarkdownEngine) => Promise<T>): Promise<T> {
  engine ??= createEngine().catch((error: unknown) => {
    engine = undefined; // allow a retry after a failed (e.g. transient import) start
    throw error;
  });
  const loaded = engine;
  const run = queue.then(async () => fn(await loaded));
  queue = run.catch(() => undefined);
  return run;
}
