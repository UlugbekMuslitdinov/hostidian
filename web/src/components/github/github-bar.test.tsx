import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { qk } from "@/lib/api/keys";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import type { PageDetail, PageGithub } from "@hostidian/api-types";
import { GithubBar } from "./github-bar";

afterEach(() => act(() => connectivityStore.set({ online: true })));

const github = (overrides: Partial<PageGithub> = {}): PageGithub => ({
  connectionId: "c-1",
  repository: "acme/site",
  number: 7,
  url: "https://github.com/acme/site/issues/7",
  state: "open",
  lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...overrides,
});

describe("GithubBar", () => {
  it("links to the issue and shows its state and last sync", () => {
    renderWithApp(<GithubBar pageId="p-1" github={github()} canEdit={false} canManage={false} />);
    const link = screen.getByRole("link", { name: /acme\/site#7/ });
    expect(link).toHaveAttribute("href", "https://github.com/acme/site/issues/7");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText(/Synced .*ago/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /issue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("closes the issue and updates the cached page", async () => {
    let body: unknown;
    routeFetch({
      "PUT /pages/p-1/github/state": async (request) => {
        body = await request.json();
        return jsonResponse(github({ state: "closed" }));
      },
      "GET /workspaces/ws-1/github-issues": () => jsonResponse([]),
    });
    const { qc } = renderWithApp(<GithubBar pageId="p-1" github={github()} canEdit canManage={false} />);
    qc.setQueryData<PageDetail>(qk.page("p-1"), { github: github() } as PageDetail);

    fireEvent.click(screen.getByRole("button", { name: "Close issue" }));

    await waitFor(() => expect(qc.getQueryData<PageDetail>(qk.page("p-1"))?.github?.state).toBe("closed"));
    expect(body).toEqual({ state: "closed" });
  });

  it("offers to reopen a closed issue", () => {
    renderWithApp(<GithubBar pageId="p-1" github={github({ state: "closed" })} canEdit canManage={false} />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen issue" })).toBeInTheDocument();
  });

  it("reports a failed sync, and lets only admins retry it", async () => {
    routeFetch({ "POST /integrations/github/c-1/sync": () => jsonResponse(null, 204) });
    const failing = github({ error: "GitHub rejected the token." });

    const { unmount } = renderWithApp(<GithubBar pageId="p-1" github={failing} canEdit canManage={false} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't sync with GitHub: GitHub rejected the token.");
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
    unmount();

    renderWithApp(<GithubBar pageId="p-1" github={failing} canEdit canManage />);
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([r]) => r.method === "POST" && r.url.endsWith("/integrations/github/c-1/sync"))).toBe(true),
    );
  });

  it("surfaces a GitHub error when closing fails and leaves the state alone", async () => {
    routeFetch({ "PUT /pages/p-1/github/state": () => errorResponse(422, "validation_failed", "GitHub could not change the issue") });
    const { qc } = renderWithApp(<GithubBar pageId="p-1" github={github()} canEdit canManage={false} />);
    qc.setQueryData<PageDetail>(qk.page("p-1"), { github: github() } as PageDetail);
    fireEvent.click(screen.getByRole("button", { name: "Close issue" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(qc.getQueryData<PageDetail>(qk.page("p-1"))?.github?.state).toBe("open");
  });

  it("disables changes while offline", () => {
    act(() => connectivityStore.set({ online: false }));
    renderWithApp(<GithubBar pageId="p-1" github={github()} canEdit canManage={false} />);
    expect(screen.getByRole("button", { name: "Close issue" })).toBeDisabled();
  });
});
