import { expect, test } from "../helpers/fixtures";
import { editorOf, newParagraph, openPage, typeAtEnd } from "../helpers/ui";

/** `[[` page links: the picker, the chip, navigation, live titles, backlinks. */
test.describe("page links", () => {
  test("[[ opens a picker; Enter links the best match, not the 'create' entry", async ({ team }) => {
    const target = await team.createPage({ title: "Quarterly Planning" });
    const source = await team.createPage({ title: "Meeting notes" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(source.id));

    await typeAtEnd(alice, "Agenda: [[Quarterly");
    const menu = alice.locator(".bn-suggestion-menu");
    await expect(menu).toBeVisible();
    // The existing page is offered first, and "Create" comes after it.
    const items = menu.getByRole("option");
    await expect(items.first()).toContainText("Quarterly Planning");
    await expect(items.last()).toContainText("Create “Quarterly”");

    await alice.keyboard.press("Enter");
    const chip = editorOf(alice).locator(".hostidian-page-link");
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("Quarterly Planning");
    // No stray page was created by accepting the match.
    expect((await team.owner.api.listPages(team.workspace.id)).map((p) => p.title).sort()).toEqual(["Meeting notes", "Quarterly Planning"]);

    // The server derives the link: Meeting notes -> Quarterly Planning shows up as a backlink.
    await expect.poll(async () => (await team.owner.api.backlinks(target.id)).map((p) => p.title), { timeout: 30_000 }).toEqual(["Meeting notes"]);
    expect((await team.owner.api.pageContent(source.id)).markdown).toContain(`[[hostidian:${target.id}|Quarterly Planning]]`);
  });

  test("the picker's Create entry makes a new page and links it", async ({ team }) => {
    const source = await team.createPage({ title: "Ideas" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(source.id));

    await typeAtEnd(alice, "Next: [[Brand new topic");
    const menu = alice.locator(".bn-suggestion-menu");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await alice.keyboard.press("Enter");

    await expect(editorOf(alice).locator(".hostidian-page-link")).toContainText("Brand new topic");
    await expect.poll(async () => (await team.owner.api.listPages(team.workspace.id)).map((p) => p.title)).toContain("Brand new topic");
    // The new page shows up in the sidebar tree right away.
    await expect(alice.getByRole("link", { name: "Brand new topic" }).first()).toBeVisible();
  });

  test("clicking a link chip navigates; a rename shows up live in other people's chips", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const pages = await team.importVault({
      "Source.md": "See [[Target]] for details.\n",
      "Target.md": "The target body.\n",
    });
    const source = pages["Source"]!;
    const target = pages["Target"]!;
    const bobPage = await bob.newPage();
    await openPage(bobPage, team.pagePath(source.id));

    const chip = editorOf(bobPage).locator(".hostidian-page-link");
    await expect(chip).toContainText("Target");

    // Alice renames the target: Bob's chip follows, no reload.
    await team.owner.api.renamePage(target.id, "Target (renamed)");
    await expect(chip).toContainText("Target (renamed)");

    // Click the chip: the app navigates to the target page.
    await chip.click();
    await expect(bobPage).toHaveURL(new RegExp(`/p/${target.id}$`));
    await expect(editorOf(bobPage)).toContainText("The target body.");
  });

  test("the backlinks panel lists pages that link here and updates live", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const pages = await team.importVault({
      "Hub.md": "The hub.\n",
      "Spoke one.md": "Points to [[Hub]].\n",
      "Spoke two.md": "Nothing yet.\n",
    });
    const hub = pages["Hub"]!;
    const two = pages["Spoke two"]!;

    const bobPage = await bob.newPage();
    await openPage(bobPage, team.pagePath(hub.id));
    const panel = bobPage.getByRole("region", { name: "Linked from" });
    await expect(panel).toContainText("1 page links here");
    await expect(panel.getByRole("link", { name: "Spoke one" })).toBeVisible();

    // Alice links Hub from a second page; Bob's panel updates without a reload.
    const alicePage = await team.owner.newPage();
    await openPage(alicePage, team.pagePath(two.id));
    await newParagraph(alicePage);
    await alicePage.keyboard.type("Also see [[Hub");
    await expect(alicePage.locator(".bn-suggestion-menu").getByRole("option").first()).toContainText("Hub");
    await alicePage.keyboard.press("Enter");

    await expect(panel).toContainText("2 pages link here", { timeout: 30_000 });
    await panel.getByRole("link", { name: "Spoke two" }).click();
    await expect(bobPage).toHaveURL(new RegExp(`/p/${two.id}$`));
  });
});
