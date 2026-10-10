import fs from "node:fs";
import { expect, test, type Actor, type Team } from "../helpers/fixtures";
import { editorOf, openPage } from "../helpers/ui";
import { buildVault, readZip, solidPng, zipText } from "../helpers/vault";

const LOGO = solidPng(90, 45, [200, 120, 20]);

/** A small Obsidian-style vault: forward links, an alias, an embed, a folder, a note nobody links to. */
const VAULT = {
  "Home.md": "# Home\n\nStart with [[Projects]], then [[Ideas|the idea list]].\n\n![[logo.png]]\n",
  "Projects.md": "Back to [[Home]]. Next: [[Roadmap]].\n\nUnique word: pangolin42.\n",
  "Ideas.md": "Ideas link [[Home]].\n",
  "Notes/Roadmap.md": "The roadmap links [[Projects]] and [[Missing page]].\n",
  "Orphan.md": "Nothing links here.\n",
  "logo.png": LOGO,
};

async function openWorkspaceSettings(actor: Actor, team: Team) {
  const page = await actor.newPage();
  await page.goto(`/w/${team.workspace.slug}`);
  await expect(page.getByRole("link", { name: "Graph" })).toBeVisible();
  await page.goto("/settings/workspace");
  await expect(page.getByRole("heading", { name: "Import & export" })).toBeVisible();
  return page;
}

