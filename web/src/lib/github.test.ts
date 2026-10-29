import { describe, expect, it } from "vitest";
import type { GithubIssueRef } from "@hostidian/api-types";
import { buildIssueIndex, hasMultipleRepos, issueLabel, repoName, scoreIssueRef } from "./github";

const ref = (number: number, repository = "acme/site"): GithubIssueRef => ({
  pageId: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
  number,
  repository,
  state: "open",
  url: `https://github.com/${repository}/issues/${number}`,
});

describe("issueLabel", () => {
  it("shows #N, or repo#N when several repositories are synced", () => {
    expect(issueLabel(ref(123))).toBe("#123");
    expect(issueLabel(ref(123), true)).toBe("site#123");
    expect(repoName("acme/site")).toBe("site");
    expect(repoName("site")).toBe("site");
  });

  it("detects several repositories regardless of case", () => {
    expect(hasMultipleRepos([ref(1), ref(2)])).toBe(false);
    expect(hasMultipleRepos([ref(1, "acme/Site"), ref(2, "ACME/site")])).toBe(false);
    expect(hasMultipleRepos([ref(1), ref(2, "acme/api")])).toBe(true);
  });
});

describe("scoreIssueRef", () => {
  it("ranks the exact number above a number prefix", () => {
    expect(scoreIssueRef(ref(12), "#12")).toBeGreaterThan(scoreIssueRef(ref(123), "#12"));
    expect(scoreIssueRef(ref(123), "#12")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(7), "#12")).toBe(0);
  });

  it("beats any title match for an exact number", () => {
    // 100 is the best possible title score (exact title).
    expect(scoreIssueRef(ref(12), "#12")).toBeGreaterThan(100);
  });

  it("accepts spaces and a repository prefix", () => {
    expect(scoreIssueRef(ref(12), "# 12")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(12), "site#12")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(12), "SI#12")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(12), "api#12")).toBe(0);
    expect(scoreIssueRef(ref(12, "acme/api"), "site#12")).toBe(0);
  });

  it("lists every issue for a lone #", () => {
    expect(scoreIssueRef(ref(5), "#")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(5, "acme/api"), "site#")).toBe(0);
  });

  it("matches bare digits only on the exact number", () => {
    expect(scoreIssueRef(ref(12), "12")).toBeGreaterThan(0);
    expect(scoreIssueRef(ref(123), "12")).toBe(0);
    expect(scoreIssueRef(ref(2026), "20")).toBe(0);
  });

  it("ignores ordinary text", () => {
    expect(scoreIssueRef(ref(12), "roadmap")).toBe(0);
    expect(scoreIssueRef(ref(12), "")).toBe(0);
    expect(scoreIssueRef(ref(12), "a#b")).toBe(0);
  });
});

describe("buildIssueIndex", () => {
  it("keys by lower-case page id", () => {
    const r = { ...ref(1), pageId: "ABCDEF00-0000-4000-8000-000000000001" };
    expect(buildIssueIndex([r]).get("abcdef00-0000-4000-8000-000000000001")).toBe(r);
    expect(buildIssueIndex(undefined).size).toBe(0);
  });
});
