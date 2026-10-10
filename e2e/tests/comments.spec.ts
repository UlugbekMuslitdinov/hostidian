import { expect, test } from "../helpers/fixtures";
import { deleteBlock, editorOf, openPage, startCommentOn } from "../helpers/ui";

const PARAGRAPH = "Block that is under discussion";

/** Block-anchored comments, live between two browsers. */
test.describe("comments", () => {
  test("create -> other user sees the badge and replies -> resolve / reopen, all live", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const page = (await team.importVault({ "Discuss.md": `${PARAGRAPH}\n\nAnother block.\n` }))["Discuss"]!;
    const alicePage = await team.owner.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([openPage(alicePage, team.pagePath(page.id)), openPage(bobPage, team.pagePath(page.id))]);

    // Alice starts a thread from the block's comment button.
    await startCommentOn(alicePage, PARAGRAPH);
    await alicePage.getByPlaceholder("Write a comment…").fill("Can we reword this?");
    await alicePage.getByRole("button", { name: "Comment", exact: true }).click();
    const aliceThread = alicePage.getByRole("article", { name: "Comment thread" });
    await expect(aliceThread).toContainText("Can we reword this?");
    await expect(aliceThread).toContainText(PARAGRAPH); // the quoted text

    // Bob never reloaded: the margin badge appears, he opens it and replies.
    const bobBadge = bobPage.getByRole("button", { name: "1 comment on this block" });
    await expect(bobBadge).toBeVisible();
    await bobBadge.click();
    const bobThread = bobPage.getByRole("article", { name: "Comment thread" });
    await expect(bobThread).toContainText("Can we reword this?");
    await bobThread.getByPlaceholder("Reply…").fill("Yes, done in the next edit.");
    await bobThread.getByRole("button", { name: "Reply" }).click();

    // ... and Alice sees the reply arrive.
    await expect(aliceThread).toContainText("Yes, done in the next edit.");
    await expect(alicePage.getByRole("button", { name: "2 comments on this block" })).toBeVisible();

    // Alice resolves it: it leaves Bob's open list; with "Resolved" on it is there, with a Reopen button.
    await aliceThread.getByRole("button", { name: "Resolve" }).click();
    await expect(bobPage.getByRole("article", { name: "Comment thread" })).toHaveCount(0);
    await bobPage.getByRole("switch", { name: "Show resolved" }).click();
    await expect(bobThread).toContainText("Yes, done in the next edit.");
    await bobThread.getByRole("button", { name: "Reopen" }).click();

    // Reopened by Bob: back in Alice's open list.
    await expect(aliceThread.getByRole("button", { name: "Resolve" })).toBeVisible();
    const [stored] = await team.owner.api.comments(page.id);
    expect(stored!.resolvedAt ?? null).toBeNull();
    expect(stored!.comments.map((c) => c.author.name)).toEqual(["Alice", "Bob"]);
  });

  test("authors can edit and delete their own comments; deleting the last one removes the thread", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const page = (await team.importVault({ "Edit me.md": `${PARAGRAPH}\n` }))["Edit me"]!;
    const alicePage = await team.owner.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([openPage(alicePage, team.pagePath(page.id)), openPage(bobPage, team.pagePath(page.id))]);

    await startCommentOn(alicePage, PARAGRAPH);
    await alicePage.getByPlaceholder("Write a comment…").fill("First draft");
    await alicePage.getByRole("button", { name: "Comment", exact: true }).click();
    const aliceThread = alicePage.getByRole("article", { name: "Comment thread" });
    await expect(aliceThread).toContainText("First draft");

    // Only the author gets Edit / Delete.
    await bobPage.getByRole("button", { name: "1 comment on this block" }).click();
    const bobThread = bobPage.getByRole("article", { name: "Comment thread" });
    await expect(bobThread).toContainText("First draft");
    await expect(bobThread.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(bobThread.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // Edit: Bob sees the new text.
    await aliceThread.getByRole("button", { name: "Edit" }).click();
    await aliceThread.getByRole("textbox").first().fill("Second draft");
    await aliceThread.getByRole("button", { name: "Save" }).click();
    await expect(aliceThread).toContainText("Second draft");
    await expect(bobThread).toContainText("Second draft");
    await expect(bobThread).not.toContainText("First draft");

    // Delete the only comment: the thread (and Bob's badge) goes away.
    await aliceThread.getByRole("button", { name: "Delete" }).click();
    await expect(alicePage.getByRole("article", { name: "Comment thread" })).toHaveCount(0);
    await expect(bobPage.getByRole("article", { name: "Comment thread" })).toHaveCount(0);
    await expect(bobPage.getByRole("button", { name: /comments? on this block/ })).toHaveCount(0);
    expect(await team.owner.api.comments(page.id)).toHaveLength(0);
  });

  test("a thread whose block was deleted is shown as detached", async ({ team }) => {
    const page = (await team.importVault({ "Detach.md": `${PARAGRAPH}\n\nThe block that stays.\n` }))["Detach"]!;
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));

    await startCommentOn(alice, PARAGRAPH);
    await alice.getByPlaceholder("Write a comment…").fill("About the first block");
    await alice.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = alice.getByRole("article", { name: "Comment thread" });
    await expect(thread).toContainText("About the first block");
    await expect(thread).not.toContainText("Detached");

    // Delete the commented block through its side menu.
    await deleteBlock(alice, PARAGRAPH);
    await expect(editorOf(alice)).not.toContainText(PARAGRAPH);
    await expect(editorOf(alice)).toContainText("The block that stays.");

    await expect(thread).toContainText("Detached");
    // The comment itself is kept (it can still be answered and resolved).
    await expect(thread).toContainText("About the first block");
    expect(await team.owner.api.comments(page.id)).toHaveLength(1);
  });
});
