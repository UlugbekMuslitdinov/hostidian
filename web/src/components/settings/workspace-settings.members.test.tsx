import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { errorResponse, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import { WorkspaceSettings } from "./workspace-settings";

const invite = (overrides: Record<string, unknown> = {}) => ({
  id: "inv-1",
  token: "tok",
  url: "http://localhost/invite/tok",
  role: "guest",
  email: "new@example.com",
  expiresAt: "2026-10-20T10:00:00Z",
  createdAt: "2026-10-10T10:00:00Z",
  ...overrides,
});

describe("Workspace settings: adding people", () => {
  it("falls back from 'no such account' to a prefilled invite and highlights the new link", async () => {
    let created: unknown;
    routeFetch({
      "GET /workspaces/ws-1/members": () => jsonResponse([]),
      "GET /workspaces/ws-1/invites": () => jsonResponse(created ? [invite()] : []),
      "POST /workspaces/ws-1/members": () => errorResponse(404, "not_found", "no user"),
      "POST /workspaces/ws-1/invites": async (request) => {
        created = await request.json();
        return jsonResponse(invite(), 201);
      },
    });
    renderWithApp(<WorkspaceSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add member" }));
    const form = screen.getByRole("form", { name: "Add member" });
    fireEvent.change(within(form).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(within(form).getByLabelText("Role"), { target: { value: "guest" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add member" }));
    fireEvent.click(await within(form).findByRole("button", { name: "Create an invite link" }));

    // The add-member panel closes and the invite form carries the email and role over.
    await waitFor(() => expect(screen.queryByRole("form", { name: "Add member" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Email (optional)")).toHaveValue("new@example.com");
    expect(screen.getByLabelText("Role")).toHaveValue("guest");
    expect(screen.getByText(/Hostidian doesn't send email/)).toBeInTheDocument();
    expect(screen.getByText(/Only this email address can use the link/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create invite link" }));
    const fresh = await screen.findByTestId("new-invite");
    expect(created).toMatchObject({ role: "guest", email: "new@example.com" });
    expect(fresh).toHaveTextContent("no email was sent");
    expect(within(fresh).getByLabelText("New invite link")).toHaveValue("http://localhost/invite/tok");
    expect(within(fresh).getByRole("button", { name: /copy link/i })).toBeInTheDocument();
  });
});
