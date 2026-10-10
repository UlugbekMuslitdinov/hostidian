import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures";
import { USER_PASSWORD } from "../helpers/env";
import { uniqueName, uniqueWord } from "../helpers/names";
import { editorOf } from "../helpers/ui";

/**
 * Plan scenario (c): the PWA keeps working without a network. Everything here drives a real Chrome with the
 * production service worker; "offline" is `context.setOffline(true)`, which also cuts the worker's own network.
 */

const status = (page: Page) => page.getByTestId("connection-status");
const treeItem = (page: Page, title: string) => page.getByRole("treeitem", { name: title, exact: true });
const bodyEditor = (page: Page) => page.locator('.bn-editor[contenteditable="true"]');

/** The worker is installed (the app shell is precached) and controls this tab. */
async function serviceWorkerReady(page: Page): Promise<void> {
  await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
}

/** Keys of the persisted query cache (`rq:*`) in the app's key-value IndexedDB database. */
async function persistedCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open("hostidian-offline");
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("kv")) {
            db.close();
            return resolve([]);
          }
          const keys = db.transaction("kv").objectStore("kv").getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve((keys.result as string[]).map(String).filter((key) => key.startsWith("rq:")));
          };
          keys.onerror = () => {
            db.close();
            resolve([]);
          };
        };
      }),
  );
}

/** Everything the offline cache holds, as text (to assert that a change reached the device, not just the screen). */
async function persistedCacheText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("hostidian-offline");
        open.onerror = () => resolve("");
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("kv")) {
            db.close();
            return resolve("");
          }
          const all = db.transaction("kv").objectStore("kv").getAll();
          all.onsuccess = () => {
            db.close();
            resolve(JSON.stringify(all.result));
          };
          all.onerror = () => {
            db.close();
            resolve("");
          };
        };
      }),
  );
}

/** Number of stored updates in the page's y-indexeddb database (-1: no such database). */
async function storedUpdates(page: Page, pageId: string): Promise<number> {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((db) => db.name === name)) return -1;
    return new Promise<number>((resolve) => {
      const open = indexedDB.open(name);
      open.onerror = () => resolve(-2);
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("updates")) {
          db.close();
          return resolve(-3);
        }
        const count = db.transaction("updates").objectStore("updates").count();
        count.onsuccess = () => {
          db.close();
          resolve(count.result);
        };
        count.onerror = () => {
          db.close();
          resolve(-4);
        };
      };
    });
  }, `page:${pageId}`);
}

/** Open the app in a context, wait until the worker and the offline cache are in place, return the page. */
async function openReadyApp(context: BrowserContext, path: string, waitForTitle: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(path);
  await expect(treeItem(page, waitForTitle)).toBeVisible();
  await serviceWorkerReady(page);
  await expect.poll(() => persistedCacheKeys(page), { timeout: 15_000 }).not.toHaveLength(0);
  return page;
}

