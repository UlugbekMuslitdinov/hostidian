import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import { AddMemberPanel } from "./add-member-panel";

const member = {
  user: { id: "u-2", email: "bob@example.com", name: "Bob", avatarColor: "#64b5f6", isInstanceAdmin: false, hasPassword: true, createdAt: "2026-01-01T00:00:00Z" },
  role: "member",
  joinedAt: "2026-10-01T10:00:00Z",
};

const posts = () => fetchMock.mock.calls.filter(([r]) => r.method === "POST" && r.url.endsWith("/members"));
const fillEmail = (value: string) => fireEvent.change(screen.getByLabelText("Email"), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Add member" }));

function renderPanel(actorRole: "owner" | "admin" = "owner", onNeedInvite = vi.fn()) {
  renderWithApp(<AddMemberPanel workspaceId="ws-1" actorRole={actorRole} onClose={() => undefined} onNeedInvite={onNeedInvite} />);
  return onNeedInvite;
}

describe("AddMemberPanel", () => {
  it("validates the email first", async () => {
    routeFetch({});
    renderPanel();
    submit();
    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    fillEmail("nope");
    submit();
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("only owners may offer the Admin role", () => {
    routeFetch({});
    const { unmount } = renderWithApp(
      <AddMemberPanel workspaceId="ws-1" actorRole="owner" onClose={() => undefined} onNeedInvite={() => undefined} />,
    );
    expect(within(screen.getByLabelText("Role")).getByRole("option", { name: "Admin" })).toBeInTheDocument();
    unmount();
    renderPanel("admin");
    expect(within(screen.getByLabelText("Role")).queryByRole("option", { name: "Admin" })).toBeNull();
  });

  it("adds an existing account by email and confirms", async () => {
    let body: unknown;
    routeFetch({
      "POST /workspaces/ws-1/members": async (request) => {
        body = await request.json();
        return jsonResponse(member, 201);
      },
    });
    renderPanel();
    fillEmail(" bob@example.com ");
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "guest" } });
    submit();
    expect(await screen.findByRole("status")).toHaveTextContent("Bob (bob@example.com) was added as Guest.");
    expect(body).toEqual({ email: "bob@example.com", role: "guest" });
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("offers an invite link when there is no account with that email", async () => {
    routeFetch({ "POST /workspaces/ws-1/members": () => errorResponse(404, "not_found", "no user") });
    const onNeedInvite = renderPanel();
    fillEmail("new@example.com");
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "guest" } });
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No account with that email");
    fireEvent.click(within(alert).getByRole("button", { name: "Create an invite link" }));
    expect(onNeedInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "guest" });
  });

  it("says when the person is already a member", async () => {
    routeFetch({ "POST /workspaces/ws-1/members": () => errorResponse(409, "conflict", "dup") });
    renderPanel();
    fillEmail("bob@example.com");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("already a member");
  });

  it("copes with a server that hasn't implemented it yet", async () => {
    routeFetch({ "POST /workspaces/ws-1/members": () => errorResponse(501, "not_implemented", "no") });
    renderPanel();
    fillEmail("bob@example.com");
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn't available on this server yet/));
  });
});
