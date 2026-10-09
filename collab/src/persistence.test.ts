import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import { ContentSync } from "./content-sync";
import {
  DocumentPersister,
  GonePages,
  createPersistenceExtension,
  createPostgresStore,
  withRetry,
  type PageDocumentStore,
  type QueryablePool,
} from "./persistence";
import { documentNameFor } from "./auth";
import { OTHER_USER_ID, PAGE_ID, USER_ID, silentLogger } from "./test-utils";

function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return doc;
}

describe("createPostgresStore", () => {
  it("loads the stored bytes, or null when the page has no document", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ ydoc: bytes }] }));
    const store = createPostgresStore({ query });
    expect(await store.load(PAGE_ID)).toEqual(new Uint8Array([1, 2, 3]));
    expect(query).toHaveBeenCalledWith("SELECT ydoc FROM page_documents WHERE page_id = $1", [PAGE_ID]);

    const empty: QueryablePool = { query: async () => ({ rows: [] }) };
    expect(await createPostgresStore(empty).load(PAGE_ID)).toBeNull();
  });

  it("upserts with bound parameters only", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const result = await createPostgresStore({ query }).save(PAGE_ID, new Uint8Array([9, 8, 7]));
    expect(result).toBe("stored");
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO page_documents/);
    expect(sql).toMatch(/ON CONFLICT \(page_id\) DO UPDATE/);
    expect(sql).not.toContain(PAGE_ID);
    expect(values[0]).toBe(PAGE_ID);
    expect(Buffer.isBuffer(values[1])).toBe(true);
    expect([...(values[1] as Buffer)]).toEqual([9, 8, 7]);
  });

  it("copes with views into larger buffers", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await createPostgresStore({ query }).save(PAGE_ID, backing.subarray(2, 5));
    expect([...((query.mock.calls[0] as unknown as [string, unknown[]])[1][1] as Buffer)]).toEqual([2, 3, 4]);
  });

  it("maps a foreign key violation to page_gone and rethrows everything else", async () => {
    const fk: QueryablePool = {
      query: async () => {
        throw Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
      },
    };
    expect(await createPostgresStore(fk).save(PAGE_ID, new Uint8Array())).toBe("page_gone");

    const down: QueryablePool = {
      query: async () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
    };
    await expect(createPostgresStore(down).save(PAGE_ID, new Uint8Array())).rejects.toThrow("connection refused");
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("retries until success", async () => {
    const fn = vi.fn<(attempt: number) => Promise<string>>().mockRejectedValueOnce(new Error("a")).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep }, onRetry)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error and caps the delay", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error("always");
    });
    await expect(
      withRetry(fn, { attempts: 5, baseDelayMs: 100, maxDelayMs: 300, sleep: async (ms) => void delays.push(ms) }),
    ).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(5);
    expect(delays).toHaveLength(4);
    // 100, 200, 300 (capped), 300 (capped), each with +-20% jitter
    const expected = [100, 200, 300, 300];
    delays.forEach((d, i) => {
      expect(d).toBeGreaterThanOrEqual(expected[i]! * 0.8 - 1);
      expect(d).toBeLessThanOrEqual(expected[i]! * 1.2 + 1);
    });
  });

  it("stops when shouldRetry says no", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(withRetry(fn, { attempts: 5, baseDelayMs: 1, maxDelayMs: 1, shouldRetry: () => false, sleep: noSleep })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("GonePages", () => {
  it("remembers pages until the ttl elapses", () => {
    let now = 1_000;
    const gone = new GonePages(100, () => now);
    expect(gone.has(PAGE_ID)).toBe(false);
    gone.mark(PAGE_ID);
    expect(gone.has(PAGE_ID)).toBe(true);
    now += 99;
    expect(gone.has(PAGE_ID)).toBe(true);
    now += 2;
    expect(gone.has(PAGE_ID)).toBe(false);
  });
});

function harness(overrides: { save?: PageDocumentStore["save"]; load?: PageDocumentStore["load"] } = {}) {
  const saved: Array<{ pageId: string; state: Uint8Array }> = [];
  const store: PageDocumentStore = {
    load: overrides.load ?? (async () => null),
    save:
      overrides.save ??
      (async (pageId, state) => {
        saved.push({ pageId, state });
        return "stored";
      }),
  };
  const pushed: Array<{ pageId: string; editorIds: string[]; markdown: string }> = [];
  const onPageGone = vi.fn();
  const sync = new ContentSync({
    pusher: {
      push: async (pageId, payload) => {
        pushed.push({ pageId, editorIds: payload.editorIds, markdown: payload.markdown });
        return "ok";
      },
    },
    logger: silentLogger,
    onPageGone: () => {},
    extract: async (doc) => ({ markdown: doc.getText("t").toString(), plaintext: "", blocks: [], linkTargets: [] }),
  });
  const gone = new GonePages();
  const persister = new DocumentPersister({
    store,
    sync,
    gone,
    logger: silentLogger,
    onPageGone,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });
  return { store, saved, pushed, sync, gone, persister, onPageGone };
}

describe("DocumentPersister", () => {
  it("stores the state, then pushes the content with the editors since the last store", async () => {
    const { persister, saved, pushed, sync } = harness();
    sync.noteEditor(PAGE_ID, USER_ID);
    sync.noteEditor(PAGE_ID, OTHER_USER_ID);
    expect(await persister.persist(PAGE_ID, makeDoc("hello"), { wait: true })).toBe("stored");

    expect(saved).toHaveLength(1);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, saved[0]!.state);
    expect(restored.getText("t").toString()).toBe("hello");
    expect(pushed).toEqual([{ pageId: PAGE_ID, editorIds: [OTHER_USER_ID, USER_ID], markdown: "hello" }]);
    expect(sync.takeEditors(PAGE_ID)).toEqual([]);
  });

  it("returns before the push finishes when not waiting", async () => {
    const { persister, pushed } = harness();
    expect(await persister.persist(PAGE_ID, makeDoc("x"))).toBe("stored");
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
  });

  it("retries transient database errors", async () => {
    let calls = 0;
    const { persister } = harness({
      save: async () => {
        if (++calls < 3) throw new Error("connection reset");
        return "stored";
      },
    });
    expect(await persister.persist(PAGE_ID, makeDoc("x"))).toBe("stored");
    expect(calls).toBe(3);
  });

  it("throws when the database keeps failing and keeps the editors for the next attempt", async () => {
    const { persister, sync, pushed } = harness({
      save: async () => {
        throw new Error("db down");
      },
    });
    sync.noteEditor(PAGE_ID, USER_ID);
    await expect(persister.persist(PAGE_ID, makeDoc("x"))).rejects.toThrow("db down");
    expect(pushed).toEqual([]);
    expect(sync.takeEditors(PAGE_ID)).toEqual([USER_ID]);
  });

  it("drops the document when the page row is gone (FK violation): no push, connections closed once, later stores skipped", async () => {
    const { persister, pushed, onPageGone, gone } = harness({ save: async () => "page_gone" });
    expect(await persister.persist(PAGE_ID, makeDoc("x"))).toBe("page_gone");
    expect(onPageGone).toHaveBeenCalledExactlyOnceWith(PAGE_ID);
    expect(gone.has(PAGE_ID)).toBe(true);
    expect(pushed).toEqual([]);
    expect(await persister.persist(PAGE_ID, makeDoc("y"))).toBe("page_gone");
    expect(onPageGone).toHaveBeenCalledTimes(1);
  });

  it("reports page_gone to a waiting caller when the API answers 404", async () => {
    const gone = new GonePages();
    const sync = new ContentSync({
      pusher: { push: async () => "not_found" },
      logger: silentLogger,
      onPageGone: (pageId) => gone.mark(pageId),
      extract: async () => ({ markdown: "", plaintext: "", blocks: [], linkTargets: [] }),
    });
    const persister = new DocumentPersister({
      store: { load: async () => null, save: async () => "stored" },
      sync,
      gone,
      logger: silentLogger,
      onPageGone: () => {},
    });
    expect(await persister.persist(PAGE_ID, makeDoc("x"), { wait: true })).toBe("page_gone");
  });
});

describe("persistence extension", () => {
  const documentName = documentNameFor(PAGE_ID);

  function extensionFor(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
    return createPersistenceExtension({ store: h.store, persister: h.persister, sync: h.sync, logger: silentLogger, ...extra });
  }

  it("loads the stored state into the document, and leaves it empty when there is none", async () => {
    const stored = Y.encodeStateAsUpdate(makeDoc("persisted"));
    const withRow = harness({ load: async (pageId) => (pageId === PAGE_ID ? stored : null) });
    const doc = new Y.Doc();
    await extensionFor(withRow).onLoadDocument?.({ document: doc, documentName } as never);
    expect(doc.getText("t").toString()).toBe("persisted");

    const empty = new Y.Doc();
    await extensionFor(harness()).onLoadDocument?.({ document: empty, documentName } as never);
    expect(Y.encodeStateAsUpdate(empty)).toEqual(Y.encodeStateAsUpdate(new Y.Doc()));
  });

  it("fails the load (and never overwrites the row) when the stored bytes are corrupt", async () => {
    const h = harness({ load: async () => new Uint8Array([255, 255, 255, 9, 9]) });
    await expect(extensionFor(h).onLoadDocument?.({ document: new Y.Doc(), documentName } as never)).rejects.toBeDefined();
    expect(h.saved).toEqual([]);
  });

  it("retries database errors while loading and refuses unexpected document names", async () => {
    let calls = 0;
    const h = harness({
      load: async () => {
        if (++calls < 2) throw new Error("transient");
        return null;
      },
    });
    await extensionFor(h).onLoadDocument?.({ document: new Y.Doc(), documentName } as never);
    expect(calls).toBe(2);
    await expect(extensionFor(h).onLoadDocument?.({ document: new Y.Doc(), documentName: "other:1" } as never)).rejects.toThrow(
      /unexpected document name/,
    );
  });

  it("records who changed the document, from connection and local contexts", async () => {
    const h = harness();
    const extension = extensionFor(h);
    const user = (id: string) => ({ user: { id, name: "n", color: "#fff", role: "edit" } });
    await extension.onChange?.({ documentName, context: user(USER_ID) } as never);
    await extension.onChange?.({ documentName, context: user(OTHER_USER_ID) } as never);
    await extension.onChange?.({ documentName, context: {} } as never);
    await extension.onChange?.({ documentName: "nonsense", context: user(USER_ID) } as never);
    expect(h.sync.takeEditors(PAGE_ID)).toEqual([OTHER_USER_ID, USER_ID]);
  });

  it("stores and pushes on onStoreDocument", async () => {
    const h = harness();
    const doc = makeDoc("body");
    await extensionFor(h).onStoreDocument?.({ document: doc, documentName, instance: {} } as never);
    expect(h.saved).toHaveLength(1);
    await vi.waitFor(() => expect(h.pushed).toHaveLength(1));
  });

  it("schedules a new store attempt when the database write fails, without waiting for another edit", async () => {
    let fail = true;
    const h = harness({
      save: async (pageId, state) => {
        if (fail) throw new Error("db down");
        h2.push({ pageId, state });
        return "stored";
      },
    });
    const h2: Array<{ pageId: string; state: Uint8Array }> = [];
    const doc = makeDoc("body");
    const storeDocumentHooks = vi.fn();
    const instance = { documents: new Map([[documentName, doc]]), storeDocumentHooks };
    const payload = { document: doc, documentName, instance };
    const extension = extensionFor(h, { storeRetryDelayMs: 5 });
    await expect(extension.onStoreDocument?.(payload as never)).rejects.toThrow("db down");
    await vi.waitFor(() => expect(storeDocumentHooks).toHaveBeenCalledWith(doc, payload, true));
    fail = false;
  });

  it("forgets cached per-page state when the document is unloaded", async () => {
    const h = harness();
    h.sync.noteEditor(PAGE_ID, USER_ID);
    await extensionFor(h).afterUnloadDocument?.({ documentName } as never);
    expect(h.sync.takeEditors(PAGE_ID)).toEqual([]);
  });
});
