/**
 * End-to-end test of the real service: Hocuspocus server + Postgres (testcontainers, schema from the Go migration) +
 * a stub standing in for the Go API + real @hocuspocus/provider clients over WebSockets.
 * Skipped (loudly) when Docker is not available.
 */
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HocuspocusProvider } from "@hocuspocus/provider";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import WebSocket from "ws";
import * as Y from "yjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { blocksToMarkdown, markdownToBlocks, replaceYDocBlocks, yDocToBlocks } from "@hostidian/editor-schema";
import { documentNameFor } from "./auth";
import { createCollabServer, type CollabServer } from "./server";
import { INTERNAL_TOKEN, PUBLIC_ORIGIN, recordingLogger, signToken, testConfig } from "./test-utils";

function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 30_000 }).status === 0;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();
if (!HAS_DOCKER) {
  console.warn("[collab integration] Docker is not available: skipping the Postgres/WebSocket integration test.");
}

const U_EDITOR = "00000000-0000-4000-8000-0000000000a1";
const U_SECOND = "00000000-0000-4000-8000-0000000000a2";
const U_VIEWER = "00000000-0000-4000-8000-0000000000a3";
const WORKSPACE = "00000000-0000-4000-8000-0000000000b1";
const PAGES = {
  sync: "00000000-0000-4000-8000-0000000000c1",
  readonly: "00000000-0000-4000-8000-0000000000c2",
  persist: "00000000-0000-4000-8000-0000000000c3",
  extract: "00000000-0000-4000-8000-0000000000c4",
  gone: "00000000-0000-4000-8000-0000000000c5",
  apiGone: "00000000-0000-4000-8000-0000000000c6",
  disconnect: "00000000-0000-4000-8000-0000000000c7",
  importLive: "00000000-0000-4000-8000-0000000000c8",
  importCold: "00000000-0000-4000-8000-0000000000c9",
  shutdown: "00000000-0000-4000-8000-0000000000d1",
  target: "00000000-0000-4000-8000-0000000000d2",
  auth: "00000000-0000-4000-8000-0000000000d3",
  missing: "00000000-0000-4000-8000-0000000000ff", // never inserted
} as const;

/** `00001_init.sql` minus goose directives and minus the `Down` section. */
function loadMigration(): string {
  const path = fileURLToPath(new URL("../../backend/migrations/00001_init.sql", import.meta.url));
  const sql = readFileSync(path, "utf8");
  const up = sql.slice(0, sql.indexOf("-- +goose Down"));
  return up
    .split("\n")
    .filter((line) => !line.startsWith("-- +goose"))
    .join("\n");
}

interface ContentPut {
  pageId: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: {
    markdown: string;
    plaintext: string;
    blocks: Array<{ type: string }>;
    linkTargets: string[];
    editorIds: string[];
  };
}

function startStubApi() {
  const puts: ContentPut[] = [];
  const statusByPage = new Map<string, number>();
  const server: HttpServer = createServer((req: IncomingMessage, res) => {
    const match = /^\/internal\/pages\/([0-9a-f-]{36})\/content$/.exec(req.url ?? "");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (!match || req.method !== "PUT") {
        res.writeHead(404).end();
        return;
      }
      const pageId = match[1] as string;
      puts.push({
        pageId,
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(statusByPage.get(pageId) ?? 204).end();
    });
  });
  return {
    puts,
    statusByPage,
    server,
    start: () =>
      new Promise<string>((resolve) =>
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
      ),
    stop: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
    putsFor: (pageId: string) => puts.filter((p) => p.pageId === pageId),
  };
}

function socketClassWithOrigin(origin: string | null) {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, origin ? { headers: { Origin: origin } } : {});
    }
  };
}