test.describe("offline", () => {
  test("a cold start without a network renders the app shell and the cached page tree", async ({ team }) => {
    const title = uniqueName("Cold start");
    await team.createPage({ title });
    const context = await team.owner.newContext();
    const page = await openReadyApp(context, `/w/${team.workspace.slug}`, title);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect(treeItem(page, title)).toBeVisible();
    await expect(status(page)).toHaveAttribute("data-sync-state", "offline");
    await expect(status(page)).toContainText("Offline");
  });

  test("an edited page and a page the user never opened both open offline with their text", async ({ team }) => {
    const word = uniqueWord();
    const never = await team.importVault({ [`Never opened ${word}.md`]: `Text that was only ever on the server ${word}` });
    const seed = await team.createPage({ title: uniqueName("Seed") });
    const context = await team.owner.newContext();
    const page = await openReadyApp(context, team.pagePath(seed.id), seed.title);

    await bodyEditor(page).click();
    await page.keyboard.type(`typed online ${word}`);
    await expect.poll(() => storedUpdates(page, seed.id), { timeout: 15_000 }).toBeGreaterThan(0);

    // The prefetcher syncs recent pages in idle time; wait until the untouched page is on the device.
    const neverPage = never[`Never opened ${word}`]!;
    await expect.poll(() => storedUpdates(page, neverPage.id), { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(editorOf(page)).toContainText(`typed online ${word}`);

    await treeItem(page, neverPage.title).getByRole("link").click();
    await expect(editorOf(page)).toContainText(`only ever on the server ${word}`);
  });

  test("changes made offline (create, nested create, rename, edit) survive a reload and replay in order on reconnect", async ({ team }) => {
    const seed = await team.createPage({ title: uniqueName("Seed") });
    const created = uniqueName("Created offline");
    const child = uniqueName("Child offline");
    const renamed = uniqueName("Renamed offline");
    const body = uniqueWord("offlinebody");

    const context = await team.owner.newContext();
    const page = await openReadyApp(context, team.pagePath(seed.id), seed.title);
    await context.setOffline(true);
    await expect(status(page)).toHaveAttribute("data-sync-state", "offline");

    // create a page and write into it
    await page.getByRole("button", { name: "New workspace page" }).click();
    // the new, untitled page has replaced the old one (its title field is empty), otherwise we would rename the old page
    await expect(page.getByLabel("Page title")).toHaveValue("");
    await page.getByLabel("Page title").fill(created);
    await page.keyboard.press("Enter");
    await bodyEditor(page).click();
    await page.keyboard.type(body);

    // create a child under the page that the server has never heard of
    await treeItem(page, created).hover();
    await page.getByRole("button", { name: `Add a page inside ${created}`, exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue("");
    await page.getByLabel("Page title").fill(child);
    await page.keyboard.press("Enter");

    // rename another page
    await treeItem(page, seed.title).getByRole("link").click();
    await expect(page.getByLabel("Page title")).toHaveValue(seed.title);
    await page.getByLabel("Page title").fill(renamed);
    await page.keyboard.press("Enter");

    await expect(status(page)).toContainText(/Offline · \d+ changes? saved/);
    // the queue is written to IndexedDB a moment after each change; wait for the last one before pulling the plug
    await expect.poll(async () => (await persistedCacheText(page)).includes(renamed), { timeout: 10_000 }).toBe(true);

    // reload while still offline: the tree and the queue are restored from IndexedDB
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(treeItem(page, created)).toBeVisible();
    await expect(treeItem(page, renamed)).toBeVisible();
    await expect(status(page)).toContainText(/Offline · \d+ changes? saved/);

    // reconnect: everything is replayed, in order (the child's parent must exist first)
    await context.setOffline(false);
    await expect(status(page)).toHaveAttribute("data-sync-state", "online", { timeout: 60_000 });

    await expect
      .poll(async () => {
        const pages = await team.owner.api.listPages(team.workspace.id);
        const parent = pages.find((p) => p.title === created);
        const kid = pages.find((p) => p.title === child);
        return { parent: !!parent, kidUnderParent: !!kid && kid.parentId === parent?.id, renamed: pages.find((p) => p.id === seed.id)?.title };
      })
      .toEqual({ parent: true, kidUnderParent: true, renamed });
    const parent = (await team.owner.api.listPages(team.workspace.id)).find((p) => p.title === created)!;
    await expect.poll(async () => (await team.owner.api.pageContent(parent.id)).markdown, { timeout: 45_000 }).toContain(body);

    // another browser sees it all
    const other = await team.owner.newPage();
    await other.goto(`/w/${team.workspace.slug}`);
    await expect(treeItem(other, created)).toBeVisible();
    await expect(treeItem(other, renamed)).toBeVisible();
    await treeItem(other, created).getByRole("link").click();
    await expect(editorOf(other)).toContainText(body);
  });

  test("while offline, ⌘K filters the cached titles and server-only actions are disabled with a reason", async ({ team }) => {
    const title = uniqueName("Findable");
    const target = await team.createPage({ title });
    await team.createPage({ title: uniqueName("Other") });
    const context = await team.owner.newContext();
    const page = await openReadyApp(context, team.pagePath(target.id), title);
    await context.setOffline(true);
    await expect(status(page)).toHaveAttribute("data-sync-state", "offline");

    const searches: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/search")) searches.push(request.url());
    });
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill(title.slice(0, 12));
    await expect(page.getByRole("option", { name: new RegExp(title) })).toBeVisible();
    await expect(page.getByTestId("palette-offline-note")).toBeVisible();
    expect(searches).toEqual([]);
    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: "Share" }).first()).toBeDisabled();
    await page.getByRole("button", { name: /Switch workspace or open account menu/ }).click();
    await expect(page.getByRole("menuitem", { name: /Create workspace/ })).toHaveAttribute("aria-disabled", "true");
  });

  test("logout wipes everything the device kept; the next user on the same browser sees none of it", async ({ team, page, context }) => {
    const secret = uniqueName("ALICEPRIVATE").replace(/\s+/g, "");
    const privatePage = await team.createPage({ title: secret, visibility: "private" });
    const bob = await team.addUser("Bob");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const file = await team.owner.api.uploadFile(team.workspace.id, privatePage.id, { name: "pixel.png", mimeType: "image/png", buffer: png });

    // Any frame that ever contains the secret after Bob is on the scene is a leak.
    await page.addInitScript((needle) => {
      (window as unknown as { __leak: boolean }).__leak = false;
      new MutationObserver(() => {
        if (document.body?.innerText.includes(needle)) (window as unknown as { __leak: boolean }).__leak = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    }, secret);

    const signIn = async (email: string, password: string) => {
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page).toHaveURL(/\/w\//);
    };
    const signOut = async () => {
      await page.getByRole("button", { name: /Switch workspace or open account menu/ }).click();
      await page.getByRole("menuitem", { name: /log out/i }).click();
      await expect(page).toHaveURL(/\/login/);
    };
    const deviceState = () =>
      page.evaluate(async () => {
        const dbs = (await indexedDB.databases()).map((d) => d.name ?? "");
        const userCaches: Record<string, number> = {};
        for (const name of (await caches.keys()).filter((n) => n.startsWith("hostidian-user-"))) {
          userCaches[name] = (await (await caches.open(name)).keys()).length;
        }
        const hints = Object.keys(localStorage).filter(
          (k) => k.startsWith("hostidian:") && !["hostidian:sidebarOpen", "hostidian:installDismissedAt"].includes(k),
        );
        return { pageDbs: dbs.filter((n) => n.startsWith("page:")), userCaches, hints };
      });

    // ---- Alice works, and the device fills up
    await signIn(team.owner.email, USER_PASSWORD);
    await expect(treeItem(page, secret)).toBeVisible();
    await serviceWorkerReady(page);
    await page.goto(team.pagePath(privatePage.id));
    await expect(bodyEditor(page)).toBeVisible();
    expect(await page.evaluate(async (id) => (await fetch(`/api/files/${id}`)).status, file.id)).toBe(200);
    await expect.poll(async () => (await deviceState()).pageDbs.length).toBeGreaterThan(0);
    await expect.poll(async () => Object.values((await deviceState()).userCaches).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    await expect.poll(() => persistedCacheKeys(page)).not.toHaveLength(0);

    // ---- logout wipes it all
    await signOut();
    await expect.poll(async () => (await deviceState()).pageDbs).toEqual([]);
    expect(await persistedCacheKeys(page)).toEqual([]);
    expect(Object.values((await deviceState()).userCaches).every((n) => n === 0)).toBe(true);
    expect((await deviceState()).hints).toEqual([]);

    // ---- Bob signs in on the same browser
    await page.evaluate(() => ((window as unknown as { __leak: boolean }).__leak = false));
    await signIn(bob.email, USER_PASSWORD);
    await expect(page.getByRole("link", { name: "Graph" })).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __leak: boolean }).__leak)).toBe(false);
    expect((await deviceState()).pageDbs).not.toContain(`page:${privatePage.id}`);
    expect(await context.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "hostidian_session" })]));
  });

  test("a dead session never shows the cached workspace, and another user signing in wipes it", async ({ team, page }) => {
    const secret = uniqueName("DEADSESSION").replace(/\s+/g, "");
    await team.createPage({ title: secret, visibility: "private" });
    const bob = await team.addUser("Bob");
    await page.addInitScript((needle) => {
      (window as unknown as { __leak: boolean }).__leak = false;
      new MutationObserver(() => {
        if (document.body?.innerText.includes(needle)) (window as unknown as { __leak: boolean }).__leak = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });
    }, secret);

    await page.goto("/login");
    await page.getByLabel("Email").fill(team.owner.email);
    await page.getByLabel("Password").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(treeItem(page, secret)).toBeVisible();
    await expect.poll(() => persistedCacheKeys(page)).not.toHaveLength(0);

    // The session dies without a logout (expired, revoked elsewhere): nothing was cleaned up.
    await page.context().clearCookies();
    await page.evaluate(() => ((window as unknown as { __leak: boolean }).__leak = false));
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    expect(await page.evaluate(() => (window as unknown as { __leak: boolean }).__leak)).toBe(false);

    // Someone else signs in here: Alice's leftovers are wiped before anything renders.
    await page.getByLabel("Email").fill(bob.email);
    await page.getByLabel("Password").fill(USER_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("link", { name: "Graph" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __leak: boolean }).__leak)).toBe(false);
    await expect(page.getByText(secret)).toHaveCount(0);
    const keys = await persistedCacheKeys(page);
    expect(keys).toEqual([`rq:v1:${bob.userId}`]);
  });
});
