import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import type { InviteRole, PageSummary, Visibility } from "@hostidian/api-types";
import { Api } from "./api";
import { ADMIN_STATE_FILE, BASE_URL, USER_PASSWORD } from "./env";
import { uniqueEmail, uniqueName } from "./names";
import { buildVault } from "./vault";

export { expect };

/** A signed-in user of a test workspace: their API client plus a way to open the app as them in a browser. */
export class Actor {
  constructor(
    readonly name: string,
    readonly email: string,
    readonly userId: string,
    readonly api: Api,
    private readonly browser: Browser,
    private readonly contexts: BrowserContext[],
  ) {}

  /** A fresh browser context carrying this user's session (kept open until the test ends). */
  async newContext(options: Parameters<Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
    const context = await this.browser.newContext({
      baseURL: BASE_URL,
      ...options,
      storageState: await this.api.storageState(),
    });
    this.contexts.push(context);
    return context;
  }

  /** A page in a fresh context of this user. */
  async newPage(options: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
    return (await this.newContext(options)).newPage();
  }
}

export interface TestWorkspace {
  id: string;
  slug: string;
  name: string;
}

/**
 * An isolated workspace for one test: created by the instance admin, with a workspace-admin user (`owner`) and
 * helpers to add more people. Every test gets its own, so tests never see each other's pages and can run in
 * parallel and be repeated against the same stack.
 */
export class Team {
  constructor(
    readonly workspace: TestWorkspace,
    readonly owner: Actor,
    private readonly adminApi: Api,
    private readonly browser: Browser,
    private readonly contexts: BrowserContext[],
  ) {}

  /** Invite a new user (`member` by default) and sign them up through the API; returns them signed in. */
  async addUser(name: string, role: InviteRole = "member"): Promise<Actor> {
    const invite = await this.adminApi.createInvite(this.workspace.id, role);
    const api = await Api.create();
    const email = uniqueEmail(name);
    const me = await api.register({ name, email, password: USER_PASSWORD, inviteToken: invite.token });
    return new Actor(name, email, me.user.id, api, this.browser, this.contexts);
  }

  /** A page created through the API by `by` (the workspace owner unless given). */
  async createPage(
    input: { title?: string; parentId?: string | null; visibility?: Visibility } = {},
    by: Actor = this.owner,
  ): Promise<PageSummary> {
    return by.api.createPage(this.workspace.id, { title: input.title ?? uniqueName("Page"), ...input });
  }

  pagePath(pageId: string): string {
    return `/w/${this.workspace.slug}/p/${pageId}`;
  }

  /**
   * Create pages with content through the real import pipeline (an Obsidian-style vault zip): much faster than
   * typing, and the content goes through the same Markdown -> Y.Doc -> extraction path as everything else.
   * Returns the pages by title.
   */
  async importVault(files: Record<string, string | Uint8Array>, by: Actor = this.owner): Promise<Record<string, PageSummary>> {
    await by.api.importAndWait(this.workspace.id, buildVault(files));
    const pages = await by.api.listPages(this.workspace.id);
    return Object.fromEntries(pages.map((page) => [page.title, page]));
  }
}

interface Fixtures {
  /** The instance admin's API client (session saved by the onboarding spec). */
  adminApi: Api;
  /** A fresh isolated workspace with an owner. */
  team: Team;
}

export const test = base.extend<Fixtures>({
  adminApi: [
    async ({}, use) => {
      const api = await Api.create({ storageState: ADMIN_STATE_FILE });
      await use(api);
      await api.dispose();
    },
    { scope: "test" },
  ],

  team: async ({ adminApi, browser }, use) => {
    const contexts: BrowserContext[] = [];
    const name = uniqueName("Team");
    const membership = await adminApi.createWorkspace(name);
    const workspace: TestWorkspace = { id: membership.workspace.id, slug: membership.workspace.slug, name };

    const invite = await adminApi.createInvite(workspace.id, "admin");
    const ownerApi = await Api.create();
    const email = uniqueEmail("alice");
    const me = await ownerApi.register({ name: "Alice", email, password: USER_PASSWORD, inviteToken: invite.token });
    const owner = new Actor("Alice", email, me.user.id, ownerApi, browser, contexts);

    await use(new Team(workspace, owner, adminApi, browser, contexts));

    for (const context of contexts) await context.close().catch(() => undefined);
  },
});
