import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { Api } from "../helpers/api";
import { ADMIN, ADMIN_STATE_FILE } from "../helpers/env";

/**
 * Plan scenario (a), first half: set the instance up through the real setup form and land in the app. On a stack
 * that already has this admin (the suite was run before) it signs in through the login form instead, so the whole
 * suite can be repeated against one stack. Either way it saves the admin's session for the other specs.
 */
test("the instance admin can be created or signed in through the UI", async ({ page, context }) => {
  const api = await Api.create();
  const fresh = await api.needsSetup();
  await api.dispose();

  await page.goto("/");

  if (fresh) {
    await expect(page).toHaveURL(/\/setup$/);
    await page.getByLabel("Your name").fill(ADMIN.name);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await page.getByLabel("Confirm password").fill(ADMIN.password);
    await page.getByLabel("Workspace name").fill("E2E Home");
    await page.getByRole("button", { name: "Create administrator" }).click();
  } else {
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Log in" }).click();
  }

  // Signed in: the app shell shows the sidebar of a workspace.
  await expect(page).toHaveURL(/\/w\/[^/]+/);
  await expect(page.getByRole("link", { name: "Graph" })).toBeVisible();

  fs.mkdirSync(path.dirname(ADMIN_STATE_FILE), { recursive: true });
  await context.storageState({ path: ADMIN_STATE_FILE });

  // The saved session really is the admin's.
  const admin = await Api.create({ storageState: ADMIN_STATE_FILE });
  const me = await admin.me();
  expect(me.user.email).toBe(ADMIN.email);
  expect(me.user.isInstanceAdmin).toBe(true);
  expect(await admin.needsSetup()).toBe(false);
  await admin.dispose();
});
