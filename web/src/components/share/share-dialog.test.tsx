import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import type { PagePermissions } from "@hostidian/api-types";
import { ShareDialog, type SharePage } from "./share-dialog";

const page: SharePage = { id: "p1", title: "Roadmap", role: "full", parentId: null };

const user = (id: string, name: string) => ({
  id,
  name,
  email: `${name.toLowerCase()}@example.com`,
  avatarColor: "#64b5f6",
});

const permissions = (overrides: Partial<PagePermissions> = {}): PagePermissions => ({
  visibility: "workspace",
  canChangeVisibility: true,
  entries: [
    { user: user("u2", "Grace"), role: "edit", inheritedFrom: null },
    { user: user("u3", "Linus"), role: "view", inheritedFrom: "parent-page" },
  ],
  ...overrides,
});

function open(sharePage: SharePage = page) {
  return renderWithApp(<ShareDialog open onOpenChange={() => {}} page={sharePage} />);
}

describe("ShareDialog – people", () => {
  it("lists people with a role picker offering view / comment / edit / full", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions()),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
    });
    open();
    const grace = await screen.findByLabelText("Access level for Grace");
    expect(grace).toHaveValue("edit");
    expect(
      within(grace)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Can view", "Can comment", "Can edit", "Full access"]);
  });

  it("marks inherited access and makes it read-only here", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions()),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
    });
    open();
    const linus = await screen.findByLabelText("Access level for Linus");
    expect(linus).toBeDisabled();
    expect(screen.getByText("Inherited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Linus" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Grace" })).toBeEnabled();
  });

  it("changes a role through the permissions endpoint", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions()),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
      "POST /pages/p1/permissions": () =>
        jsonResponse(permissions({ entries: [{ user: user("u2", "Grace"), role: "full", inheritedFrom: null }] })),
    });
    open();
    fireEvent.change(await screen.findByLabelText("Access level for Grace"), { target: { value: "full" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([r]) => r.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([r]) => r.method === "POST")![0];
    await expect(post.clone().json()).resolves.toEqual({ userId: "u2", role: "full" });
  });

  it("invites by email with the chosen role and validates the address first", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions({ entries: [] })),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
      "POST /pages/p1/permissions": () => jsonResponse(permissions({ entries: [] })),
    });
    open();
    const email = await screen.findByLabelText("Invite by email");
    fireEvent.change(email, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([r]) => r.method === "POST")).toBe(false);

    fireEvent.change(email, { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Access level for the invitation"), { target: { value: "comment" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([r]) => r.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([r]) => r.method === "POST")![0];
    await expect(post.clone().json()).resolves.toEqual({ email: "new@example.com", role: "comment" });
  });

  it("offers a guest invite when the email has no account (404)", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions({ entries: [] })),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
      "POST /pages/p1/permissions": () => errorResponse(404, "not_found", "no such user"),
      "POST /workspaces/ws-1/invites": () =>
        jsonResponse(
          {
            id: "i1",
            token: "tok",
            url: "https://notes.example/invite/tok",
            role: "guest",
            expiresAt: "2026-10-16T00:00:00Z",
            createdAt: "2026-10-09T00:00:00Z",
          },
          201,
        ),
    });
    open();
    fireEvent.change(await screen.findByLabelText("Invite by email"), { target: { value: "stranger@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.click(await screen.findByRole("button", { name: /create guest invite link/i }));
    expect(await screen.findByLabelText("Guest invite link")).toHaveValue("https://notes.example/invite/tok");
  });

  it("lets full-access users switch a root page between Workspace and Private", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions()),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
    });
    open();
    expect(await screen.findByText("Everyone in Acme")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Page visibility" })).toBeInTheDocument();
  });

  it("explains inheritance on sub-pages instead of offering visibility", async () => {
    routeFetch({
      "GET /pages/p1/permissions": () => jsonResponse(permissions({ canChangeVisibility: false })),
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
    });
    open({ ...page, parentId: "root" });
    expect(await screen.findByText(/inherits access from its top-level page/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Page visibility" })).not.toBeInTheDocument();
  });

  it("does not fetch or show controls without full access", async () => {
    renderWithApp(<ShareDialog open onOpenChange={() => {}} page={{ ...page, role: "edit" }} />);
    expect(await screen.findByText(/only people with full access can change/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
  });
});

describe("ShareDialog – public link", () => {
  const openPublicTab = () => fireEvent.mouseDown(screen.getByRole("tab", { name: "Public link" }), { button: 0 });
  const base = {
    "GET /pages/p1/permissions": () => jsonResponse(permissions()),
    "GET /workspaces/ws-1/members": () => jsonResponse([]),
  };

  it("shows a friendly state while the server doesn't support public links yet (501)", async () => {
    routeFetch({ ...base, "GET /pages/p1/shares": () => errorResponse(501, "internal", "not implemented") });
    open();
    openPublicTab();
    expect(await screen.findByText("Public links aren't available yet")).toBeInTheDocument();
  });

  it("creates a link (with the sub-pages option) when none exists", async () => {
    let created = false;
    const link = {
      id: "s1",
      pageId: "p1",
      token: "tok",
      url: "https://notes.example/s/tok",
      includeSubpages: true,
      createdAt: "2026-10-09T00:00:00Z",
      revokedAt: null,
    };
    routeFetch({
      ...base,
      "GET /pages/p1/shares": () => jsonResponse(created ? [link] : []),
      "POST /pages/p1/shares": () => {
        created = true;
        return jsonResponse(link, 201);
      },
    });
    open();
    openPublicTab();
    fireEvent.click(await screen.findByLabelText("Include sub-pages"));
    fireEvent.click(screen.getByRole("button", { name: /create public link/i }));
    expect(await screen.findByLabelText("Public link URL")).toHaveValue("https://notes.example/s/tok");
    const post = fetchMock.mock.calls.find(([r]) => r.method === "POST")![0];
    await expect(post.clone().json()).resolves.toEqual({ includeSubpages: true });
    expect(screen.getByRole("button", { name: /revoke link/i })).toBeInTheDocument();
  });

  it("only lists active links", async () => {
    routeFetch({
      ...base,
      "GET /pages/p1/shares": () =>
        jsonResponse([
          {
            id: "s1",
            pageId: "p1",
            token: "a",
            url: "https://x/s/a",
            includeSubpages: false,
            createdAt: "x",
            revokedAt: "2026-10-01T00:00:00Z",
          },
          {
            id: "s2",
            pageId: "p1",
            token: "b",
            url: "https://x/s/b",
            includeSubpages: false,
            createdAt: "x",
            revokedAt: null,
          },
        ]),
    });
    open();
    openPublicTab();
    expect(await screen.findAllByLabelText("Public link URL")).toHaveLength(1);
  });
});
