import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { AppUIProvider } from "@/components/layout/app-ui";
import { qk } from "@/lib/api/keys";
import { fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { renderWithApp } from "@/test/render";
import type { PageSummary } from "@hostidian/api-types";
import { PageTree } from "./page-tree";

const A = makePage({ id: "A", title: "Alpha", position: "a0", icon: "🅰️" });
const A1 = makePage({ id: "A1", title: "Alpha child", parentId: "A", position: "a0" });
const A1a = makePage({ id: "A1a", title: "Deep page", parentId: "A1", position: "a0" });
const B = makePage({ id: "B", title: "Beta", position: "a1" });
const P = makePage({ id: "P", title: "My diary", position: "a0", visibility: "private" });
const PAGES: PageSummary[] = [B, A1a, P, A, A1];

function renderTree(options: { pages?: PageSummary[]; favorites?: PageSummary[] } = {}) {
  return renderWithApp(<PageTree pages={options.pages ?? PAGES} favorites={options.favorites ?? []} />, {
    wrap: (children) => <AppUIProvider>{children}</AppUIProvider>,
  });
}

const row = (name: string) => screen.getByRole("treeitem", { name });
const queryRow = (name: string) => screen.queryByRole("treeitem", { name });

beforeEach(() => {
  window.localStorage.clear();
  navigation.pathname = "/w/acme";
});

describe("PageTree", () => {
  it("renders Workspace and Private sections with collapsed roots", () => {
    renderTree();
    const workspace = screen.getByRole("tree", { name: "Workspace pages" });
    const priv = screen.getByRole("tree", { name: "Private pages" });
    expect(
      within(workspace)
        .getAllByRole("treeitem")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Alpha", "Beta"]);
    expect(
      within(priv)
        .getAllByRole("treeitem")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["My diary"]);
    expect(row("Alpha")).toHaveAttribute("aria-expanded", "false");
    expect(row("Beta")).not.toHaveAttribute("aria-expanded"); // leaf
    expect(queryRow("Alpha child")).not.toBeInTheDocument();
  });

  it("expands and collapses with the chevron and remembers the state per user", () => {
    renderTree();
    fireEvent.click(within(row("Alpha")).getByRole("button", { name: "Expand" }));
    expect(row("Alpha")).toHaveAttribute("aria-expanded", "true");
    expect(row("Alpha child")).toHaveAttribute("aria-level", "2");
    expect(JSON.parse(window.localStorage.getItem("hostidian:tree:user-1:ws-1")!)).toEqual(["A"]);

    fireEvent.click(within(row("Alpha")).getByRole("button", { name: "Collapse" }));
    expect(queryRow("Alpha child")).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("hostidian:tree:user-1:ws-1")!)).toEqual([]);
  });

  it("restores the persisted expanded state", () => {
    window.localStorage.setItem("hostidian:tree:user-1:ws-1", JSON.stringify(["A", "A1"]));
    renderTree();
    expect(row("Deep page")).toHaveAttribute("aria-level", "3");
  });

  it("reveals and highlights the open page by expanding its ancestors", () => {
    navigation.pathname = "/w/acme/p/A1a";
    renderTree();
    expect(row("Deep page")).toHaveAttribute("aria-selected", "true");
    expect(row("Alpha")).toHaveAttribute("aria-expanded", "true");
    expect(row("Alpha child")).toHaveAttribute("aria-expanded", "true");
  });

  it("supports keyboard navigation (arrows, home/end)", () => {
    renderTree();
    const alpha = row("Alpha");
    alpha.focus();
    fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(row("Alpha")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(alpha, { key: "ArrowRight" }); // already open: move to first child
    expect(row("Alpha child")).toHaveFocus();
    fireEvent.keyDown(row("Alpha child"), { key: "ArrowLeft" }); // leaf: go to parent
    expect(row("Alpha")).toHaveFocus();
    fireEvent.keyDown(row("Alpha"), { key: "ArrowDown" });
    expect(row("Alpha child")).toHaveFocus();
    fireEvent.keyDown(row("Alpha child"), { key: "End" });
    expect(row("My diary")).toHaveFocus();
    fireEvent.keyDown(row("My diary"), { key: "Home" });
    expect(row("Alpha")).toHaveFocus();
    fireEvent.keyDown(row("Alpha"), { key: "ArrowLeft" });
    expect(row("Alpha")).toHaveAttribute("aria-expanded", "false");
  });

  it("Enter opens the page", () => {
    renderTree();
    fireEvent.keyDown(row("Beta"), { key: "Enter" });
    expect(navigation.push).toHaveBeenCalledWith("/w/acme/p/B");
  });

  it("Alt+Arrow reorders among siblings through the move endpoint", async () => {
    routeFetch({ "POST /pages/A/move": () => jsonResponse({ ...A, position: "a2" }) });
    const { qc } = renderTree();
    qc.setQueryData(qk.pages("ws-1"), PAGES);
    fireEvent.keyDown(row("Alpha"), { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const request = fetchMock.mock.calls[0]![0];
    expect(new URL(request.url).pathname).toBe("/api/pages/A/move");
    await expect(request.clone().json()).resolves.toEqual({ parentId: null, afterId: "B" });
  });

  it("the + button creates a sub-page (client UUID), expands the parent and opens it", async () => {
    routeFetch({
      "POST /workspaces/ws-1/pages": (r) => jsonResponse({ ...A1, id: new URL(r.url).pathname, title: "" }, 201),
    });
    const { qc } = renderTree();
    qc.setQueryData(qk.pages("ws-1"), PAGES);
    fireEvent.click(screen.getByRole("button", { name: "Add a page inside Alpha" }));

    expect(row("Alpha")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(navigation.push).toHaveBeenCalledTimes(1));
    const target = navigation.push.mock.calls[0]![0] as string;
    expect(target).toMatch(/^\/w\/acme\/p\/[0-9a-f-]{36}$/);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = await fetchMock.mock.calls[0]![0].clone().json();
    expect(body.parentId).toBe("A");
    expect(target.endsWith(body.id)).toBe(true);
    expect(body.id[14]).toBe("7"); // UUID version 7
  });

  it("section + buttons create top-level pages with the right visibility", async () => {
    routeFetch({ "POST /workspaces/ws-1/pages": () => jsonResponse(makePage(), 201) });
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "New private page" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await expect(fetchMock.mock.calls[0]![0].clone().json()).resolves.toMatchObject({
      parentId: null,
      visibility: "private",
    });
  });

  it("starts inline rename from F2 and commits on Enter", async () => {
    routeFetch({ "PATCH /pages/B": () => jsonResponse({ ...B, title: "Gamma" }) });
    renderTree();
    fireEvent.keyDown(row("Beta"), { key: "F2" });
    const input = screen.getByRole("textbox", { name: "Page title" });
    expect(input).toHaveValue("Beta");
    fireEvent.change(input, { target: { value: "Gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await expect(fetchMock.mock.calls[0]![0].clone().json()).resolves.toEqual({ title: "Gamma" });
  });

  it("hides write affordances on pages the user can only view", () => {
    renderTree({ pages: [{ ...B, role: "view" }] });
    expect(screen.queryByRole("button", { name: "Add a page inside Beta" })).not.toBeInTheDocument();
  });

  it("lists favourites and pages shared individually", () => {
    const shared = makePage({ id: "S", title: "Shared one", parentId: "hidden", position: "a0" });
    renderTree({ pages: [...PAGES, shared], favorites: [B] });
    expect(screen.getByRole("list", { name: "Favorites" })).toHaveTextContent("Beta");
    expect(screen.getByRole("tree", { name: "Pages shared with you" })).toHaveTextContent("Shared one");
  });
});