describe.skipIf(!HAS_DOCKER)("collab service with Postgres, a stub API and real provider clients", () => {
  let container: StartedTestContainer;
  let db: pg.Client;
  const api = startStubApi();
  const log = recordingLogger();
  let collab: CollabServer;
  let databaseUrl: string;
  let apiUrl: string;

  const providers: HocuspocusProvider[] = [];

  beforeAll(async () => {
    container = await new GenericContainer("postgres:17-alpine")
      .withName(`hostidian-collab-it-${process.pid}-${Date.now()}`)
      .withEnvironment({ POSTGRES_USER: "hostidian", POSTGRES_PASSWORD: "test", POSTGRES_DB: "hostidian" })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    databaseUrl = `postgres://hostidian:test@${container.getHost()}:${container.getMappedPort(5432)}/hostidian`;

    db = new pg.Client({ connectionString: databaseUrl });
    await db.connect();
    await db.query(loadMigration());

    for (const [id, name] of [[U_EDITOR, "Ada"], [U_SECOND, "Grace"], [U_VIEWER, "Vera"]] as const) {
      await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [id, `${name.toLowerCase()}@example.com`, name]);
    }
    await db.query("INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'WS', 'ws', $2)", [WORKSPACE, U_EDITOR]);
    let position = 0;
    for (const id of Object.values(PAGES)) {
      if (id === PAGES.missing) continue;
      await db.query(
        "INSERT INTO pages (id, workspace_id, title, position, created_by) VALUES ($1, $2, $3, $4, $5)",
        [id, WORKSPACE, `Page ${id.slice(-2)}`, `a${position++}`, U_EDITOR],
      );
    }

    apiUrl = await api.start();
    collab = createCollabServer(
      testConfig({ databaseUrl, apiInternalUrl: apiUrl }),
      { logger: log.logger, debounceMs: 80, maxDebounceMs: 400, storeRetryDelayMs: 100, pushRetry: { attempts: 3, baseDelayMs: 20, maxDelayMs: 50 } },
    );
    await collab.start();
  }, 180_000);

  afterEach(async () => {
    for (const provider of providers.splice(0)) provider.destroy();
    api.statusByPage.clear();
    // Let the server notice the closed sockets so documents unload between tests.
    await vi.waitFor(() => expect(collab.hocuspocus.getConnectionsCount()).toBe(0), { timeout: 10_000 });
  });

  afterAll(async () => {
    await collab?.stop();
    await api.stop();
    await db?.end();
    await container?.stop();
  }, 60_000);

  // ---- helpers -------------------------------------------------------------------------------------------------

  interface Client {
    doc: Y.Doc;
    provider: HocuspocusProvider;
    events: { authenticated: string[]; failed: string[]; closed: Array<{ code: number; reason: string }>; tokens: number };
    synced: Promise<void>;
  }

  function connect(
    pageId: string,
    options: { userId?: string; name?: string; role?: string; origin?: string | null; token?: () => Promise<string>; port?: number } = {},
  ): Client {
    const doc = new Y.Doc();
    const events: Client["events"] = { authenticated: [], failed: [], closed: [], tokens: 0 };
    const origin = options.origin === undefined ? PUBLIC_ORIGIN : options.origin;
    // `WebSocketPolyfill` is accepted at runtime (it configures the managed socket) but missing from the public type.
    const configuration = {
      url: `ws://127.0.0.1:${options.port ?? collab.port}/collab`,
      name: documentNameFor(pageId),
      document: doc,
      WebSocketPolyfill: socketClassWithOrigin(origin),
      token:
        options.token ??
        (async () => {
          events.tokens++;
          return signToken({ sub: options.userId ?? U_EDITOR, pageId, role: options.role ?? "edit", name: options.name ?? "Ada" });
        }),
      onAuthenticated: ({ scope }: { scope: string }) => events.authenticated.push(scope),
      onAuthenticationFailed: ({ reason }: { reason: string }) => events.failed.push(reason),
      onClose: ({ event }: { event: { code: number; reason: string } }) => events.closed.push(event),
    };
    const provider = new HocuspocusProvider(configuration as unknown as ConstructorParameters<typeof HocuspocusProvider>[0]);
    providers.push(provider);
    const synced = new Promise<void>((resolve) => {
      if (provider.isSynced) return resolve();
      provider.on("synced", ({ state }: { state: boolean }) => state && resolve());
    });
    return { doc, provider, events, synced };
  }

  const markdownOf = async (doc: Y.Doc) => blocksToMarkdown(await yDocToBlocks(doc));
  const row = async (pageId: string) => (await db.query("SELECT ydoc FROM page_documents WHERE page_id = $1", [pageId])).rows[0] as { ydoc: Buffer } | undefined;
  const stored = async (pageId: string): Promise<Y.Doc> => {
    const r = await row(pageId);
    const doc = new Y.Doc();
    if (r) Y.applyUpdate(doc, new Uint8Array(r.ydoc));
    return doc;
  };

  const setMarkdown = async (doc: Y.Doc, markdown: string) => replaceYDocBlocks(doc, await markdownToBlocks(markdown));

  // ---- tests ---------------------------------------------------------------------------------------------------

  it("syncs edits between two clients, enforces the verified presence identity, and persists", async () => {
    const a = connect(PAGES.sync, { userId: U_EDITOR, name: "Ada" });
    const b = connect(PAGES.sync, { userId: U_SECOND, name: "Grace" });
    await Promise.all([a.synced, b.synced]);
    expect(a.events.authenticated).toEqual(["read-write"]);

    await setMarkdown(a.doc, "# Shared\n\nwritten by Ada");
    await vi.waitFor(async () => expect(await markdownOf(b.doc)).toContain("written by Ada"));

    // and back the other way, on top of the first edit
    b.doc.getText("side").insert(0, "from Grace");
    await vi.waitFor(() => expect(a.doc.getText("side").toString()).toBe("from Grace"));

    // A client cannot claim someone else's identity in presence.
    a.provider.setAwarenessField("user", { name: "Mallory", color: "#000000", id: "spoofed" });
    await vi.waitFor(() => {
      const seen = [...b.provider.awareness!.getStates().values()].map((s) => (s as { user?: { name: string; id: string } }).user);
      expect(seen).toContainEqual(expect.objectContaining({ name: "Ada", id: U_EDITOR }));
      expect(seen.some((u) => u?.name === "Mallory")).toBe(false);
    });

    await vi.waitFor(async () => expect(await row(PAGES.sync)).toBeDefined());
    const persisted = await stored(PAGES.sync);
    expect(await markdownOf(persisted)).toContain("written by Ada");
    expect(persisted.getText("side").toString()).toBe("from Grace");
  });

  it("keeps read-only roles from changing the document", async () => {
    const editor = connect(PAGES.readonly, { userId: U_EDITOR, role: "edit" });
    const viewer = connect(PAGES.readonly, { userId: U_VIEWER, role: "view" });
    const commenter = connect(PAGES.readonly, { userId: U_SECOND, role: "comment" });
    await Promise.all([editor.synced, viewer.synced, commenter.synced]);
    expect(viewer.events.authenticated).toEqual(["readonly"]);
    expect(commenter.events.authenticated).toEqual(["readonly"]);

    await setMarkdown(editor.doc, "original text");
    await vi.waitFor(async () => expect(await markdownOf(viewer.doc)).toContain("original text"));
    await vi.waitFor(async () => expect(await markdownOf(commenter.doc)).toContain("original text"));

    // Local edits on read-only clients must never reach the server or anyone else.
    viewer.doc.getText("forbidden").insert(0, "viewer was here");
    commenter.doc.getText("forbidden").insert(0, "commenter was here");
    editor.doc.getText("allowed").insert(0, "editor still works");
    await vi.waitFor(() => expect(viewer.doc.getText("allowed").toString()).toBe("editor still works"));

    expect(editor.doc.getText("forbidden").toString()).toBe("");
    await vi.waitFor(async () => expect(await row(PAGES.readonly)).toBeDefined());
    const persisted = await stored(PAGES.readonly);
    expect(persisted.getText("forbidden").toString()).toBe("");
    expect(persisted.getText("allowed").toString()).toBe("editor still works");

    // A fresh editor connecting later does not see the rejected edits either.
    const late = connect(PAGES.readonly, { userId: U_EDITOR });
    await late.synced;
    expect(late.doc.getText("forbidden").toString()).toBe("");
  });

  it("keeps the document across disconnects and server-side unloading", async () => {
    const first = connect(PAGES.persist);
    await first.synced;
    await setMarkdown(first.doc, "# Durable\n\nsurvives reconnects");
    await vi.waitFor(async () => expect(await row(PAGES.persist)).toBeDefined());
    const rowBefore = await row(PAGES.persist);

    first.provider.destroy();
    providers.splice(providers.indexOf(first.provider), 1);
    await vi.waitFor(() => expect(collab.hocuspocus.getDocumentsCount()).toBe(0), { timeout: 10_000 });

    const second = connect(PAGES.persist);
    await second.synced;
    expect(await markdownOf(second.doc)).toBe("# Durable\n\nsurvives reconnects");
    expect((await row(PAGES.persist))?.ydoc.equals(rowBefore!.ydoc)).toBe(true);
  });

  it("pushes the extracted content to the API with the right payload and credentials", async () => {
    const editor = connect(PAGES.extract, { userId: U_EDITOR, name: "Ada" });
    const second = connect(PAGES.extract, { userId: U_SECOND, name: "Grace" });
    await Promise.all([editor.synced, second.synced]);

    await setMarkdown(editor.doc, `# Plan\n\nSee [[hostidian:${PAGES.target}|Target page]] and **bold** text.`);
    await vi.waitFor(async () => expect(await markdownOf(second.doc)).toContain("Target page"));
    // second user edits afterwards, inside the same debounce window or the next
    second.doc.getText("note").insert(0, "x");

    await vi.waitFor(() => expect(api.putsFor(PAGES.extract).length).toBeGreaterThan(0), { timeout: 10_000 });
    const put = api.putsFor(PAGES.extract).at(-1)!;
    expect(put.authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(put.contentType).toBe("application/json");
    expect(put.body.markdown).toBe(`# Plan\n\nSee [[hostidian:${PAGES.target}|Target page]] and **bold** text.`);
    expect(put.body.plaintext).toBe("Plan\nSee Target page and bold text.");
    expect(put.body.linkTargets).toEqual([PAGES.target]);
    expect(put.body.blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
    expect(put.body.editorIds.length).toBeGreaterThan(0);
    expect(new Set(put.body.editorIds)).toEqual(new Set([U_EDITOR, U_SECOND].slice(0, put.body.editorIds.length)));
    // most recent editor first: Grace edited last
    if (put.body.editorIds.length === 2) expect(put.body.editorIds).toEqual([U_SECOND, U_EDITOR]);

    // nothing visible changed => no further push for the same content
    const pushes = api.putsFor(PAGES.extract).length;
    second.doc.getText("note").insert(0, "y"); // not part of the BlockNote fragment
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.putsFor(PAGES.extract).length).toBe(pushes);
  });

  it("refuses bad origins, expired tokens and tokens for another page", async () => {
    const foreign = connect(PAGES.auth, { origin: "https://evil.example.com" });
    const noOrigin = connect(PAGES.auth, { origin: null });
    const expired = connect(PAGES.auth, { token: () => signToken({ pageId: PAGES.auth, expiresIn: -120 }) });
    const wrongPage = connect(PAGES.auth, { token: () => signToken({ pageId: PAGES.sync }) });
    const wrongSecret = connect(PAGES.auth, { token: () => signToken({ pageId: PAGES.auth, secret: "x".repeat(40) }) });

    await vi.waitFor(() => {
      expect(expired.events.failed).toContain("token-expired");
      expect(wrongPage.events.failed).toContain("forbidden-page");
      expect(wrongSecret.events.failed).toContain("unauthorized");
    });
    // origin problems are refused at the HTTP upgrade, before any WebSocket exists
    await vi.waitFor(() => expect(log.lines.filter((l) => l.msg === "websocket upgrade refused").length).toBeGreaterThanOrEqual(2));
    for (const client of [foreign, noOrigin, expired, wrongPage, wrongSecret]) {
      expect(client.events.authenticated).toEqual([]);
      expect(client.provider.isSynced).toBe(false);
    }
    expect(collab.hocuspocus.getDocumentsCount()).toBe(0);
    expect(JSON.stringify(log.lines)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT ever reaches the logs
  });

  it("closes connections and drops the document when the page row disappears (FK violation)", async () => {
    const survivor = connect(PAGES.sync);
    const doomed = connect(PAGES.gone);
    await Promise.all([survivor.synced, doomed.synced]);

    await db.query("DELETE FROM pages WHERE id = $1", [PAGES.gone]);
    await setMarkdown(doomed.doc, "this page was deleted meanwhile");

    await vi.waitFor(() => expect(doomed.events.closed.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(await row(PAGES.gone)).toBeUndefined();
    expect(api.putsFor(PAGES.gone)).toEqual([]);

    // the service keeps serving other pages
    survivor.doc.getText("alive").insert(0, "still here");
    const other = connect(PAGES.sync);
    await other.synced;
    await vi.waitFor(() => expect(other.doc.getText("alive").toString()).toBe("still here"));
  });

  it("closes connections when the API reports the page as gone (404)", async () => {
    api.statusByPage.set(PAGES.apiGone, 404);
    const client = connect(PAGES.apiGone);
    await client.synced;
    await setMarkdown(client.doc, "content for a page the API no longer knows");

    await vi.waitFor(() => expect(client.events.closed.length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(api.putsFor(PAGES.apiGone)).toHaveLength(1); // 404 is final: no retries
    await vi.waitFor(() => expect(collab.hocuspocus.getDocumentsCount()).toBe(0), { timeout: 10_000 });
  });

  it("retries pushes while the API is failing and delivers once it recovers", async () => {
    api.statusByPage.set(PAGES.extract, 503);
    const before = api.putsFor(PAGES.extract).length;
    const client = connect(PAGES.extract);
    await client.synced;
    await setMarkdown(client.doc, "# Retry me");
    await vi.waitFor(() => expect(api.putsFor(PAGES.extract).length).toBeGreaterThan(before), { timeout: 10_000 });
    api.statusByPage.delete(PAGES.extract);
    await vi.waitFor(() => expect(api.putsFor(PAGES.extract).at(-1)?.body.markdown).toBe("# Retry me"), { timeout: 10_000 });
  });

  describe("POST /internal/disconnect", () => {
    const internal = (path: string, body: unknown, token = INTERNAL_TOKEN) =>
      fetch(`http://127.0.0.1:${collab.internalPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    it("closes live connections so clients must re-authenticate and pick up their new role", async () => {
      let role = "edit";
      const client = connect(PAGES.disconnect, {
        userId: U_SECOND,
        token: async () => signToken({ sub: U_SECOND, pageId: PAGES.disconnect, role }),
      });
      const bystander = connect(PAGES.disconnect, { userId: U_EDITOR });
      await Promise.all([client.synced, bystander.synced]);
      expect(client.events.authenticated).toEqual(["read-write"]);

      role = "view"; // the API revoked edit access, then asks collab to cut the connection
      const res = await internal("/internal/disconnect", { pageId: PAGES.disconnect, userId: U_SECOND, reason: "permissions_changed" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ closed: 1 });
      await vi.waitFor(() => expect(client.events.closed.map((e) => e.reason)).toContain("permissions_changed"));
      expect(bystander.events.closed).toEqual([]);

      // The socket was closed, so the provider reconnects by itself and calls the token callback again.
      await vi.waitFor(() => expect(client.events.authenticated).toEqual(["read-write", "readonly"]), { timeout: 10_000 });

      client.doc.getText("denied").insert(0, "no longer allowed");
      bystander.doc.getText("ok").insert(0, "fine");
      await vi.waitFor(() => expect(client.doc.getText("ok").toString()).toBe("fine"));
      expect(bystander.doc.getText("denied").toString()).toBe("");
    });

    it("rejects calls without the internal token", async () => {
      expect((await internal("/internal/disconnect", { pageId: PAGES.disconnect }, "wrong")).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${collab.internalPort}/internal/health`)).status).toBe(200);
    });
  });

  describe("POST /internal/import-markdown", () => {
    const importMarkdown = (body: unknown) =>
      fetch(`http://127.0.0.1:${collab.internalPort}/internal/import-markdown`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL_TOKEN}` },
        body: JSON.stringify(body),
      });

    it("replaces the document of a page nobody has open, persists it and pushes its content", async () => {
      const markdown = `# Imported\n\n> [!tip] A tip\n\nLink to [[hostidian:${PAGES.target}|Target page]].`;
      const res = await importMarkdown({ pageId: PAGES.importCold, markdown, editorId: U_EDITOR });
      expect(res.status).toBe(204);

      // done by the time the request returned: DB row and API push are both there
      expect(await markdownOf(await stored(PAGES.importCold))).toBe(markdown);
      const put = api.putsFor(PAGES.importCold)[0];
      expect(put?.body.markdown).toBe(markdown);
      expect(put?.body.linkTargets).toEqual([PAGES.target]);
      expect(put?.body.editorIds).toEqual([U_EDITOR]);
      expect(put?.body.blocks.map((b) => b.type)).toEqual(["heading", "callout", "paragraph"]);

      // idempotent: importing again replaces instead of appending
      expect((await importMarkdown({ pageId: PAGES.importCold, markdown: "# Second import" })).status).toBe(204);
      expect(await markdownOf(await stored(PAGES.importCold))).toBe("# Second import");

      const client = connect(PAGES.importCold);
      await client.synced;
      expect(await markdownOf(client.doc)).toBe("# Second import");
    });

    it("replaces the content under connected clients without duplicating it", async () => {
      const client = connect(PAGES.importLive);
      await client.synced;
      await setMarkdown(client.doc, "# Old\n\nold paragraph");
      await vi.waitFor(async () => expect(await row(PAGES.importLive)).toBeDefined());

      expect((await importMarkdown({ pageId: PAGES.importLive, markdown: "# New\n\nnew paragraph" })).status).toBe(204);
      await vi.waitFor(async () => expect(await markdownOf(client.doc)).toBe("# New\n\nnew paragraph"));
      expect(await markdownOf(await stored(PAGES.importLive))).toBe("# New\n\nnew paragraph");

      // a client that reconnects afterwards agrees with the server (no CRDT duplication)
      const late = connect(PAGES.importLive);
      await late.synced;
      expect(await markdownOf(late.doc)).toBe("# New\n\nnew paragraph");
    });

    it("answers 404 for a page that does not exist and 422 for malformed requests", async () => {
      const missing = await importMarkdown({ pageId: PAGES.missing, markdown: "# x" });
      expect(missing.status).toBe(404);
      expect(api.putsFor(PAGES.missing)).toEqual([]);
      expect((await importMarkdown({ pageId: "nope", markdown: "# x" })).status).toBe(422);
    });

    it("fails (502-class) instead of claiming success when the API push cannot be delivered", async () => {
      api.statusByPage.set(PAGES.importCold, 500);
      const res = await importMarkdown({ pageId: PAGES.importCold, markdown: "# will not be acknowledged" });
      expect(res.status).toBe(500);
    });
  });

  it("flushes pending stores and pushes on graceful shutdown", async () => {
    // A separate instance whose debounce is far longer than the test, so only the shutdown can store the edit.
    const slow = createCollabServer(testConfig({ databaseUrl, apiInternalUrl: apiUrl }), {
      logger: log.logger,
      debounceMs: 60_000,
      maxDebounceMs: 60_000,
    });
    await slow.start();
    const client = connect(PAGES.shutdown, { port: slow.port });
    await client.synced;
    await setMarkdown(client.doc, "# Last words");
    await vi.waitFor(() => expect(client.provider.hasUnsyncedChanges).toBe(false));
    expect(await row(PAGES.shutdown)).toBeUndefined();

    await slow.stop();

    expect(await markdownOf(await stored(PAGES.shutdown))).toBe("# Last words");
    expect(api.putsFor(PAGES.shutdown).at(-1)?.body.markdown).toBe("# Last words");
    await expect(fetch(`http://127.0.0.1:${slow.internalPort}/internal/health`)).rejects.toBeDefined();
  });
});