/** Plan scenario (f): export a zip with .md files and [[links]]; import a vault; links and backlinks resolve. */
test.describe("import and export", () => {
  test("importing an Obsidian vault resolves forward links, aliases, embeds and folders", async ({ team }) => {
    const alice = await openWorkspaceSettings(team.owner, team);

    await alice.locator('input[type="file"]').setInputFiles({ name: "vault.zip", mimeType: "application/zip", buffer: buildVault(VAULT) });
    await alice.getByRole("button", { name: "Import", exact: true }).click();
    await expect(alice.getByText(/root pages? imported\./)).toBeVisible();

    const pages = await team.owner.api.listPages(team.workspace.id);
    const byTitle = Object.fromEntries(pages.map((p) => [p.title, p]));
    expect(Object.keys(byTitle).sort()).toEqual(["Home", "Ideas", "Notes", "Orphan", "Projects", "Roadmap"]);
    expect(byTitle["Roadmap"]!.parentId).toBe(byTitle["Notes"]!.id); // folders become pages

    // Every link resolved to the right page, including forward references and the aliased one.
    await expect
      .poll(async () => (await team.owner.api.graph(team.workspace.id)).edges.length, { timeout: 30_000 })
      .toBe(6);
    const graph = await team.owner.api.graph(team.workspace.id);
    const title = (id: string) => pages.find((p) => p.id === id)!.title;
    expect(graph.edges.map((e) => `${title(e.source)} -> ${title(e.target)}`).sort()).toEqual([
      "Home -> Ideas",
      "Home -> Projects",
      "Ideas -> Home",
      "Projects -> Home",
      "Projects -> Roadmap",
      "Roadmap -> Projects",
    ]);
    expect((await team.owner.api.backlinks(byTitle["Home"]!.id)).map((p) => p.title).sort()).toEqual(["Ideas", "Projects"]);
    expect((await team.owner.api.backlinks(byTitle["Orphan"]!.id))).toEqual([]);

    // The unresolved [[Missing page]] stays readable text, not a dead link.
    const roadmap = await team.owner.api.pageContent(byTitle["Roadmap"]!.id);
    expect(roadmap.markdown).toContain("Missing page");
    expect(roadmap.markdown).not.toMatch(/\[\[hostidian:[^\]]*Missing page/);

    // In the app: the alias keeps its target, the embedded image renders, backlinks are listed.
    const view = await team.owner.newPage();
    await openPage(view, team.pagePath(byTitle["Home"]!.id));
    await expect(editorOf(view).locator(".hostidian-page-link")).toHaveCount(2);
    const img = editorOf(view).locator("img");
    await expect(img).toHaveCount(1);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(90);
    await view.getByRole("link", { name: "Projects" }).first().click();
    await expect(view.getByRole("region", { name: "Linked from" })).toContainText("2 pages link here");
  });

  test("a page export is a zip of Markdown with [[links]] and attachments", async ({ team }) => {
    const pages = await team.importVault(VAULT);
    const home = pages["Home"]!;
    await expect.poll(async () => (await team.owner.api.graph(team.workspace.id)).edges.length, { timeout: 30_000 }).toBe(6);

    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(home.id));
    const [download] = await Promise.all([
      alice.waitForEvent("download"),
      (async () => {
        await alice.getByRole("button", { name: "Page actions" }).click();
        await alice.getByRole("menuitem", { name: /Export as Markdown/ }).click();
      })(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const zip = fs.readFileSync((await download.path())!);

    const markdown = zipText(zip);
    const homeMd = Object.entries(markdown).find(([name]) => name.endsWith("Home.md"))![1];
    expect(homeMd).toMatch(/^---\n[\s\S]*title: "?Home"?[\s\S]*---/); // YAML front matter
    expect(homeMd).toContain("[[Projects]]"); // wikilinks, not the internal hostidian:<uuid> form
    expect(homeMd).toContain("[[Ideas]]");
    expect(homeMd).not.toContain("hostidian:");
    const attachments = Object.keys(readZip(zip)).filter((name) => name.includes("attachments/"));
    expect(attachments).toHaveLength(1);
    expect(homeMd).toMatch(/!\[logo\.png\]\(([^)]*attachments\/[^)]+)\)/);
  });

  test("workspace export -> re-import under a page: the copy's links and backlinks resolve", async ({ team }) => {
    const pages = await team.importVault(VAULT);
    await expect.poll(async () => (await team.owner.api.graph(team.workspace.id)).edges.length, { timeout: 30_000 }).toBe(6);
    const holder = await team.createPage({ title: "Imported copy" });

    const settings = await openWorkspaceSettings(team.owner, team);
    const [download] = await Promise.all([
      settings.waitForEvent("download"),
      settings.getByRole("button", { name: "Export", exact: true }).click(),
    ]);
    const zip = fs.readFileSync((await download.path())!);
    const markdown = zipText(zip);
    expect(Object.keys(markdown).filter((name) => name.endsWith(".md")).length).toBeGreaterThanOrEqual(6);
    expect(Object.values(markdown).join("\n")).toContain("[[Projects]]");
    expect(Object.values(markdown).join("\n")).not.toContain("hostidian:");

    // Import that very zip back, into the "Imported copy" page, through the UI.
    await settings.locator('input[type="file"]').setInputFiles({ name: "export.zip", mimeType: "application/zip", buffer: zip });
    await settings.getByLabel("Import into").selectOption(holder.id);
    await settings.getByRole("button", { name: "Import", exact: true }).click();
    await expect(settings.getByText(/root pages? imported\./)).toBeVisible();

    const all = await team.owner.api.listPages(team.workspace.id);
    const copyHome = all.find((p) => p.title === "Home" && p.id !== pages["Home"]!.id);
    expect(copyHome, "the imported copy of Home").toBeDefined();
    await expect.poll(async () => (await team.owner.api.backlinks(copyHome!.id)).length, { timeout: 30_000 }).toBe(2);

    // The copy's links point to the copy of its targets, not to the originals.
    const copyIds = new Set(all.filter((p) => !Object.values(pages).some((o) => o.id === p.id)).map((p) => p.id));
    const copyBacklinks = await team.owner.api.backlinks(copyHome!.id);
    expect(copyBacklinks.every((p) => copyIds.has(p.id))).toBe(true);
    expect((await team.owner.api.backlinks(pages["Home"]!.id)).every((p) => !copyIds.has(p.id))).toBe(true);

    // And it is all visible in the app.
    const view = await team.owner.newPage();
    await openPage(view, team.pagePath(copyHome!.id));
    await expect(view.getByRole("region", { name: "Linked from" })).toContainText("2 pages link here");
    await expect(editorOf(view).locator("img")).toHaveCount(1);
  });

  test("importing something that is not a zip shows an error and imports nothing", async ({ team }) => {
    const alice = await openWorkspaceSettings(team.owner, team);
    await alice.locator('input[type="file"]').setInputFiles({ name: "notes.zip", mimeType: "application/zip", buffer: Buffer.from("this is not a zip archive") });
    await alice.getByRole("button", { name: "Import", exact: true }).click();
    await expect(alice.getByRole("alert").filter({ hasText: "not a valid zip" })).toHaveText("The uploaded file is not a valid zip.");
    expect(await team.owner.api.listPages(team.workspace.id)).toHaveLength(0);
  });
});
