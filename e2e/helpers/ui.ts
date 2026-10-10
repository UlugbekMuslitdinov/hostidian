import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Line navigation keys differ by platform (macOS: Cmd+Arrow; elsewhere Home/End), and the browser under test
 * runs on the same machine as the test runner.
 */
export const LINE_START = process.platform === "darwin" ? "Meta+ArrowLeft" : "Home";
export const LINE_END = process.platform === "darwin" ? "Meta+ArrowRight" : "End";

/** The BlockNote editing surface of the open page. */
export const editorOf = (page: Page): Locator => page.locator(".bn-editor");

/** The connection pill next to "Last edited" (`data-connection` is the machine-readable state). */
export const connectionOf = (page: Page): Locator => page.locator("[data-connection]");

/**
 * Open a page and wait until the editor is on screen and the collaboration session is live. Waiting for the
 * connection is what makes the first keystroke safe to assert on from another browser.
 */
export async function openPage(page: Page, path: string, options: { editable?: boolean } = {}): Promise<void> {
  await page.goto(path);
  await expect(editorOf(page)).toBeVisible();
  await expect(connectionOf(page)).toHaveAttribute("data-connection", /^(synced|syncing)$/);
  if (options.editable !== false) await expect(editorOf(page)).toHaveAttribute("contenteditable", "true");
}

/**
 * Put the caret at the very end of the document's last line. Clicking the editor's centre can land on a link chip
 * (which navigates) or a media block, so click just inside the right edge of the last block's last line and press
 * End (`Ctrl+End` is not the same key on every platform).
 */
export async function focusEnd(page: Page): Promise<void> {
  const last = editorOf(page).locator(".bn-block-content").last();
  const box = await last.boundingBox();
  if (!box) throw new Error("the editor has no block to focus");
  await last.click({ position: { x: Math.max(2, box.width - 3), y: Math.max(2, box.height - 8) } });
  await page.keyboard.press(LINE_END);
}

/** Type `text` at the end of the document, as a person would (real key events). */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await focusEnd(page);
  await page.keyboard.type(text);
}

/** Insert a new empty paragraph at the end and put the caret in it. */
export async function newParagraph(page: Page): Promise<void> {
  await focusEnd(page);
  await page.keyboard.press("Enter");
}

/** A PNG pasted into the editor, the way a clipboard image arrives (a `paste` event with a File). */
export async function pasteImage(page: Page, png: Buffer, name = "pasted.png"): Promise<void> {
  await editorOf(page).evaluate(
    (element, { base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: "image/png" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { base64: png.toString("base64"), fileName: name },
  );
}

/** Hover a block so its comment affordance appears, then click it. */
export async function startCommentOn(page: Page, blockText: string | RegExp): Promise<void> {
  await editorOf(page).getByText(blockText).first().hover();
  await page.getByRole("button", { name: "Add comment" }).first().click();
}

/** Delete the block containing `text` through its side-menu drag handle ("Open block menu" -> Delete). */
export async function deleteBlock(page: Page, text: string | RegExp): Promise<void> {
  await editorOf(page).getByText(text).first().hover();
  await page.getByRole("button", { name: "Open block menu" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
}

/** Block until the server has extracted `page`'s content (backlinks/search/graph are derived from it). */
export async function expectServerContains(
  read: () => Promise<string>,
  needle: string | RegExp,
  timeout = 30_000,
): Promise<void> {
  await expect
    .poll(read, { timeout, message: `server copy should contain ${String(needle)}` })
    .toMatch(typeof needle === "string" ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : needle);
}
