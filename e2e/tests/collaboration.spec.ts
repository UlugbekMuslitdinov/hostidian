import { expect, test } from "../helpers/fixtures";
import { connectionOf, editorOf, openPage, typeAtEnd } from "../helpers/ui";

/** Plan scenario (a): two people in one page see each other's text, cursors and presence, live. */
test.describe("real-time collaboration", () => {
  test("two users co-edit one page and see each other's text, cursor and presence", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const page = await team.createPage({ title: "Co-editing" });

    const alicePage = await team.owner.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([openPage(alicePage, team.pagePath(page.id)), openPage(bobPage, team.pagePath(page.id))]);

    // Alice types; Bob sees it without reloading.
    await typeAtEnd(alicePage, "Hello from Alice");
    await expect(editorOf(bobPage)).toContainText("Hello from Alice");

    // Bob replies in the same paragraph; Alice sees both, in order.
    await typeAtEnd(bobPage, " and hello from Bob");
    await expect(editorOf(alicePage)).toContainText("Hello from Alice and hello from Bob");

    // Presence: each one sees the other in the header avatar stack.
    await expect(alicePage.getByRole("list", { name: "1 other person here" })).toBeVisible();
    await expect(alicePage.getByRole("list", { name: "1 other person here" }).getByRole("listitem")).toHaveCount(1);
    await expect(bobPage.getByRole("list", { name: "1 other person here" })).toBeVisible();

    // Remote cursor: Bob's caret is drawn in Alice's editor, labelled with his name.
    const cursor = editorOf(alicePage).locator(".bn-collaboration-cursor__base").filter({ hasText: "Bob" });
    await expect(cursor).toHaveCount(1);
    await expect(cursor.locator(".bn-collaboration-cursor__caret")).toBeVisible();

    // When Bob leaves, Alice's presence stack empties.
    await bobPage.close();
    await expect(alicePage.getByRole("list", { name: /other (person|people) here/ })).toHaveCount(0);
  });

  test("an edit survives a reload and is saved on the server", async ({ team }) => {
    const page = await team.createPage({ title: "Persistence" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));

    await typeAtEnd(alice, "Remember this sentence");
    // "Saved" is the connection pill's healthy state once local changes reached the server.
    await expect(connectionOf(alice)).toHaveAttribute("data-connection", "synced");

    await alice.reload();
    await expect(editorOf(alice)).toContainText("Remember this sentence");

    // And the server's own copy (what search, export and public pages read) catches up.
    await expect
      .poll(async () => (await team.owner.api.pageContent(page.id)).markdown, { timeout: 30_000 })
      .toContain("Remember this sentence");

    // A different browser (no local copy at all) loads it from the server.
    const other = await team.owner.newPage();
    await openPage(other, team.pagePath(page.id));
    await expect(editorOf(other)).toContainText("Remember this sentence");
  });

  test("the page opens a single collaboration socket (no double connect)", async ({ team }) => {
    const page = await team.createPage({ title: "One socket" });
    const alice = await team.owner.newPage();
    const sockets: string[] = [];
    alice.on("websocket", (socket) => sockets.push(socket.url()));
    await openPage(alice, team.pagePath(page.id));
    await typeAtEnd(alice, "x");
    await expect(connectionOf(alice)).toHaveAttribute("data-connection", "synced");
    expect(sockets.filter((url) => url.includes("/collab"))).toHaveLength(1);
  });
});
