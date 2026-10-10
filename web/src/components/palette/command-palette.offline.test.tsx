import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppUIProvider, useAppUI } from "@/components/layout/app-ui";
import { qk } from "@/lib/api/keys";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makePage } from "@/test/factories";
import { navigation } from "@/test/navigation-mock";
import { renderWithApp } from "@/test/render";
import { CommandPalette } from "./command-palette";

const roadmap = makePage({ id: "road", title: "Roadmap" });
const notes = makePage({ id: "notes", title: "Meeting notes" });

function Opener() {
  const ui = useAppUI();
  return (
    <button type="button" onClick={() => ui.setPaletteOpen(true)}>
      open palette
    </button>
  );
}

describe("CommandPalette while offline", () => {
  afterEach(() => {
    act(() => connectivityStore.set({ online: true }));
  });

  it("filters the cached page tree by title and never calls the search API", async () => {
    connectivityStore.set({ online: false });
    routeFetch({});
    const view = renderWithApp(
      <>
        <Opener />
        <CommandPalette />
      </>,
      { wrap: (children) => <AppUIProvider>{children}</AppUIProvider> },
    );
    view.qc.setQueryData(qk.pages("ws-1"), [roadmap, notes]);
    fireEvent.click(screen.getByRole("button", { name: "open palette" }));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "meet" } });
    expect(screen.getByRole("option", { name: /meeting notes/i })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /roadmap/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("palette-offline-note")).toHaveTextContent(/offline/i);
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /meeting notes/i }));
    expect(navigation.push).toHaveBeenCalledWith("/w/acme/p/notes");
    // Server search is not attempted (the paused request would otherwise hang the "searching" state).
    await new Promise((r) => setTimeout(r, 300));
    expect(fetchMock.mock.calls.filter(([r]) => new URL(r.url).pathname.endsWith("/search"))).toHaveLength(0);
  });

  it("does not show the offline note when online", () => {
    routeFetch({
      "GET /workspaces/ws-1/pages": () => jsonResponse([]),
      "GET /workspaces/ws-1/recent": () => jsonResponse([]),
    });
    renderWithApp(
      <>
        <Opener />
        <CommandPalette />
      </>,
      { wrap: (children) => <AppUIProvider>{children}</AppUIProvider> },
    );
    fireEvent.click(screen.getByRole("button", { name: "open palette" }));
    expect(screen.queryByTestId("palette-offline-note")).not.toBeInTheDocument();
  });
});
