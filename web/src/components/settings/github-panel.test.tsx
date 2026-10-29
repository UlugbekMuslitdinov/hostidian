import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { makeMe, makeMembership } from "@/test/factories";
import { renderWithApp } from "@/test/render";
import type { GithubConnection } from "@hostidian/api-types";
import { GithubPanel } from "./github-panel";

afterEach(() => act(() => connectivityStore.set({ online: true })));

const connection = (overrides: Partial<GithubConnection> = {}): GithubConnection => ({
  id: "c-1",
  workspaceId: "ws-1",
  repository: "acme/site",
  enabled: true,
  rootPageId: "root-1",
  syncUserId: "user-1",
  webhookUrl: "https://notes.example.com/api/integrations/github/webhook/c-1",
  webhookSecret: "s3cret-s3cret",
  backfilled: true,
  lastSyncedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  lastError: null,
  createdAt: "2026-10-01T10:00:00Z",
  ...overrides,
});

const calls = (method: string, suffix: string) =>
  fetchMock.mock.calls.filter(([r]) => r.method === method && new URL(r.url).pathname.endsWith(suffix));

describe("GithubPanel", () => {
  it("tells members that only owners and admins manage the sync", () => {
    const me = makeMe({ workspaces: [makeMembership({ role: "member" })] });
    renderWithApp(<GithubPanel />, { me });
    expect(screen.getByText("Only owners and admins can manage GitHub sync")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an empty state and the connect form for admins", async () => {
    routeFetch({ "GET /workspaces/ws-1/integrations/github": () => jsonResponse([]) });
    renderWithApp(<GithubPanel />);
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
    expect(screen.getByLabelText("Repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Access token")).toHaveAttribute("type", "password");
  });

  it("validates before calling the API", async () => {
    routeFetch({ "GET /workspaces/ws-1/integrations/github": () => jsonResponse([]) });
    renderWithApp(<GithubPanel />);
    await screen.findByText("No repository connected");
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    expect(await screen.findByText("Enter the repository as owner/name.")).toBeInTheDocument();
    expect(screen.getByText("Paste an access token.")).toBeInTheDocument();
    expect(calls("POST", "/integrations/github")).toHaveLength(0);
  });

  it("connects a repository, clears the form and reloads the list", async () => {
    let connected = false;
    let body: unknown;
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () => jsonResponse(connected ? [connection({ backfilled: false, lastSyncedAt: null })] : []),
      "POST /workspaces/ws-1/integrations/github": async (request) => {
        body = await request.json();
        connected = true;
        return jsonResponse(connection(), 201);
      },
    });
    renderWithApp(<GithubPanel />);
    await screen.findByText("No repository connected");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: " acme/site " } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: " ghp_abc " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));

    const list = await screen.findByRole("list", { name: "Connected repositories" });
    expect(within(list).getByText("acme/site")).toBeInTheDocument();
    expect(within(list).getByText("Starting…")).toBeInTheDocument();
    expect(body).toEqual({ repository: "acme/site", token: "ghp_abc" });
    expect(screen.getByLabelText("Repository")).toHaveValue("");
    expect(screen.getByLabelText("Access token")).toHaveValue("");
  });

  it("shows GitHub's field errors next to the right input", async () => {
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () => jsonResponse([]),
      "POST /workspaces/ws-1/integrations/github": () =>
        errorResponse(422, "validation_failed", "GitHub rejected this token.", { token: "GitHub rejected this token." }),
    });
    renderWithApp(<GithubPanel />);
    await screen.findByText("No repository connected");
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/site" } });
    fireEvent.change(screen.getByLabelText("Access token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));
    expect(await screen.findByText("GitHub rejected this token.")).toBeInTheDocument();
    // The typed values stay so the user can fix them.
    expect(screen.getByLabelText("Repository")).toHaveValue("acme/site");
  });

  it("lists a connection with its status, last sync, error and webhook details", async () => {
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () =>
        jsonResponse([connection({ lastError: "GitHub rate limit reached; the sync resumes automatically." })]),
    });
    renderWithApp(<GithubPanel />);
    const list = await screen.findByRole("list", { name: "Connected repositories" });
    const item = within(list).getByRole("listitem");
    expect(item).toHaveTextContent("acme/site");
    expect(item).toHaveTextContent("Needs attention");
    expect(item).toHaveTextContent(/Last synced .*ago/);
    expect(item).toHaveTextContent("GitHub rate limit reached");
    expect(within(item).getByRole("link", { name: "Open synced pages" })).toHaveAttribute("href", "/w/acme/p/root-1");
    expect(item).toHaveTextContent("https://notes.example.com/api/integrations/github/webhook/c-1");
    expect(item).toHaveTextContent("s3cret-s3cret");
  });

  it("schedules a sync and pauses/resumes", async () => {
    let enabled = true;
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () => jsonResponse([connection({ enabled })]),
      "POST /integrations/github/c-1/sync": () => jsonResponse(null, 202),
      "PATCH /integrations/github/c-1": async (request) => {
        enabled = ((await request.json()) as { enabled: boolean }).enabled;
        return jsonResponse(connection({ enabled }));
      },
    });
    renderWithApp(<GithubPanel />);
    await screen.findByRole("list", { name: "Connected repositories" });

    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(calls("POST", "/integrations/github/c-1/sync")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeDisabled(); // nothing to sync while paused
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(await screen.findByText("Active")).toBeInTheDocument();
  });

  it("disconnects only after confirmation", async () => {
    let gone = false;
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () => jsonResponse(gone ? [] : [connection()]),
      "DELETE /integrations/github/c-1": () => {
        gone = true;
        return jsonResponse(null, 204);
      },
    });
    renderWithApp(<GithubPanel />);
    await screen.findByRole("list", { name: "Connected repositories" });
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/stay in this workspace as ordinary pages/)).toBeInTheDocument();
    expect(calls("DELETE", "/integrations/github/c-1")).toHaveLength(0);

    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("No repository connected")).toBeInTheDocument();
  });

  it("replaces the token through a dialog", async () => {
    let body: unknown;
    routeFetch({
      "GET /workspaces/ws-1/integrations/github": () => jsonResponse([connection()]),
      "PATCH /integrations/github/c-1": async (request) => {
        body = await request.json();
        return jsonResponse(connection());
      },
    });
    renderWithApp(<GithubPanel />);
    await screen.findByRole("list", { name: "Connected repositories" });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" })); // empty: refused locally
    expect(await within(dialog).findByText("Paste an access token.")).toBeInTheDocument();
    expect(body).toBeUndefined();
    fireEvent.change(within(dialog).getByLabelText("New access token"), { target: { value: "ghp_new" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace token" }));
    await waitFor(() => expect(body).toEqual({ token: "ghp_new" }));
  });

  it("disables management while offline", async () => {
    routeFetch({ "GET /workspaces/ws-1/integrations/github": () => jsonResponse([connection()]) });
    renderWithApp(<GithubPanel />);
    await screen.findByRole("list", { name: "Connected repositories" });
    act(() => connectivityStore.set({ online: false }));
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
  });
});
