import { request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../helpers/env";
import { expect, test } from "../helpers/fixtures";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
};

/** A bare request to the MCP endpoint, the way a non-browser client would send it (no cookies, no Origin). */
async function callMcp(headers: Record<string, string> = {}) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  try {
    const response = await ctx.post("/api/mcp", {
      data: initialize,
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    });
    return { status: response.status(), challenge: response.headers()["www-authenticate"] ?? "" };
  } finally {
    await ctx.dispose();
  }
}

test.describe("access tokens for MCP clients", () => {
  test("the endpoint refuses requests without a token, even from a signed-in browser session", async ({ team }) => {
    const anonymous = await callMcp();
    expect(anonymous.status).toBe(401);
    expect(anonymous.challenge).toMatch(/^Bearer/);

    const cookies = (await team.owner.api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect((await callMcp({ cookie: cookies })).status).toBe(401);
    expect((await callMcp({ authorization: "Bearer hst_not-a-real-token" })).status).toBe(401);
  });

  test("create a token: the secret is shown once with connection snippets; revoking it kills access", async ({
    team,
  }) => {
    const page = await team.owner.newPage();
    await page.goto("/settings/tokens");
    await expect(page.getByRole("heading", { name: "Access tokens" }).first()).toBeVisible();
    await expect(page.getByText("No access tokens yet")).toBeVisible();
    await expect(page.getByText("What can agents do?")).toBeVisible();

    await page.getByRole("button", { name: "Create token" }).click();
    // The dialog is renamed once the token exists ("Token created"), so it is found by role alone.
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Create token" }).click();
    await expect(dialog.getByText("Enter a name for the token.")).toBeVisible();

    await dialog.getByLabel("Name").fill("Claude Code e2e");
    await dialog.getByLabel(/Read and write/).check();
    await dialog.getByLabel("Workspace").selectOption({ label: team.workspace.name });
    await dialog.getByLabel("Expires").selectOption("30");
    await dialog.getByRole("button", { name: "Create token" }).click();

    // The secret appears in a monospace box together with ready-to-paste snippets.
    const secretBox = dialog.getByTestId("token-secret");
    await expect(secretBox).toBeVisible();
    const secret = (await secretBox.textContent())!.trim();
    expect(secret).toMatch(/^hst_[A-Za-z0-9_-]{20,}$/);
    const mcpUrl = `${BASE_URL}/api/mcp`;
    await expect(
      dialog.getByText(`claude mcp add --transport http hostidian ${mcpUrl} --header "Authorization: Bearer ${secret}"`),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy token" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy JSON config" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toHaveCount(0);

    // Escape doesn't dismiss the one-time secret by accident.
    await page.keyboard.press("Escape");
    await expect(secretBox).toBeVisible();

    // The token works on the MCP endpoint.
    expect((await callMcp({ authorization: `Bearer ${secret}` })).status).toBe(200);

    await dialog.getByRole("button", { name: "I've saved it" }).click();
    await expect(dialog).toBeHidden();

    // The list shows it (prefix only, never the secret), and a reload doesn't bring the secret back.
    const row = page.getByRole("listitem").filter({ hasText: "Claude Code e2e" });
    await expect(row).toContainText(secret.slice(0, 10));
    await expect(row).toContainText("Read and write");
    await expect(row).toContainText(team.workspace.name);
    await expect(row).toContainText("never used");
    await page.reload();
    await expect(row).toBeVisible();
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(page.getByText(secret.slice(0, 30))).toHaveCount(0);

    // Revoke asks first, then the token stops working immediately.
    await row.getByRole("button", { name: "Revoke Claude Code e2e" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("stops working immediately");
    await confirm.getByRole("button", { name: "Revoke token" }).click();
    await expect(page.getByText("No access tokens yet")).toBeVisible();
    expect((await callMcp({ authorization: `Bearer ${secret}` })).status).toBe(401);
  });

  test("tokens can't be used on the REST API", async ({ team }) => {
    const created = await team.owner.api.ctx.post("/api/auth/tokens", { data: { name: "rest probe", scope: "read" } });
    expect(created.status()).toBe(201);
    const { token } = (await created.json()) as { token: string };
    const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
    try {
      expect((await ctx.get("/api/auth/me", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
      expect((await ctx.get("/api/auth/tokens", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
