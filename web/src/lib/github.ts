import type { GithubIssueRef } from "@hostidian/api-types";

/**
 * Anchor of the comment thread that mirrors a synced issue's discussion. It is not a BlockNote block id, so the
 * comments UI must treat it as page-level instead of "detached" (backend: githubsync.ThreadBlockID).
 */
export const GITHUB_THREAD_BLOCK_ID = "github:issue";

export type IssueIndex = ReadonlyMap<string, GithubIssueRef>;

/** page id (lower-case) → issue, built from `GET /workspaces/{id}/github-issues`. */
export function buildIssueIndex(refs: readonly GithubIssueRef[] | undefined): IssueIndex {
  return new Map((refs ?? []).map((ref) => [ref.pageId.toLowerCase(), ref] as const));
}

/** "site" for "acme/site". */
export function repoName(repository: string): string {
  const slash = repository.lastIndexOf("/");
  return slash >= 0 ? repository.slice(slash + 1) : repository;
}

/** "#123", or "site#123" when the workspace syncs more than one repository. */
export function issueLabel(ref: Pick<GithubIssueRef, "number" | "repository">, withRepo = false): string {
  return `${withRepo ? repoName(ref.repository) : ""}#${ref.number}`;
}

/** True when issues of more than one repository exist, so bare numbers would be ambiguous. */
export function hasMultipleRepos(refs: Iterable<Pick<GithubIssueRef, "repository">>): boolean {
  const seen = new Set<string>();
  for (const ref of refs) {
    seen.add(ref.repository.toLowerCase());
    if (seen.size > 1) return true;
  }
  return false;
}

// "#12", "# 12", "site#12", "#" — the repository part is optional.
const REF_QUERY = /^\s*(?:([\w.-]+)\s*)?#\s*(\d*)\s*$/;

/**
 * How well an issue matches a picker query like `#12` or `site#12`; 0 = no match. An exact number outranks every
 * title match (100), a number prefix (`#1` → #1, #10, #123) comes next, and a lone `#` lists issues.
 * Plain digits (`12`) only match the exact number, so typing a year doesn't flood the picker.
 */
export function scoreIssueRef(ref: Pick<GithubIssueRef, "number" | "repository">, query: string): number {
  const q = query.trim();
  const number = String(ref.number);
  const m = REF_QUERY.exec(q);
  if (m) {
    const [, repo, digits = ""] = m;
    if (repo && !repoName(ref.repository).toLowerCase().startsWith(repo.toLowerCase())) return 0;
    if (digits === "") return 15;
    if (number === digits) return 120;
    return number.startsWith(digits) ? 70 : 0;
  }
  return /^\d+$/.test(q) && number === q ? 60 : 0;
}
