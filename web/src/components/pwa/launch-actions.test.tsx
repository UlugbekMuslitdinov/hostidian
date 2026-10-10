import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { routeFetch, jsonResponse, fetchMock } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import { makeMe, makeMembership } from "@/test/factories";
import { LaunchActions, launchAction } from "./launch-actions";

describe("launchAction", () => {
  it("reads the action of a shortcut URL", () => {
    expect(launchAction("?action=new-page")).toBe("new-page");
    expect(launchAction("")).toBeNull();
    expect(launchAction("?foo=1")).toBeNull();
  });
});

describe("<LaunchActions/>", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("creates a page for the New page shortcut", async () => {
    window.history.replaceState(null, "", "/?action=new-page");
    routeFetch({ "POST /workspaces/ws-1/pages": () => jsonResponse({}, 500) });
    renderWithApp(<LaunchActions />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0].method).toBe("POST");
  });

  it("does nothing on an ordinary launch", async () => {
    routeFetch({});
    renderWithApp(<LaunchActions />);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not create a page for a guest who may not", async () => {
    window.history.replaceState(null, "", "/?action=new-page");
    routeFetch({});
    renderWithApp(<LaunchActions />, { me: makeMe({ workspaces: [makeMembership({ role: "guest" })] }) });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
