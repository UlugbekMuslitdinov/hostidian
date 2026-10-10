import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeMe, makeMembership } from "@/test/factories";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import { AddUserDialog } from "./add-user-dialog";

const user = (overrides: Record<string, unknown> = {}) => ({
  id: "u-2",
  email: "bob@example.com",
  name: "Bob",
  avatarColor: "#64b5f6",
  isInstanceAdmin: false,
  createdAt: "2026-10-01T10:00:00Z",
  workspaceCount: 0,
  ...overrides,
});

const me = makeMe({
  workspaces: [
    makeMembership({ role: "owner" }),
    makeMembership({
      role: "member",
      workspace: { id: "ws-2", name: "Not mine", slug: "not-mine", icon: null, createdAt: "2026-01-01T00:00:00Z" },
    }),
    makeMembership({
      role: "admin",
      workspace: { id: "ws-3", name: "Side", slug: "side", icon: null, createdAt: "2026-01-01T00:00:00Z" },
    }),
  ],
});

const posts = () => fetchMock.mock.calls.filter(([r]) => r.method === "POST" && r.url.endsWith("/admin/users"));
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: /create user/i }));

function renderDialog() {
  return renderWithApp(<AddUserDialog open onOpenChange={() => undefined} />, { me });
}

describe("AddUserDialog", () => {
  it("validates name, email and a too-short password before calling the API", async () => {
    routeFetch({});
    renderDialog();
    submit();
    expect(await screen.findByText("Enter their name.")).toBeInTheDocument();
    expect(screen.getByText("Enter your email address.")).toBeInTheDocument();

    fill("Name", "Bob");
    fill("Email", "bob@example.com");
    fill("Password (optional)", "short");
    submit();
    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("only offers workspaces the admin owns or administers, and no admin role to a plain admin", () => {
    routeFetch({});
    renderDialog();
    expect(screen.getByLabelText("Acme")).toBeInTheDocument();
    expect(screen.getByLabelText("Side")).toBeInTheDocument();
    expect(screen.queryByLabelText("Not mine")).not.toBeInTheDocument();

    const ownerRole = screen.getByLabelText("Role in Acme");
    expect(within(ownerRole).getByRole("option", { name: "Admin" })).toBeInTheDocument();
    expect(within(screen.getByLabelText("Role in Side")).queryByRole("option", { name: "Admin" })).toBeNull();
    expect(ownerRole).toBeDisabled();
  });

  it("creates a user with a password and memberships, then confirms without a link", async () => {
    let body: unknown;
    routeFetch({
      "POST /admin/users": async (request) => {
        body = await request.json();
        return jsonResponse({ user: user() }, 201);
      },
    });
    const { qc } = renderDialog();
    fill("Name", " Bob ");
    fill("Email", "bob@example.com");
    fill("Password (optional)", "a-long-enough-password");
    fireEvent.click(screen.getByLabelText("Instance admin"));
    fireEvent.click(screen.getByLabelText("Acme"));
    fireEvent.change(screen.getByLabelText("Role in Acme"), { target: { value: "guest" } });
    submit();

    expect(await screen.findByText("Account created")).toBeInTheDocument();
    expect(body).toEqual({
      name: "Bob",
      email: "bob@example.com",
      password: "a-long-enough-password",
      isInstanceAdmin: true,
      memberships: [{ workspaceId: "ws-1", role: "guest" }],
    });
    expect(screen.getByText(/can sign in right away/i)).toBeInTheDocument();
    expect(screen.queryByTestId("set-password-link")).not.toBeInTheDocument();
    expect(qc.getQueryState(["admin", "users"])).toBeUndefined(); // nothing cached yet, but it would be invalidated
  });

  it("shows the one-time set-password link prominently when no password was given", async () => {
    routeFetch({
      "POST /admin/users": async (request) => {
        const sent = (await request.json()) as Record<string, unknown>;
        expect(sent).not.toHaveProperty("password");
        expect(sent).not.toHaveProperty("memberships");
        return jsonResponse(
          {
            user: user(),
            setPasswordUrl: "http://localhost/reset-password/tok123",
            setPasswordExpiresAt: "2026-10-08T10:00:00Z",
          },
          201,
        );
      },
    });
    renderDialog();
    fill("Name", "Bob");
    fill("Email", "bob@example.com");
    submit();

    const box = await screen.findByTestId("set-password-link");
    expect(within(box).getByLabelText("Set-password link")).toHaveValue("http://localhost/reset-password/tok123");
    expect(within(box).getByRole("button", { name: /copy link/i })).toBeInTheDocument();
    expect(box).toHaveTextContent(/No email was sent/);
    expect(box).toHaveTextContent(/expires/);
  });

  it("explains a duplicate email on the field", async () => {
    routeFetch({ "POST /admin/users": () => errorResponse(409, "conflict", "exists") });
    renderDialog();
    fill("Name", "Bob");
    fill("Email", "bob@example.com");
    submit();
    expect(await screen.findByText("An account with this email already exists.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });

  it("maps server validation details onto fields and handles a not-yet-implemented server", async () => {
    routeFetch({
      "POST /admin/users": () =>
        errorResponse(422, "validation_failed", "bad", { password: "Password is too common." }),
    });
    renderDialog();
    fill("Name", "Bob");
    fill("Email", "bob@example.com");
    fill("Password (optional)", "password1234567");
    submit();
    expect(await screen.findByText("Password is too common.")).toBeInTheDocument();

    routeFetch({ "POST /admin/users": () => errorResponse(501, "not_implemented", "nope") });
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/isn't available on this server yet/));
  });

  it("tells the admin when a selected workspace isn't theirs to manage (404)", async () => {
    routeFetch({ "POST /admin/users": () => errorResponse(404, "not_found", "nope") });
    renderDialog();
    fill("Name", "Bob");
    fill("Email", "bob@example.com");
    submit();
    expect(await screen.findByText(/can't be found, or you can't manage it/)).toBeInTheDocument();
  });
});
