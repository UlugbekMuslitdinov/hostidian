import { request, type APIRequestContext, type APIResponse } from "@playwright/test";
import type {
  Attachment,
  CommentThread,
  Graph,
  ImportJob,
  Invite,
  InviteRole,
  Me,
  PageDetail,
  PageRef,
  PagePermissions,
  PageRole,
  PageSummary,
  SearchResult,
  ShareLink,
  Visibility,
  WorkspaceMembership,
} from "@hostidian/api-types";
import { BASE_URL } from "./env";

/**
 * A thin, typed wrapper around the public REST API for test setup/teardown and for asserting server state.
 * Every call sends the `Origin` header the API's CSRF check requires, and the instance keeps the session
 * cookie, so one `Api` is one logged-in user. Anything a test wants to prove about the *UI* still goes
 * through the browser; this is only for arranging state and reading it back.
 */
export class Api {
  private constructor(
    readonly ctx: APIRequestContext,
    readonly baseUrl: string,
  ) {}

  static async create(options: { storageState?: string; baseUrl?: string } = {}): Promise<Api> {
    const baseUrl = options.baseUrl ?? BASE_URL;
    const ctx = await request.newContext({
      baseURL: baseUrl,
      storageState: options.storageState,
      extraHTTPHeaders: { Origin: baseUrl },
    });
    return new Api(ctx, baseUrl);
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose();
  }

  /** Cookies of this user, in Playwright's `storageState` shape (for `browser.newContext({ storageState })`). */
  storageState() {
    return this.ctx.storageState();
  }

  // -------------------------------------------------------------------------------- plumbing

