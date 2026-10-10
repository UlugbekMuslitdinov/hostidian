import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures";
import { BASE_URL } from "../helpers/env";
import { uniqueName } from "../helpers/names";

/** Plan section 4: installability, the service worker, the install prompt, mobile layout, and "no third parties". */

async function serviceWorkerReady(page: Page): Promise<void> {
  await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
}

const EXTERNAL = (url: string) => {
  const parsed = new URL(url);
  return !["data:", "blob:", "about:"].includes(parsed.protocol) && parsed.origin !== new URL(BASE_URL).origin;
};

test.describe("PWA", () => {
  test("is installable and the service worker controls the app", async ({ team, page, context }) => {
    await team.createPage({ title: uniqueName("PWA") });
    const owner = await team.owner.newContext();
    const app = await owner.newPage();
    await app.goto(`/w/${team.workspace.slug}`);
    await serviceWorkerReady(app);

    // manifest + icons are served and valid for installation
    const manifest = await (await app.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ display: "standalone", start_url: "/", scope: "/" });
    for (const icon of manifest.icons as Array<{ src: string }>) {
      expect((await app.request.get(icon.src)).status(), icon.src).toBe(200);
    }

    // Chrome's own verdict. A test browser is always "incognito" for this check, which is the only error expected.
    const cdp = await owner.newCDPSession(app);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    expect(installabilityErrors.filter((e) => e.errorId !== "in-incognito")).toEqual([]);

    // The worker is served so it can control the whole origin and is always re-validated.
    const worker = await app.request.get("/serwist/sw.js");
    expect(worker.headers()["service-worker-allowed"]).toBe("/");
    expect(worker.headers()["cache-control"]).toContain("no-cache");
    const registration = await app.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return { scope: r?.scope, state: r?.active?.state };
    });
    expect(registration).toEqual({ scope: `${BASE_URL}/`, state: "activated" });

    // The shell documents, icons and emoji data are precached.
    const precached = await app.evaluate(async () => {
      const names = (await caches.keys()).filter((n) => n.includes("precache"));
      const urls: string[] = [];
      for (const name of names) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(precached).toEqual(
      expect.arrayContaining(["/", "/w/_shell", "/w/_shell/p/_shell", "/w/_shell/trash", "/w/_shell/graph", "/emoji/en/data.json", "/icons/icon-192.png", "/offline.html"]),
    );
    void page;
    void context;
  });

  test("makes no third-party requests, emoji picker included, and the picker works offline", async ({ team }) => {
    const target = await team.createPage({ title: uniqueName("Emoji") });
    const other = await team.createPage({ title: uniqueName("Emoji 2") });
    const context = await team.owner.newContext();
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));

    await page.goto(team.pagePath(target.id));
    await serviceWorkerReady(page);
    await page.getByRole("button", { name: "Add icon" }).click({ force: true });
    await expect(page.locator("[frimousse-emoji]:visible").first()).toBeVisible();
    expect(requests.filter((url) => url.includes("/emoji/"))).toEqual(
      expect.arrayContaining([`${BASE_URL}/emoji/en/data.json`, `${BASE_URL}/emoji/en/messages.json`]),
    );
    expect(requests.filter(EXTERNAL)).toEqual([]);

    // Only the worker's precache can serve the data now: drop the picker's own copy and go offline.
    await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("frimousse")).forEach((k) => localStorage.removeItem(k)));
    await context.setOffline(true);
    await page.goto(team.pagePath(other.id), { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add icon" }).click({ force: true });
    await expect(page.locator("[frimousse-emoji]:visible").first()).toBeVisible();
    expect(requests.filter(EXTERNAL)).toEqual([]);
  });

  test("shows the install card (native prompt) and remembers that it was dismissed", async ({ team }) => {
    const context = await team.owner.newContext();
    const page = await context.newPage();
    await page.goto(`/w/${team.workspace.slug}`);
    await page.getByRole("button", { name: "Open sidebar" }).or(page.getByRole("button", { name: "Close sidebar" })).first().waitFor();
    // Chromium fires `beforeinstallprompt` only for installable, non-incognito profiles: deliver one ourselves.
    await page.evaluate(() => {
      const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
        prompt: async () => undefined,
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      });
      window.dispatchEvent(event);
    });
    const card = page.getByTestId("install-card");
    await expect(card).toHaveAttribute("data-install-kind", "prompt");
    await expect(card.getByRole("button", { name: "Install" })).toBeVisible();
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(card).toHaveCount(0);

    await page.reload();
    await page.evaluate(() => {
      const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "dismissed" }) });
      window.dispatchEvent(event);
    });
    await expect(page.getByTestId("install-card")).toHaveCount(0);
  });

  test("on iOS (no install prompt API) it explains Share, then Add to Home Screen", async ({ team }) => {
    const context = await team.owner.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    });
    const page = await context.newPage();
    await page.goto(`/w/${team.workspace.slug}`);
    await page.getByRole("button", { name: "Open sidebar" }).click();
    const card = page.getByTestId("install-card");
    await expect(card).toHaveAttribute("data-install-kind", "ios");
    await expect(card).toContainText("Add to Home Screen");
    await card.getByRole("button", { name: "Got it" }).click();
    await expect(card).toHaveCount(0);
  });

  test("a phone-sized viewport has no horizontal overflow, 44px touch targets, and a slim offline banner", async ({ team }) => {
    const title = uniqueName("Phone");
    await team.createPage({ title });
    const context = await team.owner.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`/w/${team.workspace.slug}`);
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
    await serviceWorkerReady(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content"))).toContain("viewport-fit=cover");
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute("media")))).toEqual(
      expect.arrayContaining(["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]),
    );

    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(treeItemOf(page, title)).toBeVisible();
    const tooSmall = await page.evaluate(() =>
      Array.from((document.querySelector('[role="dialog"]') ?? document.body).querySelectorAll('a[href], button, [role="treeitem"]'))
        .map((el) => ({ label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30), rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rect.height < 44)
        .map(({ label, rect }) => `${label}: ${Math.round(rect.height)}px`),
    );
    expect(tooSmall).toEqual([]);
    await page.keyboard.press("Escape");

    await context.setOffline(true);
    const banner = page.getByTestId("offline-banner");
    await expect(banner).toBeVisible();
    const box = await banner.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(40);
    expect(Math.round(box!.width)).toBe(390);
  });
});

const treeItemOf = (page: Page, title: string) => page.getByRole("treeitem", { name: title, exact: true });
