/**
 * `POST /internal/apply-markdown` against a real Hocuspocus server and real `HocuspocusProvider` clients, with an
 * in-memory document store and a stub API (no Docker needed).
 */
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HocuspocusProvider } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { blocksToMarkdown, markdownToBlocks, replaceYDocBlocks, yDocToBlocks } from "@hostidian/editor-schema";
import { documentNameFor } from "./auth";
import type { PageDocumentStore } from "./persistence";
import { createCollabServer, type CollabServer } from "./server";
import { INTERNAL_TOKEN, PUBLIC_ORIGIN, USER_ID, OTHER_USER_ID, signToken, silentLogger, testConfig } from "./test-utils";

const PAGE = (n: number) => `00000000-0000-4000-8000-00000000ff${String(n).padStart(2, "0")}`;
const MISSING = PAGE(99);
const EDITOR = "00000000-0000-4000-8000-0000000000e1";

interface Put {
  pageId: string;
  body: { markdown: string; editorIds: string[]; linkTargets: string[] };
}

describe("POST /internal/apply-markdown", () => {
  const rows = new Map<string, Uint8Array>();
  const puts: Put[] = [];
  const store: PageDocumentStore = {
    async load(pageId) {
      return rows.get(pageId) ?? null;
    },
    async save(pageId, state) {
      if (pageId === MISSING) return "page_gone";
      rows.set(pageId, state);
      return "stored";
    },
  };
  let api: HttpServer;
  let collab: CollabServer;
  const providers: HocuspocusProvider[] = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      const match = /^\/internal\/pages\/([0-9a-f-]{36})\/content$/.exec(req.url ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (match && req.method === "PUT") puts.push({ pageId: match[1] as string, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        res.writeHead(match ? 204 : 404).end();
      });
    });
    const apiUrl = await new Promise<string>((resolve) =>
      api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(api.address() as AddressInfo).port}`)),
    );
    collab = createCollabServer(testConfig({ apiInternalUrl: apiUrl }), {
      logger: silentLogger,
      store,
      debounceMs: 50,
      maxDebounceMs: 200,
      pushRetry: { attempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
    });
    await collab.start();
  });

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    await vi.waitFor(() => expect(collab.hocuspocus.getConnectionsCount()).toBe(0), { timeout: 10_000 });
  });

  afterAll(async () => {
    await collab.stop();
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });

  const apply = (body: Record<string, unknown>, token = INTERNAL_TOKEN) =>
    fetch(`http://127.0.0.1:${collab.internalPort}/internal/apply-markdown`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ editorId: EDITOR, ...body }),
    });
  const applyOk = async (pageId: string, mode: string, markdown: string) => {
    const res = await apply({ pageId, mode, markdown });
    expect(res.status).toBe(200);
    return ((await res.json()) as { markdown: string }).markdown;
  };

  function connect(pageId: string, userId = USER_ID) {
    const doc = new Y.Doc();
    const configuration = {
      url: `ws://127.0.0.1:${collab.port}/collab`,
      name: documentNameFor(pageId),
      document: doc,
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { Origin: PUBLIC_ORIGIN } });
        }
      },
      token: () => signToken({ sub: userId, pageId, role: "edit", name: "Ada" }),
    };
    const provider = new HocuspocusProvider(configuration as unknown as ConstructorParameters<typeof HocuspocusProvider>[0]);
    providers.push(provider);
    const synced = new Promise<void>((resolve) => {
      if (provider.isSynced) return resolve();
      provider.on("synced", ({ state }: { state: boolean }) => state && resolve());
    });
    return { doc, provider, synced };
  }

  const markdownOf = async (doc: Y.Doc) => blocksToMarkdown(await yDocToBlocks(doc));
  const storedMarkdown = async (pageId: string) => {
    const doc = new Y.Doc();
    const state = rows.get(pageId);
    if (state) Y.applyUpdate(doc, state);
    return markdownOf(doc);
  };
  const seed = async (doc: Y.Doc, markdown: string) => replaceYDocBlocks(doc, await markdownToBlocks(markdown));

  it("appends, prepends and replaces on a page nobody has open, persisting and pushing each time", async () => {
    const page = PAGE(1);
    // the first edit of an empty page replaces the blank starting paragraph instead of leaving it in front
    expect(await applyOk(page, "append", "# Notes\n\nfirst")).toBe("# Notes\n\nfirst");
    expect(await applyOk(page, "append", "second")).toBe("# Notes\n\nfirst\n\nsecond");
    expect(await applyOk(page, "prepend", "> [!tip] Read me")).toBe("> [!tip] Read me\n\n# Notes\n\nfirst\n\nsecond");
    expect(await applyOk(page, "replace", "# Fresh\n\nonly this")).toBe("# Fresh\n\nonly this");

    expect(await storedMarkdown(page)).toBe("# Fresh\n\nonly this");
    const last = puts.filter((p) => p.pageId === page).at(-1);
    expect(last?.body.markdown).toBe("# Fresh\n\nonly this");
    expect(last?.body.editorIds).toEqual([EDITOR]);
  });

  it("two sequential edits accumulate", async () => {
    const page = PAGE(2);
    await applyOk(page, "append", "one");
    await applyOk(page, "append", "two");
    expect(await storedMarkdown(page)).toBe("one\n\ntwo");
  });

  it("is a no-op for empty append/prepend input", async () => {
    const page = PAGE(3);
    await applyOk(page, "replace", "keep me");
    expect(await applyOk(page, "append", "")).toBe("keep me");
    expect(await applyOk(page, "prepend", "   \n")).toBe("keep me");
  });

  it("pushes page links so backlinks stay correct", async () => {
    const page = PAGE(4);
    const target = PAGE(5);
    await applyOk(page, "append", `see [[hostidian:${target}|Target]]`);
    expect(puts.filter((p) => p.pageId === page).at(-1)?.body.linkTargets).toEqual([target]);
  });

  it("a connected editor receives the change live and its own concurrent edits survive", async () => {
    const page = PAGE(6);
    const editor = connect(page);
    await editor.synced;
    await seed(editor.doc, "# Live\n\nhello");
    await vi.waitFor(() => expect(editor.provider.hasUnsyncedChanges).toBe(false));

    const typed = editor.doc.getXmlFragment("blocknote");
    expect(typed.length).toBe(1);

    expect(await applyOk(page, "append", "added by the agent")).toBe("# Live\n\nhello\n\nadded by the agent");
    await vi.waitFor(async () => expect(await markdownOf(editor.doc)).toBe("# Live\n\nhello\n\nadded by the agent"));

    // the editor keeps working on the same document afterwards, and a later replace reaches it too
    await seed(editor.doc, "# Live\n\nhello\n\nadded by the agent\n\ntyped after");
    await vi.waitFor(() => expect(editor.provider.hasUnsyncedChanges).toBe(false));
    expect(await applyOk(page, "replace", "# Live\n\nrewritten")).toBe("# Live\n\nrewritten");
    await vi.waitFor(async () => expect(await markdownOf(editor.doc)).toBe("# Live\n\nrewritten"));

    // a client that connects afterwards agrees (no CRDT duplication)
    const late = connect(page, OTHER_USER_ID);
    await late.synced;
    expect(await markdownOf(late.doc)).toBe("# Live\n\nrewritten");
    expect(await storedMarkdown(page)).toBe("# Live\n\nrewritten");
  });

  it("replace keeps the ids of unchanged blocks so comment anchors survive", async () => {
    const page = PAGE(7);
    const editor = connect(page);
    await editor.synced;
    await seed(editor.doc, "# Title\n\nkeep this\n\nchange this");
    await vi.waitFor(() => expect(editor.provider.hasUnsyncedChanges).toBe(false));
    const before = await yDocToBlocks(editor.doc);

    await applyOk(page, "replace", "# Title\n\nkeep this\n\nchanged!");
    await vi.waitFor(async () => expect(await markdownOf(editor.doc)).toBe("# Title\n\nkeep this\n\nchanged!"));
    const after = await yDocToBlocks(editor.doc);
    expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
  });

  it("merges with a concurrent edit instead of overwriting it", async () => {
    const page = PAGE(8);
    const editor = connect(page);
    await editor.synced;
    await seed(editor.doc, "base");
    await vi.waitFor(() => expect(editor.provider.hasUnsyncedChanges).toBe(false));

    // The editor adds a block while the agent appends: both must survive.
    const [result] = await Promise.all([applyOk(page, "append", "from agent"), seed(editor.doc, "base\n\nfrom editor")]);
    expect(result).toContain("from agent");
    await vi.waitFor(async () => {
      const md = await markdownOf(editor.doc);
      expect(md).toContain("from agent");
      expect(md).toContain("from editor");
    });
  });

  it("answers 404 for a missing page, 422 for bad input and 401 without the internal token", async () => {
    expect((await apply({ pageId: MISSING, mode: "append", markdown: "x" })).status).toBe(404);
    expect((await apply({ pageId: PAGE(1), mode: "sideways", markdown: "x" })).status).toBe(422);
    expect((await apply({ pageId: PAGE(1), mode: "append", markdown: "x" }, "wrong")).status).toBe(401);
  });
});
