import { expect, test } from "../helpers/fixtures";
import { editorOf, openPage } from "../helpers/ui";
import { solidPng } from "../helpers/vault";

const BLUE = solidPng(120, 60, [30, 90, 220]);

/** Plan scenario (d): a public link opens logged-out, with its images; revoking it gives a friendly 404. */
test.describe("public share links", () => {
  test("the Share dialog creates a link that opens logged-out with the page's image", async ({ team, browser }) => {
    const pages = await team.importVault({
      "Public notes.md": "# Public notes\n\nVisible to everyone with the link.\n\n![[chart.png]]\n\n> [!tip] A callout\n",
      "chart.png": BLUE,
    });
    const page = pages["Public notes"]!;

    // Create the link in the UI, as a user would.
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));
    await alice.getByRole("button", { name: "Share", exact: true }).click();
    await alice.getByRole("tab", { name: "Public link" }).click();
    await alice.getByRole("button", { name: "Create public link" }).click();
    const urlBox = alice.getByLabel("Public link URL");
    await expect(urlBox).toHaveValue(/\/s\/[A-Za-z0-9_-]{43}$/);
    // The link's origin is the stack's PUBLIC_URL; the path is what we open (relative to the base URL under test).
    const path = new URL(await urlBox.inputValue()).pathname;

    // A brand-new browser context: no cookies, no storage, nothing.
    const visitor = await browser.newContext();
    const anon = await visitor.newPage();
    const apiCalls: string[] = [];
    anon.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith("/api/")) apiCalls.push(`${request.method()} ${pathname}`);
    });
    await anon.goto(path);

    await expect(anon.locator("article header h1")).toHaveText("Public notes");
    await expect(anon.getByText("Visible to everyone with the link.")).toBeVisible();
    await expect(anon.getByText("A callout")).toBeVisible();
    await expect(anon.getByText("Shared page · read-only")).toBeVisible();

    // The image is served through the token-scoped public file route, and actually decodes.
    const img = anon.locator("main img");
    await expect(img).toHaveCount(1);
    expect(await img.getAttribute("src")).toMatch(/\/api\/public\/[A-Za-z0-9_-]{43}\/files\/[0-9a-f-]{36}$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(120);

    // Read-only: nothing to type into.
    await expect(anon.locator(".bn-editor")).toHaveAttribute("contenteditable", "false");

    // No session involved: the page never asked who the visitor is, and made no private API call.
    expect(apiCalls.filter((call) => /\/api\/(auth\/me|workspaces|pages)\b/.test(call))).toEqual([]);
    expect(apiCalls.some((call) => call.includes("/api/public/"))).toBe(true);

    // Search engines are told to stay away, and the token is not leaked via Referer.
    await expect(anon.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(anon.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    await expect(anon).toHaveTitle(/Public notes/);

    // The private image URL is not available to the anonymous visitor.
    const privateImage = (await team.owner.api.pageContent(page.id)).markdown.match(/\/api\/files\/[0-9a-f-]{36}/)![0];
    expect((await visitor.request.get(privateImage)).status()).toBeGreaterThanOrEqual(401);

    await visitor.close();
  });

  test("a revoked link shows a friendly 'unavailable' page and exposes nothing", async ({ team, browser }) => {
    const page = await team.createPage({ title: "Temporary page" });
    const share = await team.owner.api.createShare(page.id);

    const visitor = await browser.newContext();
    const anon = await visitor.newPage();
    await anon.goto(`/s/${share.token}`);
    await expect(anon.locator("article header h1")).toHaveText("Temporary page");

    await team.owner.api.revokeShare(share.id);
    await anon.reload();
    await expect(anon.getByText("This link is unavailable")).toBeVisible();
    await expect(anon.getByText("was turned off by its owner")).toBeVisible();
    await expect(anon.getByText("Temporary page")).toHaveCount(0);
    // The API agrees: nothing is revealed about why.
    const api = await visitor.request.get(`/api/public/${share.token}/page`);
    expect(api.status()).toBe(404);

    // A made-up token looks exactly the same.
    await anon.goto(`/s/${"x".repeat(43)}`);
    await expect(anon.getByText("This link is unavailable")).toBeVisible();
    await visitor.close();
  });

  test("with sub-pages included the visitor gets a page tree and can open a sub-page, but nothing outside it", async ({ team, browser }) => {
    const pages = await team.importVault({
      "Handbook.md": "Welcome to the handbook.\n",
      "Handbook/Chapter one.md": "Chapter one text.\n",
      "Outside.md": "Not part of the share.\n",
    });
    const handbook = pages["Handbook"]!;
    const chapter = pages["Chapter one"]!;
    const outside = pages["Outside"]!;
    const share = await team.owner.api.createShare(handbook.id, true);

    const visitor = await browser.newContext();
    const anon = await visitor.newPage();
    await anon.setViewportSize({ width: 1280, height: 800 });
    await anon.goto(`/s/${share.token}`);
    await expect(anon.getByText("Welcome to the handbook.")).toBeVisible();
    const tree = anon.getByRole("navigation");
    await expect(tree.getByRole("link", { name: "Chapter one" })).toBeVisible();
    await tree.getByRole("link", { name: "Chapter one" }).click();
    await expect(anon).toHaveURL(new RegExp(`/s/${share.token}/${chapter.id}$`));
    await expect(anon.getByText("Chapter one text.")).toBeVisible();

    // Another page of the workspace is not reachable through this token.
    await anon.goto(`/s/${share.token}/${outside.id}`);
    await expect(anon.getByText("This link is unavailable")).toBeVisible();
    await visitor.close();
  });

  test("a shared page shows edits made after it was shared", async ({ team, browser }) => {
    const page = await team.createPage({ title: "Living document" });
    const share = await team.owner.api.createShare(page.id);
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));
    await editorOf(alice).click();
    await alice.keyboard.type("Edited after sharing");
    await expect.poll(async () => (await team.owner.api.pageContent(page.id)).markdown, { timeout: 30_000 }).toContain("Edited after sharing");

    const visitor = await browser.newContext();
    const anon = await visitor.newPage();
    await anon.goto(`/s/${share.token}`);
    await expect(anon.getByText("Edited after sharing")).toBeVisible();
    await visitor.close();
  });
});
