import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { connectivityStore } from "@/lib/offline/connectivity-store";
import { errorResponse, fetchMock, jsonResponse, routeFetch } from "@/test/fetch-mock";
import { renderWithApp } from "@/test/render";
import { TokensPanel } from "./tokens-panel";

afterEach(() => act(() => connectivityStore.set({ online: true })));

const apiToken = (overrides: Record<string, unknown> = {}) => ({
  id: "t-1",
  name: "Claude Code",
  prefix: "hst_ab12cd",
  scope: "read",
  workspaceId: null,
  expiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-01T10:00:00Z",
  ...overrides,
});

const SECRET = "hst_ab12cdSECRETSECRETSECRETSECRETSECRET00000";
const MCP_URL = "https://notes.example.com/api/mcp";

describe("TokensPanel", () => {
  it("lists tokens with scope, workspace, expiry and last use", async () => {
    routeFetch({
      "GET /auth/tokens": () =>
        jsonResponse([
          apiToken(),
          apiToken({
            id: "t-2",
            name: "Cursor",
            scope: "write",
            workspaceId: "ws-1",
            expiresAt: "2099-01-01T00:00:00Z",
            lastUsedAt: "2026-10-02T10:00:00Z",
          }),
        ]),
    });
    renderWithApp(<TokensPanel />);
    const list = await screen.findByRole("list", { name: "Access tokens" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("Claude Code");
    expect(first).toHaveTextContent("Read only");
    expect(first).toHaveTextContent("hst_ab12cd…");
    expect(first).toHaveTextContent("All workspaces");
    expect(first).toHaveTextContent("never expires");
    expect(first).toHaveTextContent("never used");
    expect(second).toHaveTextContent("Cursor");
    expect(second).toHaveTextContent("Read and write");
    expect(second).toHaveTextContent("Acme");
    expect(second).toHaveTextContent(/last used/);
  });

  it("shows an empty state and the explainer", async () => {
    routeFetch({ "GET /auth/tokens": () => jsonResponse([]) });
    renderWithApp(<TokensPanel />);
    expect(await screen.findByText("No access tokens yet")).toBeInTheDocument();
    expect(screen.getByText("What can agents do?")).toBeInTheDocument();
    expect(screen.getByText(/Treat tokens like passwords/)).toBeInTheDocument();
  });

  it("explains a server without token support", async () => {
    routeFetch({ "GET /auth/tokens": () => errorResponse(501, "not_implemented", "x") });
    renderWithApp(<TokensPanel />);
    expect(await screen.findByText("Access tokens aren't available on this server yet.")).toBeInTheDocument();
  });

  it("creates a token, shows the secret once with snippets, and never again", async () => {
    let created = false;
    let body: unknown;
    routeFetch({
      "GET /auth/tokens": () => jsonResponse(created ? [apiToken({ name: "Laptop", scope: "write" })] : []),
      "POST /auth/tokens": async (request) => {
        body = await request.json();
        created = true;
        return jsonResponse({ token: SECRET, apiToken: apiToken({ name: "Laptop", scope: "write" }), mcpUrl: MCP_URL }, 201);
      },
    });
    renderWithApp(<TokensPanel />);
    await screen.findByText("No access tokens yet");
    fireEvent.click(screen.getByRole("button", { name: /create token/i }));

    // Validation first.
    const dialog = await screen.findByRole("dialog", { name: "Create access token" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(await within(dialog).findByText("Enter a name for the token.")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([r]) => r.method === "POST")).toBe(false);

    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: " Laptop " } });
    fireEvent.click(within(dialog).getByLabelText(/Read and write/));
    fireEvent.change(within(dialog).getByLabelText("Workspace"), { target: { value: "ws-1" } });
    fireEvent.change(within(dialog).getByLabelText("Expires"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));

    const secret = await screen.findByTestId("token-secret");
    expect(body).toEqual({ name: "Laptop", scope: "write", workspaceId: "ws-1", expiresInDays: 30 });
    expect(secret).toHaveTextContent(SECRET);

    // Ready-to-paste snippets use the mcpUrl from the response and the real token.
    expect(screen.getByText(`claude mcp add --transport http hostidian ${MCP_URL} --header "Authorization: Bearer ${SECRET}"`)).toBeInTheDocument();
    expect(screen.getByText(/mcp-remote/, { selector: "p" })).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(MCP_URL)).length).toBeGreaterThanOrEqual(3);

    // The only way out is "I've saved it" (no close button), and the secret is gone afterwards.
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(await screen.findByText("Laptop")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SECRET);
  });

  it("omits workspace and expiry from the request for 'all workspaces' and 'never'", async () => {
    let body: unknown;
    routeFetch({
      "GET /auth/tokens": () => jsonResponse([]),
      "POST /auth/tokens": async (request) => {
        body = await request.json();
        return jsonResponse({ token: SECRET, apiToken: apiToken(), mcpUrl: MCP_URL }, 201);
      },
    });
    renderWithApp(<TokensPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /create token/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "CI" } });
    fireEvent.change(within(dialog).getByLabelText("Expires"), { target: { value: "never" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create token" }));
    await screen.findByTestId("token-secret");
    expect(body).toEqual({ name: "CI", scope: "read" });
  });

  it("revokes only after confirming", async () => {
    let revoked = false;
    routeFetch({
      "GET /auth/tokens": () => jsonResponse(revoked ? [] : [apiToken()]),
      "DELETE /auth/tokens/t-1": () => {
        revoked = true;
        return jsonResponse(null, 204);
      },
    });
    renderWithApp(<TokensPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Claude Code" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/stops working immediately/);
    expect(revoked).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(revoked).toBe(true));
    expect(await screen.findByText("No access tokens yet")).toBeInTheDocument();
  });

  it("can't create tokens offline", async () => {
    routeFetch({ "GET /auth/tokens": () => jsonResponse([]) });
    act(() => connectivityStore.set({ online: false }));
    renderWithApp(<TokensPanel />);
    const trigger = await screen.findByRole("button", { name: /create token/i });
    expect(trigger).toBeDisabled();
  });
});
