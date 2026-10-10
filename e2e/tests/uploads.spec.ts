import { expect, test } from "../helpers/fixtures";
import { editorOf, newParagraph, openPage, pasteImage, typeAtEnd } from "../helpers/ui";
import { solidPng } from "../helpers/vault";

const RED = solidPng(64, 48, [220, 40, 40]);
const GREEN = solidPng(80, 40, [40, 160, 80]);

/** The src the editor stored for an image, e.g. /api/files/<uuid>. */
const imageSrc = async (page: import("@playwright/test").Page, index = 0) =>
  editorOf(page).locator("img").nth(index).getAttribute("src");

/** Images and files: paste, drop, and the block's upload button, stored through POST /workspaces/{id}/files. */
test.describe("uploads", () => {
  test("a pasted image is uploaded, rendered here and for other people, and served back", async ({ team }) => {
    const bob = await team.addUser("Bob");
    const page = await team.createPage({ title: "Pictures" });
    const alice = await team.owner.newPage();
    const bobPage = await bob.newPage();
    await Promise.all([openPage(alice, team.pagePath(page.id)), openPage(bobPage, team.pagePath(page.id))]);

    await typeAtEnd(alice, "Look at this");
    await newParagraph(alice);
    await pasteImage(alice, RED);

    const img = editorOf(alice).locator("img");
    await expect(img).toHaveCount(1);
    const src = await imageSrc(alice);
    expect(src).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
    // It really decoded as the 64x48 picture we pasted.
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);

    // Bob (no reload) gets the same image, loaded through the authenticated file endpoint.
    await expect(editorOf(bobPage).locator("img")).toHaveCount(1);
    await expect.poll(() => editorOf(bobPage).locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(64);

    // The server stored it as an image attachment of this workspace and serves it inline with nosniff.
    const response = await team.owner.api.ctx.get(src!);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect(response.headers()["content-disposition"] ?? "").toMatch(/^inline/);
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");

    // The derived Markdown (what export/search use) references the attachment.
    await expect.poll(async () => (await team.owner.api.pageContent(page.id)).markdown, { timeout: 30_000 }).toContain(src!);
  });

  test("the image block's Upload button uploads a chosen file", async ({ team }) => {
    const page = await team.createPage({ title: "Upload button" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));

    await typeAtEnd(alice, "/image");
    await alice.keyboard.press("Enter");
    await alice.getByText("Add image").click();
    await alice.locator('input[type="file"]').setInputFiles({ name: "green.png", mimeType: "image/png", buffer: GREEN });

    await expect(editorOf(alice).locator("img")).toHaveCount(1);
    await expect.poll(() => editorOf(alice).locator("img").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(80);
    expect(await imageSrc(alice)).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
  });

  test("a file block uploads a non-image file and links to it as a download", async ({ team }) => {
    const page = await team.createPage({ title: "Attachments" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));

    await typeAtEnd(alice, "/file");
    await alice.keyboard.press("Enter");
    await alice.getByText("Add file").click();
    await alice.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain attachment body") });

    const block = editorOf(alice).locator('[data-content-type="file"]');
    await expect(block).toContainText("notes.txt");

    // The server has it, and (not being an image) forces it to download rather than render inline.
    await expect.poll(async () => (await team.owner.api.pageContent(page.id)).markdown, { timeout: 30_000 }).toMatch(/\[notes\.txt\]\(\/api\/files\/[0-9a-f-]{36}\)/);
    const markdown = (await team.owner.api.pageContent(page.id)).markdown;
    const url = /\((\/api\/files\/[0-9a-f-]{36})\)/.exec(markdown)![1]!;
    const response = await team.owner.api.ctx.get(url);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
    expect(await response.text()).toBe("plain attachment body");
  });

  test("dropping an image file onto the page uploads it", async ({ team }) => {
    const page = await team.createPage({ title: "Drop target" });
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(page.id));
    await typeAtEnd(alice, "Drop below this line");

    const box = (await editorOf(alice).locator(".bn-block-content").last().boundingBox())!;
    await editorOf(alice).evaluate(
      (element, { base64, x, y }) => {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
        const init = { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true };
        element.dispatchEvent(new DragEvent("dragenter", init));
        element.dispatchEvent(new DragEvent("dragover", init));
        element.dispatchEvent(new DragEvent("drop", init));
      },
      { base64: RED.toString("base64"), x: box.x + 20, y: box.y + box.height - 2 },
    );

    await expect(editorOf(alice).locator("img")).toHaveCount(1);
    expect(await imageSrc(alice)).toMatch(/^\/api\/files\/[0-9a-f-]{36}$/);
  });

  test("a view-only user cannot upload into a page (the server refuses)", async ({ team }) => {
    const page = await team.createPage({ title: "No uploads" });
    const vera = await team.addUser("Vera", "guest");
    await team.owner.api.grant(page.id, { userId: vera.userId, role: "view" });
    await expect(
      vera.api.uploadFile(team.workspace.id, page.id, { name: "x.png", mimeType: "image/png", buffer: RED }),
    ).rejects.toThrow(/-> (403|404)/);
  });
});
