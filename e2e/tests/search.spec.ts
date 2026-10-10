import { expect, test } from "../helpers/fixtures";
import { editorOf, expectServerContains, openPage, typeAtEnd } from "../helpers/ui";
import { uniqueWord } from "../helpers/names";

/** Plan scenario (e): search finds text from the body of a page that was typed in the editor. */
test.describe("search", () => {
  test("⌘K finds a word typed in a page body, with a highlighted snippet, and opens the page", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const word = uniqueWord("zebrafish");
    const page = await team.createPage({ title: "Field notes" });
    await team.createPage({ title: "Unrelated page" });

    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));
    await typeAtEnd(alice, `Yesterday we spotted a ${word} near the river.`);
    // Search is built from the server's extracted copy, which trails the editor by a few seconds.
    await expectServerContains(async () => (await team.owner.api.pageContent(page.id)).markdown, word);

    // Another person searches the workspace.
    const bobPage = await bob.newPage();
    await bobPage.goto(`/w/${team.workspace.slug}`);
    await expect(bobPage.getByRole("link", { name: "Graph" })).toBeVisible();
    await bobPage.keyboard.press("ControlOrMeta+K");
    await bobPage.getByPlaceholder("Search pages or type a command…").fill(word);

    const group = bobPage.getByRole("group", { name: "In page content" });
    const hit = group.getByRole("option", { name: /Field notes/ });
    await expect(hit).toBeVisible();
    await expect(hit.locator("mark")).toHaveText(word);
    await expect(group.getByRole("option", { name: /Unrelated page/ })).toHaveCount(0);

    await hit.click();
    await expect(bobPage).toHaveURL(new RegExp(`/p/${page.id}$`));
    await expect(editorOf(bobPage)).toContainText(word);
  });

  test("the title quick-switcher finds pages by a fragment of the title", async ({ team }) => {
    const page = await team.createPage({ title: "Quarterly roadmap" });
    await team.createPage({ title: "Grocery list" });
    const alice = await team.owner.newPage();
    await alice.goto(`/w/${team.workspace.slug}`);
    await expect(alice.getByRole("link", { name: "Graph" })).toBeVisible();
    await alice.keyboard.press("ControlOrMeta+K");
    await alice.getByPlaceholder("Search pages or type a command…").fill("roadm");
    const options = alice.getByRole("group", { name: "Pages" }).getByRole("option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("Quarterly roadmap");
    await alice.keyboard.press("Enter");
    await expect(alice).toHaveURL(new RegExp(`/p/${page.id}$`));
  });

  test("search never reveals pages the searcher cannot see", async ({ team }) => {
    const word = uniqueWord("secretword");
    const pages = await team.importVault({ "Private plans.md": `Contains ${word}.\n` });
    const hidden = pages["Private plans"]!;
    await team.owner.api.ctx.put(`/api/pages/${hidden.id}/visibility`, { data: { visibility: "private" } });
    const bob = await team.addUser("Bob");

    await expect.poll(async () => (await team.owner.api.search(team.workspace.id, word)).length, { timeout: 30_000 }).toBe(1);
    expect(await bob.api.search(team.workspace.id, word)).toHaveLength(0);

    const bobPage = await bob.newPage();
    await bobPage.goto(`/w/${team.workspace.slug}`);
    await expect(bobPage.getByRole("link", { name: "Graph" })).toBeVisible();
    await bobPage.keyboard.press("ControlOrMeta+K");
    await bobPage.getByPlaceholder("Search pages or type a command…").fill(word);
    await expect(bobPage.getByText(`No results for “${word}”.`)).toBeVisible();
  });
});