  private async json<T>(response: APIResponse, ok: number[] = [200, 201]): Promise<T> {
    if (!ok.includes(response.status())) {
      throw new Error(`${response.url()} -> ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async noContent(response: APIResponse, ok: number[] = [200, 204]): Promise<void> {
    if (!ok.includes(response.status())) {
      throw new Error(`${response.url()} -> ${response.status()} ${await response.text()}`);
    }
  }

  // -------------------------------------------------------------------------------- instance + auth

  async needsSetup(): Promise<boolean> {
    const info = await this.json<{ needsSetup: boolean }>(await this.ctx.get("/api/instance/info"));
    return info.needsSetup;
  }

  async setup(input: { name: string; email: string; password: string; workspaceName?: string }): Promise<Me> {
    return this.json<Me>(await this.ctx.post("/api/setup", { data: input }));
  }

  async login(email: string, password: string): Promise<Me> {
    return this.json<Me>(await this.ctx.post("/api/auth/login", { data: { email, password } }));
  }

  async register(input: { name: string; email: string; password: string; inviteToken?: string }): Promise<Me> {
    return this.json<Me>(await this.ctx.post("/api/auth/register", { data: input }));
  }

  async me(): Promise<Me> {
    return this.json<Me>(await this.ctx.get("/api/auth/me"));
  }

  // -------------------------------------------------------------------------------- workspaces

  async createWorkspace(name: string): Promise<WorkspaceMembership> {
    return this.json<WorkspaceMembership>(await this.ctx.post("/api/workspaces", { data: { name } }));
  }

  async createInvite(workspaceId: string, role: InviteRole, email?: string): Promise<Invite> {
    return this.json<Invite>(await this.ctx.post(`/api/workspaces/${workspaceId}/invites`, { data: { role, email } }));
  }

  // -------------------------------------------------------------------------------- pages

  async createPage(
    workspaceId: string,
    input: { id?: string; title?: string; parentId?: string | null; visibility?: Visibility } = {},
  ): Promise<PageSummary> {
    return this.json<PageSummary>(await this.ctx.post(`/api/workspaces/${workspaceId}/pages`, { data: input }));
  }

  async getPage(pageId: string): Promise<PageDetail> {
    return this.json<PageDetail>(await this.ctx.get(`/api/pages/${pageId}`));
  }

  async renamePage(pageId: string, title: string): Promise<PageSummary> {
    return this.json<PageSummary>(await this.ctx.patch(`/api/pages/${pageId}`, { data: { title } }));
  }

  async listPages(workspaceId: string): Promise<PageSummary[]> {
    return this.json<PageSummary[]>(await this.ctx.get(`/api/workspaces/${workspaceId}/pages`));
  }

  /** The server's last extracted copy of a page (Markdown + BlockNote blocks); lags the live document by a few seconds. */
  async pageContent(pageId: string): Promise<{ markdown: string; blocks: unknown[]; updatedAt: string }> {
    return this.json(await this.ctx.get(`/api/pages/${pageId}/content`));
  }

  async grant(pageId: string, input: { userId?: string; email?: string; role: PageRole }): Promise<PagePermissions> {
    return this.json<PagePermissions>(await this.ctx.post(`/api/pages/${pageId}/permissions`, { data: input }));
  }

  async backlinks(pageId: string): Promise<PageRef[]> {
    return this.json<PageRef[]>(await this.ctx.get(`/api/pages/${pageId}/backlinks`));
  }

  async graph(workspaceId: string): Promise<Graph> {
    return this.json<Graph>(await this.ctx.get(`/api/workspaces/${workspaceId}/graph`));
  }

  async search(workspaceId: string, q: string, mode: "full" | "title" = "full"): Promise<SearchResult[]> {
    return this.json<SearchResult[]>(
      await this.ctx.get(`/api/workspaces/${workspaceId}/search`, { params: { q, mode } }),
    );
  }

  // -------------------------------------------------------------------------------- files

  async uploadFile(workspaceId: string, pageId: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<Attachment> {
    return this.json<Attachment>(
      await this.ctx.post(`/api/workspaces/${workspaceId}/files`, {
        multipart: { file, pageId },
      }),
    );
  }

  // -------------------------------------------------------------------------------- comments

  async comments(pageId: string, includeResolved = true): Promise<CommentThread[]> {
    return this.json<CommentThread[]>(
      await this.ctx.get(`/api/pages/${pageId}/comments`, { params: { includeResolved: String(includeResolved) } }),
    );
  }

  // -------------------------------------------------------------------------------- shares

  async createShare(pageId: string, includeSubpages = false): Promise<ShareLink> {
    return this.json<ShareLink>(await this.ctx.post(`/api/pages/${pageId}/shares`, { data: { includeSubpages } }));
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.noContent(await this.ctx.delete(`/api/shares/${shareId}`));
  }

  // -------------------------------------------------------------------------------- import / export

  async exportWorkspace(workspaceId: string): Promise<Buffer> {
    const response = await this.ctx.get(`/api/workspaces/${workspaceId}/export`);
    if (response.status() !== 200) throw new Error(`export -> ${response.status()}`);
    return Buffer.from(await response.body());
  }

  async importZip(workspaceId: string, zip: Buffer, name = "vault.zip", parentId?: string): Promise<ImportJob> {
    return this.json<ImportJob>(
      await this.ctx.post(`/api/workspaces/${workspaceId}/import`, {
        multipart: { file: { name, mimeType: "application/zip", buffer: zip }, ...(parentId ? { parentId } : {}) },
      }),
      [202],
    );
  }

  async importJob(jobId: string): Promise<ImportJob> {
    return this.json<ImportJob>(await this.ctx.get(`/api/import-jobs/${jobId}`));
  }

  /** Import a vault zip and wait for the job to finish (polling, with a deadline). */
  async importAndWait(workspaceId: string, zip: Buffer, parentId?: string, timeoutMs = 60_000): Promise<ImportJob> {
    let job = await this.importZip(workspaceId, zip, "vault.zip", parentId);
    const deadline = Date.now() + timeoutMs;
    while (job.status === "pending" || job.status === "running") {
      if (Date.now() > deadline) throw new Error(`import job ${job.id} still ${job.status} after ${timeoutMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = await this.importJob(job.id);
    }
    if (job.status === "failed") throw new Error(`import job ${job.id} failed: ${job.error ?? "unknown"}`);
    return job;
  }
}

/** An anonymous API client (no cookies): what the public share endpoints and a logged-out visitor get. */
export function anonymousApi(): Promise<Api> {
  return Api.create();
}
