import { expect, test } from "../helpers/fixtures";
import { editorOf, openPage, typeAtEnd } from "../helpers/ui";

const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } as const;

/** No horizontal scrolling: the page is never wider than the screen. */
const fitsWidth = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Light and dark mode, and the phone layout. */
test.describe("appearance", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`the editor follows the app's ${scheme} theme tokens`, async ({ team }) => {
      const page = await team.createPage({ title: `Theme ${scheme}` });
      const context = await team.owner.newContext({ colorScheme: scheme });
      const alice = await context.newPage();
      await openPage(alice, team.pagePath(page.id));
      await typeAtEnd(alice, "Themed text");

      const dark = scheme === "dark";
      await expect(alice.locator("html")).toHaveClass(dark ? /dark/ : /^((?!dark).)*$/);
      await expect(alice.locator(".bn-container")).toHaveAttribute("data-color-scheme", scheme);

      const colours = await alice.evaluate(() => {
        const css = (el: Element, prop: string) => getComputedStyle(el).getPropertyValue(prop).trim();
        const probe = (variable: string) => {
          const el = document.createElement("span");
          el.style.color = `var(${variable})`;
          document.body.appendChild(el);
          const value = getComputedStyle(el).color;
          el.remove();
          return value;
        };
        const editor = document.querySelector(".bn-editor")!;
        return {
          editorBackground: css(editor, "background-color"),
          editorText: css(editor, "color"),
          foreground: probe("--foreground"),
          background: probe("--background"),
          pageBackground: css(document.body, "background-color"),
        };
      });
      // The editor paints no surface of its own and uses the app's text colour (BlockNote's defaults are neither).
      expect(colours.editorBackground).toBe("rgba(0, 0, 0, 0)");
      expect(colours.editorText).toBe(colours.foreground);
      expect(colours.pageBackground).toBe(colours.background);

      // Menus take the popover token as well.
      await alice.keyboard.press("Enter");
      await alice.keyboard.type("/");
      const menu = alice.locator(".bn-suggestion-menu");
      await expect(menu).toBeVisible();
      const popover = await alice.evaluate(() => {
        const el = document.createElement("span");
        el.style.color = "var(--popover)";
        document.body.appendChild(el);
        const value = getComputedStyle(el).color;
        el.remove();
        return value;
      });
      await expect(menu).toHaveCSS("background-color", popover);
      await expect(alice.locator(".bn-suggestion-menu").getByText("Callout")).toBeVisible();
      await expect(alice.locator(".bn-suggestion-menu").getByText("Link to page")).toBeVisible();
    });
  }

  test("the body text lines up with the page title and the gutter holds the side menu", async ({ team }) => {
    const page = await team.createPage({ title: "Aligned" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));
    await typeAtEnd(alice, "First line");

    const titleLeft = (await alice.locator("textarea[aria-label], [aria-label='Page title']").first().boundingBox())!.x;
    const textLeft = (await editorOf(alice).locator(".bn-block-content").first().boundingBox())!.x;
    expect(Math.abs(textLeft - titleLeft)).toBeLessThanOrEqual(2);

    // The side menu (add block, drag handle, comment) sits to the left of the text, not over the sidebar.
    await editorOf(alice).getByText("First line").hover();
    const handle = alice.getByRole("button", { name: "Open block menu" });
    await expect(handle).toBeVisible();
    const sidebar = (await alice.getByRole("complementary", { name: "Sidebar" }).boundingBox())!;
    expect((await handle.boundingBox())!.x).toBeGreaterThan(sidebar.x + sidebar.width);
  });

  test("on a phone the page, graph and public page fit the screen", async ({ team, browser }) => {
    const pages = await team.importVault({
      "Phone page.md": "# Heading\n\nA paragraph with a [[Other]] link and some more text to wrap around the narrow screen.\n",
      "Other.md": "Other page.\n",
    });
    const page = pages["Phone page"]!;
    const share = await team.owner.api.createShare(page.id);
    const context = await team.owner.newContext(MOBILE);
    const phone = await context.newPage();

    await openPage(phone, team.pagePath(page.id));
    await expect(editorOf(phone)).toContainText("A paragraph with a");
    expect(await fitsWidth(phone)).toBe(true);
    // Body text starts where the title does, with the phone's normal side margins.
    const left = (await editorOf(phone).locator(".bn-block-content").first().boundingBox())!.x;
    expect(left).toBeLessThanOrEqual(24);

    // Typing works with the on-screen keyboard's key events.
    await typeAtEnd(phone, " Typed on a phone.");
    await expect(editorOf(phone)).toContainText("Typed on a phone.");

    await phone.goto(`/w/${team.workspace.slug}/graph`);
    await expect(phone.getByTestId("graph-canvas")).toHaveAttribute("data-nodes", "2");
    expect(await fitsWidth(phone)).toBe(true);
    await expect(phone.getByLabel("Filter graph pages by title")).toBeVisible();

    const visitor = await browser.newContext({ ...MOBILE, baseURL: context.pages()[0]!.url().split("/w/")[0] });
    const publicPage = await visitor.newPage();
    await publicPage.goto(new URL(share.url).pathname);
    await expect(publicPage.getByText("A paragraph with a")).toBeVisible();
    expect(await fitsWidth(publicPage)).toBe(true);
    await visitor.close();
  });

  test("on a phone, comments open as a drawer and a comment-role user can start a thread by tapping a block", async ({ team }) => {
    const pages = await team.importVault({ "Mobile review.md": "Tap this paragraph to comment on it.\n" });
    const page = pages["Mobile review"]!;
    const carl = await team.addUser("Carl", "guest");
    await team.owner.api.grant(page.id, { userId: carl.userId, role: "comment" });
    const context = await carl.newContext(MOBILE);
    const phone = await context.newPage();
    await openPage(phone, team.pagePath(page.id), { editable: false });

    await editorOf(phone).getByText("Tap this paragraph").tap();
    await phone.getByRole("button", { name: "Add comment" }).tap();
    // The comments panel is a slide-over on small screens.
    const drawer = phone.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await drawer.getByPlaceholder("Write a comment…").fill("Comment from my phone");
    await drawer.getByRole("button", { name: "Comment", exact: true }).tap();
    await expect(drawer.getByRole("article", { name: "Comment thread" })).toContainText("Comment from my phone");
    expect(await fitsWidth(phone)).toBe(true);

    await expect.poll(async () => (await team.owner.api.comments(page.id)).length).toBe(1);
  });
});
