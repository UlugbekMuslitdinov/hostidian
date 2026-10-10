import { expect, test } from "../helpers/fixtures";
import { editorOf, openPage, startCommentOn } from "../helpers/ui";

/** Plan scenario (b): a `view` guest cannot type; a `comment` user can comment but not edit. */
test.describe("page roles in the editor", () => {
  test("a view-only guest can read but not type, and cannot comment", async ({ team }) => {
    const pages = await team.importVault({ "Read me.md": "Text that guests may read.\n" });
    const page = pages["Read me"]!;
    const vera = await team.addUser("Vera", "guest");
    await team.owner.api.grant(page.id, { userId: vera.userId, role: "view" });

    const veraPage = await vera.newPage();
    await openPage(veraPage, team.pagePath(page.id), { editable: false });
    const editor = editorOf(veraPage);
    await expect(editor).toContainText("Text that guests may read.");
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(veraPage.getByText("You have view-only access to this page.")).toBeVisible();

    // Real key presses go nowhere.
    await editor.getByText("Text that guests may read.").click();
    await veraPage.keyboard.type("INTRUDER");
    await expect(editor).not.toContainText("INTRUDER");

    // No way to start a comment: neither the side-menu nor the read-only overlay offers the button.
    await editor.getByText("Text that guests may read.").hover();
    await expect(veraPage.getByRole("button", { name: "Add comment" })).toHaveCount(0);

    // The server's copy is untouched, and a guest only sees the page that was shared with them.
    expect((await team.owner.api.pageContent(page.id)).markdown).not.toContain("INTRUDER");
    await expect(veraPage.getByRole("link", { name: "Read me" }).first()).toBeVisible();
  });

  test("a comment-role user cannot edit but can start a thread from the read-only editor", async ({ team }) => {
    const pages = await team.importVault({ "Review me.md": "A paragraph that needs a review comment.\n" });
    const page = pages["Review me"]!;
    const carl = await team.addUser("Carl", "guest");
    await team.owner.api.grant(page.id, { userId: carl.userId, role: "comment" });

    const carlPage = await carl.newPage();
    await openPage(carlPage, team.pagePath(page.id), { editable: false });
    const editor = editorOf(carlPage);
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(carlPage.getByText("You can comment on this page, but not edit it.")).toBeVisible();

    await editor.getByText("A paragraph that needs").click();
    await carlPage.keyboard.type("NOPE");
    await expect(editor).not.toContainText("NOPE");

    // The comment button next to the hovered block works even though the editor is read-only.
    await startCommentOn(carlPage, "A paragraph that needs");
    await carlPage.getByPlaceholder("Write a comment…").fill("Looks good to me");
    await carlPage.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(carlPage.getByRole("article", { name: "Comment thread" }).getByText("Looks good to me")).toBeVisible();

    // It reached the server, attributed to Carl, and the document is unchanged.
    await expect.poll(async () => (await team.owner.api.comments(page.id)).length).toBe(1);
    const [thread] = await team.owner.api.comments(page.id);
    expect(thread!.comments[0]!.author.name).toBe("Carl");
    expect(thread!.quote).toContain("A paragraph that needs");
    expect((await team.owner.api.pageContent(page.id)).markdown).not.toContain("NOPE");
  });

  test("a workspace member can edit and their edit reaches the owner", async ({ team }) => {
    const bob = await team.addUser("Bob", "member");
    const page = await team.createPage({ title: "Shared notes" });
    const alicePage = await team.owner.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([openPage(alicePage, team.pagePath(page.id)), openPage(bobPage, team.pagePath(page.id))]);

    await expect(bobPage.getByText(/view-only|can comment on this page/)).toHaveCount(0);
    await editorOf(bobPage).click();
    await bobPage.keyboard.type("Written by a member");
    await expect(editorOf(alicePage)).toContainText("Written by a member");
  });
});
