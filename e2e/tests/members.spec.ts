import type { Page } from "@playwright/test";
import { Api } from "../helpers/api";
import { ADMIN_STATE_FILE, BASE_URL, USER_PASSWORD } from "../helpers/env";
import { expect, test, type Team } from "../helpers/fixtures";
import { uniqueEmail } from "../helpers/names";

/** An account that belongs to no workspace (created the way an instance admin would). */
async function lonelyUser(adminApi: Api, name: string) {
  const email = uniqueEmail(name);
  const response = await adminApi.ctx.post("/api/admin/users", { data: { name, email, password: USER_PASSWORD } });
  expect(response.status()).toBe(201);
  return { name, email };
}

async function openMembers(page: Page, team: Team) {
  // Visiting the workspace makes it the "current" one, which is what the settings pages act on.
  await page.goto(`/w/${team.workspace.slug}`);
  await page.getByRole("link", { name: "Graph" }).waitFor();
  await page.goto("/settings/workspace");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(team.workspace.name);
}

test.describe("adding people to a workspace", () => {
  test("an admin adds an existing account by email; it shows up in the list and the person has access", async ({
    team,
    adminApi,
  }) => {
    const bob = await lonelyUser(adminApi, "Bob");
    const page = await team.owner.newPage();
    await openMembers(page, team);

    await page.getByRole("button", { name: "Add member" }).click();
    const form = page.getByRole("form", { name: "Add member" });
    await form.getByLabel("Email").fill(bob.email);
    await form.getByLabel("Role").selectOption("guest");
    await form.getByRole("button", { name: "Add member" }).click();

    await expect(form.getByRole("status")).toContainText(`${bob.name} (${bob.email}) was added as Guest.`);
    await expect(page.getByRole("listitem").filter({ hasText: bob.email })).toBeVisible();

    const bobApi = await Api.create();
    const me = await bobApi.login(bob.email, USER_PASSWORD);
    expect(me.workspaces.find((m) => m.workspace.id === team.workspace.id)?.role).toBe("guest");
    await bobApi.dispose();

    // Adding the same person again is a conflict, said plainly.
    await form.getByLabel("Email").fill(bob.email.toUpperCase());
    await form.getByRole("button", { name: "Add member" }).click();
    await expect(form.getByRole("alert")).toContainText("already a member");
  });

  test("an unknown email offers an invite link instead, prefilled, and the link works", async ({ team }) => {
    const stranger = uniqueEmail("stranger");
    const page = await team.owner.newPage();
    await openMembers(page, team);

    await page.getByRole("button", { name: "Add member" }).click();
    const form = page.getByRole("form", { name: "Add member" });
    await form.getByLabel("Email").fill(stranger);
    await form.getByRole("button", { name: "Add member" }).click();
    await expect(form.getByRole("alert")).toContainText("No account with that email");
    await form.getByRole("button", { name: "Create an invite link" }).click();

    // The Invites section is prefilled with that email and the same role.
    const invites = page.locator("section#invites");
    await expect(invites.getByLabel("Email (optional)")).toHaveValue(stranger);
    await expect(invites.getByLabel("Role")).toHaveValue("member");
    await expect(invites).toContainText("Hostidian doesn't send email");
    await expect(invites).toContainText("Only this email address can use the link");

    await invites.getByRole("button", { name: "Create invite link" }).click();
    const fresh = page.getByTestId("new-invite");
    await expect(fresh).toContainText("Send this link to the person yourself");
    await expect(fresh.getByRole("button", { name: "Copy link" })).toBeVisible();
    const link = await fresh.getByLabel("New invite link").inputValue();
    expect(link).toContain("/invite/");

    // The link is restricted to that address and signs the person up into this workspace.
    const token = link.split("/invite/")[1]!;
    const wrong = await Api.create();
    const refused = await wrong.ctx.post("/api/auth/register", {
      data: { name: "Impostor", email: uniqueEmail("other"), password: USER_PASSWORD, inviteToken: token },
    });
    expect(refused.ok()).toBe(false);
    await wrong.dispose();

    const right = await Api.create();
    const me = await right.register({ name: "Stranger", email: stranger, password: USER_PASSWORD, inviteToken: token });
    expect(me.workspaces.map((m) => m.workspace.id)).toContain(team.workspace.id);
    await right.dispose();
  });

  test("only owners can offer the Admin role", async ({ team, browser }) => {
    const adminPage = await team.owner.newPage();
    await openMembers(adminPage, team);
    await adminPage.getByRole("button", { name: "Add member" }).click();
    const adminForm = adminPage.getByRole("form", { name: "Add member" });
    await expect(adminForm.getByLabel("Role").getByRole("option")).toHaveText(["Member", "Guest"]);

    // The instance admin created the workspace, so they own it.
    const context = await browser.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE_FILE });
    try {
      const ownerPage = await context.newPage();
      await openMembers(ownerPage, team);
      await ownerPage.getByRole("button", { name: "Add member" }).click();
      const ownerForm = ownerPage.getByRole("form", { name: "Add member" });
      await expect(ownerForm.getByLabel("Role").getByRole("option")).toHaveText(["Member", "Guest", "Admin"]);
    } finally {
      await context.close();
    }
  });

  test("a plain member can't add anyone", async ({ team }) => {
    const mia = await team.addUser("Mia", "member");
    const response = await mia.api.ctx.post(`/api/workspaces/${team.workspace.id}/members`, {
      data: { email: team.owner.email, role: "member" },
    });
    expect(response.status()).toBe(403);

    const page = await mia.newPage();
    await openMembers(page, team);
    await expect(page.getByRole("button", { name: "Add member" })).toHaveCount(0);
  });
});
