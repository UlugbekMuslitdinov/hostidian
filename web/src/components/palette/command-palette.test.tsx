import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppUIProvider, useAppUI } from "@/components/layout/app-ui";
import { qk } from "@/lib/api/keys";
import { fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { renderWithApp } from "@/test/render";
import { CommandPalette } from "./command-palette";

const roadmap = makePage({ id: "road", title: "Roadmap", updatedAt: "2026-10-05T00:00:00Z" });
const notes = makePage({ id: "notes", title: "Meeting notes", updatedAt: "2026-10-06T00:00:00Z" });

function Opener() {
  const ui = useAppUI();
  return (
    <button type="button" onClick={() => ui.setPaletteOpen(true)}>
      open palette
    </button>
  );
}

function setup() {
  routeFetch({
    "GET /workspaces/ws-1/pages": () => jsonResponse([roadmap, notes]),
    "GET /workspaces/ws-1/recent": () => jsonResponse([notes, roadmap]),
    "GET /workspaces/ws-1/search": (request) => {
      const url = new URL(request.url);
      const mode = url.searchParams.get("mode");
      if (url.searchParams.get("q")?.startsWith("zzz")) return jsonResponse([]);
      return jsonResponse(
        mode === "full"
          ? [{ page: notes, rank: 1, snippet: "talked about the <mark>road</mark>map &amp; more" }]
          : [{ page: roadmap, rank: 1, snippet: null }],
      );
    },
  });
  const view = renderWithApp(
    <>
      <Opener />
      <CommandPalette />
    </>,
    { wrap: (children) => <AppUIProvider>{children}</AppUIProvider> },
  );
  view.qc.setQueryData(qk.pages("ws-1"), [roadmap, notes]);
  fireEvent.click(screen.getByRole("button", { name: "open palette" }));
  return view;
}

const input = () => screen.getByRole("combobox");

describe("CommandPalette", () => {
  it("lists recent pages and actions before typing", async () => {
    setup();
    expect(await screen.findByText("Recent")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /meeting notes/i })).toBeInTheDocument();
    for (const label of ["New page", "Go to Home", "Go to Trash", "Go to Settings", "Toggle theme", "Toggle sidebar"]) {
      expect(screen.getByRole("option", { name: new RegExp(label, "i") })).toBeInTheDocument();
    }
  });

  it("filters actions on every keystroke, so ↵ acts on what is on screen", async () => {
    setup();
    await screen.findByText("Recent");
    fireEvent.change(input(), { target: { value: "trash" } });
    // no waiting for the debounce
    expect(screen.getByRole("option", { name: /go to trash/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /new page/i })).not.toBeInTheDocument();
  });

  it("quick-switches by title (local match immediately, server fuzzy results after the debounce)", async () => {
    setup();
    await screen.findByText("Recent");
    fireEvent.change(input(), { target: { value: "road" } });
    expect(screen.getByRole("option", { name: /roadmap/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([r]) => new URL(r.url).searchParams.get("mode") === "title")).toBe(true),
    );
    fireEvent.click(screen.getByRole("option", { name: /roadmap/i }));
    expect(navigation.push).toHaveBeenCalledWith("/w/acme/p/road");
  });

  it("shows content matches with highlighted snippets rendered as text", async () => {
    setup();
    await screen.findByText("Recent");
    fireEvent.change(input(), { target: { value: "road" } });
    expect(await screen.findByText("In page content")).toBeInTheDocument();
    const mark = document.querySelector("mark");
    expect(mark).toHaveTextContent("road");
    expect(screen.getByText(/& more/)).toBeInTheDocument(); // entity decoded, not injected as HTML
  });

  it("says so when nothing matches", async () => {
    setup();
    await screen.findByText("Recent");
    fireEvent.change(input(), { target: { value: "zzzzqqq" } });
    expect(await screen.findByText(/no results for/i)).toBeInTheDocument();
  });
});
