import { expect, test, type Team } from "../helpers/fixtures";
import { openPage } from "../helpers/ui";

const VAULT = {
  "Home.md": "See [[Projects]], [[Ideas]] and [[Reading]].\n",
  "Projects.md": "Back to [[Home]]. Next [[Roadmap]].\n",
  "Ideas.md": "Ideas link [[Home]].\n",
  "Roadmap.md": "Roadmap links [[Projects]] and [[Q4]].\n",
  "Q4.md": "Q4 links [[Roadmap]].\n",
  "Reading.md": "Books. [[Home]]\n",
  "Orphan.md": "Nothing links here.\n",
};
const EDGES = 10;

async function seed(team: Team) {
  const pages = await team.importVault(VAULT);
  await expect.poll(async () => (await team.owner.api.graph(team.workspace.id)).edges.length, { timeout: 30_000 }).toBe(EDGES);
  return pages;
}

/** Plan scenario (g): the graph shows the edges. */
test.describe("graph view", () => {
  test("shows every page as a node and every link as an edge, from the sidebar link", async ({ team }) => {
    await seed(team);
    const alice = await team.owner.newPage();
    await alice.goto(`/w/${team.workspace.slug}`);
    await alice.getByRole("link", { name: "Graph" }).click();
    await expect(alice).toHaveURL(/\/graph$/);

    const canvas = alice.getByTestId("graph-canvas");
    await expect(canvas).toHaveAttribute("data-nodes", "7");
    await expect(canvas).toHaveAttribute("data-links", String(EDGES));
    await expect(alice.getByText(`7 pages · ${EDGES} links · 1 unlinked`)).toBeVisible();
    // The canvas draws something: a node of the app's primary colour.
    await expect.poll(async () => canvas.locator("canvas").evaluate((el: HTMLCanvasElement) => {
      const ctx = el.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 200) return true;
      return false;
    })).toBe(true);

    // The same graph as an accessible list of links.
    const list = alice.getByRole("list", { name: "Pages in the graph" });
    await expect(list.getByRole("link")).toHaveCount(7);
    await expect(list.getByRole("link", { name: /^Home \(6 links\)/ })).toBeAttached();
  });

  test("clicking a node opens that page", async ({ team }) => {
    const pages = await seed(team);
    const alice = await team.owner.newPage();
    await alice.goto(`/w/${team.workspace.slug}/graph`);
    const canvas = alice.getByTestId("graph-canvas");
    await expect(canvas).toHaveAttribute("data-nodes", "7");

    // The layout settles, then publishes where each node is on screen.
    await expect(canvas).toHaveAttribute("data-layout", "ready", { timeout: 20_000 });
    const positions = JSON.parse((await canvas.getAttribute("data-node-screen"))!) as Record<string, [number, number]>;
    const [x, y] = positions[pages["Roadmap"]!.id]!;
    // Like a person: point at the node (its title appears as a tooltip), then click it.
    await canvas.hover({ position: { x, y } });
    await expect(canvas.locator(".float-tooltip-kap")).toContainText("Roadmap");
    await canvas.click({ position: { x, y } });

    await expect(alice).toHaveURL(new RegExp(`/p/${pages["Roadmap"]!.id}$`));
    await expect(alice.locator("article, h1").first()).toBeVisible();
  });

  test("a tap on a node opens the page on a touch screen", async ({ team, browser }) => {
    const pages = await seed(team);
    const context = await team.owner.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const phone = await context.newPage();
    await phone.goto(`/w/${team.workspace.slug}/graph`);
    const canvas = phone.getByTestId("graph-canvas");
    await expect(canvas).toHaveAttribute("data-layout", "ready", { timeout: 20_000 });
    const positions = JSON.parse((await canvas.getAttribute("data-node-screen"))!) as Record<string, [number, number]>;
    const [x, y] = positions[pages["Ideas"]!.id]!;
    const box = (await canvas.boundingBox())!;
    await phone.touchscreen.tap(box.x + x, box.y + y);
    await expect(phone).toHaveURL(new RegExp(`/p/${pages["Ideas"]!.id}$`));
    void browser;
  });

  test("the filter narrows the graph to matching pages", async ({ team }) => {
    await seed(team);
    const alice = await team.owner.newPage();
    await alice.goto(`/w/${team.workspace.slug}/graph`);
    await expect(alice.getByTestId("graph-canvas")).toHaveAttribute("data-nodes", "7");
    await alice.getByLabel("Filter graph pages by title").fill("road");
    await expect(alice.getByText("1 of 7 pages")).toBeVisible();
    await alice.getByLabel("Filter graph pages by title").fill("");
    await expect(alice.getByText(`7 pages · ${EDGES} links · 1 unlinked`)).toBeVisible();
  });

  test("a page's Local graph shows only its neighbourhood, with depth and a link to the full graph", async ({ team }) => {
    const pages = await seed(team);
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(pages["Roadmap"]!.id));

    await alice.getByRole("button", { name: "Local graph" }).click();
    const local = alice.getByTestId("local-graph").getByTestId("graph-canvas");
    // Roadmap links Projects and Q4, and Projects links back to it: depth 1 = Roadmap, Projects, Q4.
    await expect(local).toHaveAttribute("data-nodes", "3");
    await expect(local).toHaveAttribute("data-links", "4");
    // Depth 2 adds what Projects links to and from: Home.
    await alice.getByRole("button", { name: "2", exact: true }).click();
    await expect(local).toHaveAttribute("data-nodes", "4");
    await expect(local).toHaveAttribute("data-links", "6");

    await alice.getByRole("link", { name: "Open full graph" }).click();
    await expect(alice).toHaveURL(new RegExp(`/graph\\?focus=${pages["Roadmap"]!.id}$`));
    await expect(alice.getByRole("switch", { name: "Local graph" })).toBeChecked();
    const canvas = alice.getByTestId("graph-canvas");
    await expect(canvas).toHaveAttribute("data-nodes", "3");
    await alice.getByRole("switch", { name: "Local graph" }).click();
    await expect(canvas).toHaveAttribute("data-nodes", "7");
  });

  test("the graph only contains pages the viewer can see", async ({ team }) => {
    const pages = await seed(team);
    await team.owner.api.ctx.put(`/api/pages/${pages["Roadmap"]!.id}/visibility`, { data: { visibility: "private" } });
    const bob = await team.addUser("Bob");
    const bobPage = await bob.newPage();
    await bobPage.goto(`/w/${team.workspace.slug}/graph`);
    // Roadmap is private to Alice (only top-level pages carry visibility; all of these are top-level).
    await expect(bobPage.getByTestId("graph-canvas")).toHaveAttribute("data-nodes", "6");
    await expect(bobPage.getByRole("list", { name: "Pages in the graph" }).getByRole("link", { name: /Roadmap/ })).toHaveCount(0);
  });

  test("a link made in the editor appears in the graph without reloading", async ({ team }) => {
    const pages = await seed(team);
    const bob = await team.addUser("Bob");
    const bobPage = await bob.newPage();
    await bobPage.goto(`/w/${team.workspace.slug}/graph`);
    const canvas = bobPage.getByTestId("graph-canvas");
    await expect(canvas).toHaveAttribute("data-links", String(EDGES));

    // Alice links Orphan from Q4 in the editor.
    const alice = await team.owner.newPage();
    await openPage(alice, team.pagePath(pages["Q4"]!.id));
    await alice.locator(".bn-block-content").last().click({ position: { x: 4, y: 4 } });
    await alice.keyboard.press("ControlOrMeta+ArrowDown");
    await alice.keyboard.type(" and [[Orphan");
    await expect(alice.locator(".bn-suggestion-menu").getByRole("option").first()).toContainText("Orphan");
    await alice.keyboard.press("Enter");

    await expect(canvas).toHaveAttribute("data-links", String(EDGES + 1), { timeout: 30_000 });
    await expect(bobPage.getByText(`7 pages · ${EDGES + 1} links`)).toBeVisible();
  });
});
