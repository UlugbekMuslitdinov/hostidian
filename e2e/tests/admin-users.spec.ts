import type { Browser, Page } from "@playwright/test";
import { ADMIN_STATE_FILE, BASE_URL } from "../helpers/env";
import { expect, test } from "../helpers/fixtures";
import { uniqueEmail } from "../helpers/names";

const PASSWORD = "e2e-brand-new-password-1";

/** The instance admin in a browser: the session the onboarding spec saved. */
async function adminPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: ADMIN_STATE_FILE });
  return context.newPage();
}

async function openAddUser(page: Page) {
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Add user" }).click();
  // The dialog is renamed once the account exists ("Account created"), so don't pin it to the form's title.
  return page.getByRole("dialog");
}

test.describe("instance admin creates accounts", () => {
  test("with a password: the new user is listed, joins the chosen workspace and can sign in", async ({
    browser,
    team,
  }) => {
    const email = uniqueEmail("carol");
    const page = await adminPage(browser);
    try {
      const dialog = await openAddUser(page);
      await dialog.getByLabel("Name").fill("Carol Created");
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByLabel("Password (optional)").fill(PASSWORD);
      await dialog.getByRole("checkbox", { name: team.workspace.name }).check();
      await dialog.getByLabel(`Role in ${team.workspace.name}`).selectOption("guest");
      await dialog.getByRole("button", { name: "Create user" }).click();

      await expect(dialog.getByText("Account created")).toBeVisible();
      await expect(dialog.getByText(/can sign in right away/)).toBeVisible();
      await expect(dialog.getByTestId("set-password-link")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();

      // The list refreshed and shows the new account.
      await expect(page.getByRole("listitem").filter({ hasText: email })).toBeVisible();

      // They can sign in through the real login form and land in the workspace they were added to.
      const fresh = await browser.newContext({ baseURL: BASE_URL });
      const carol = await fresh.newPage();
      await carol.goto("/login");
      await carol.getByLabel("Email").fill(email);
      await carol.getByLabel("Password").fill(PASSWORD);
      await carol.getByRole("button", { name: "Log in" }).click();
      await expect(carol).toHaveURL(new RegExp(`/w/${team.workspace.slug}`));
      await fresh.close();

      const members = await team.owner.api.ctx.get(`/api/workspaces/${team.workspace.id}/members`);
      const list = (await members.json()) as { user: { email: string }; role: string }[];
      expect(list.find((m) => m.user.email === email)?.role).toBe("guest");
    } finally {
      await page.context().close();
    }
  });

  test("without a password: shows a one-time set-password link that works", async ({ browser }) => {
    const email = uniqueEmail("dave");
    const page = await adminPage(browser);
    try {
      const dialog = await openAddUser(page);
      await dialog.getByLabel("Name").fill("Dave Linked");
      await dialog.getByLabel("Email").fill(email);
      await dialog.getByRole("button", { name: "Create user" }).click();

      const box = dialog.getByTestId("set-password-link");
      await expect(box).toBeVisible();
      await expect(box).toContainText("No email was sent");
      await expect(box.getByRole("button", { name: "Copy link" })).toBeVisible();
      const link = await box.getByLabel("Set-password link").inputValue();
      expect(link).toContain("/reset-password/");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("listitem").filter({ hasText: email })).toBeVisible();

      // The person opens the link, chooses a password, signs in.
      const fresh = await browser.newContext({ baseURL: BASE_URL });
      const dave = await fresh.newPage();
      await dave.goto(link);
      await dave.getByLabel("New password", { exact: true }).fill(PASSWORD);
      await dave.getByLabel("Confirm new password").fill(PASSWORD);
      await dave.getByRole("button", { name: /set|save|update|reset|change/i }).click();
      await expect(dave.getByText("Password set")).toBeVisible();
      await dave.getByRole("link", { name: "Go to login" }).click();
      await dave.getByLabel("Email").fill(email);
      await dave.getByLabel("Password").fill(PASSWORD);
      await dave.getByRole("button", { name: "Log in" }).click();
      await expect(dave).not.toHaveURL(/\/login/);

      // The link is single-use.
      const again = await fresh.newPage();
      await again.goto(link);
      await again.getByLabel("New password", { exact: true }).fill(PASSWORD);
      await again.getByLabel("Confirm new password").fill(PASSWORD);
      await again.getByRole("button", { name: /set|save|update|reset|change/i }).click();
      await expect(again.getByText("Link expired")).toBeVisible();
      await fresh.close();
    } finally {
      await page.context().close();
    }
  });

  test("a duplicate email is explained on the field, and validation runs first", async ({ browser, team }) => {
    const page = await adminPage(browser);
    try {
      const dialog = await openAddUser(page);
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByText("Enter their name.")).toBeVisible();
      await expect(dialog.getByText("Enter your email address.")).toBeVisible();

      await dialog.getByLabel("Name").fill("Copycat");
      await dialog.getByLabel("Email").fill(team.owner.email.toUpperCase());
      await dialog.getByLabel("Password (optional)").fill("short");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByText("Use at least 10 characters.")).toBeVisible();

      await dialog.getByLabel("Password (optional)").fill("");
      await dialog.getByRole("button", { name: "Create user" }).click();
      await expect(dialog.getByText("An account with this email already exists.")).toBeVisible();
    } finally {
      await page.context().close();
    }
  });

  test("a regular user has no way into the admin area, and the API refuses them", async ({ team }) => {
    const response = await team.owner.api.ctx.post("/api/admin/users", {
      data: { name: "Nope", email: uniqueEmail("nope"), password: PASSWORD },
    });
    expect(response.status()).toBe(403);

    const page = await team.owner.newPage();
    await page.goto("/admin/users");
    await expect(page.getByRole("button", { name: "Add user" })).toHaveCount(0);
  });
});
