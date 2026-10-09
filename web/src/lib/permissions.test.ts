import { describe, expect, it } from "vitest";
import {
  assignableWorkspaceRoles,
  canArchive,
  canChangeVisibility,
  canComment,
  canCreateTopLevelPage,
  canDeleteWorkspace,
  canEdit,
  canInviteMembers,
  canManageWorkspace,
  canModifyMember,
  canShare,
  canView,
  maxRole,
  roleAtLeast,
} from "./permissions";

describe("page roles (conventions §3: none < view < comment < edit < full)", () => {
  it("orders roles", () => {
    expect(roleAtLeast("edit", "comment")).toBe(true);
    expect(roleAtLeast("comment", "edit")).toBe(false);
    expect(roleAtLeast("full", "full")).toBe(true);
    expect(roleAtLeast(null, "view")).toBe(false);
    expect(roleAtLeast(undefined, "view")).toBe(false);
    expect(roleAtLeast("none", "view")).toBe(false);
  });

  it.each([
    ["none", [false, false, false, false]],
    ["view", [true, false, false, false]],
    ["comment", [true, true, false, false]],
    ["edit", [true, true, true, false]],
    ["full", [true, true, true, true]],
  ] as const)("%s -> view/comment/edit/share", (role, [view, comment, edit, share]) => {
    expect(canView(role)).toBe(view);
    expect(canComment(role)).toBe(comment);
    expect(canEdit(role)).toBe(edit);
    expect(canShare(role)).toBe(share);
    expect(canArchive(role)).toBe(share);
  });

  it("only full access on a root page may change visibility", () => {
    expect(canChangeVisibility("full", true)).toBe(true);
    expect(canChangeVisibility("full", false)).toBe(false);
    expect(canChangeVisibility("edit", true)).toBe(false);
  });

  it("maxRole picks the higher role", () => {
    expect(maxRole("view", "edit")).toBe("edit");
    expect(maxRole("full", "comment")).toBe("full");
    expect(maxRole("none", "none")).toBe("none");
  });
});

describe("workspace roles", () => {
  it("manage / invite / delete", () => {
    expect(canManageWorkspace("owner")).toBe(true);
    expect(canManageWorkspace("admin")).toBe(true);
    expect(canManageWorkspace("member")).toBe(false);
    expect(canManageWorkspace("guest")).toBe(false);
    expect(canInviteMembers("admin")).toBe(true);
    expect(canDeleteWorkspace("owner")).toBe(true);
    expect(canDeleteWorkspace("admin")).toBe(false);
  });

  it("guests cannot create top-level pages", () => {
    expect(canCreateTopLevelPage("member")).toBe(true);
    expect(canCreateTopLevelPage("guest")).toBe(false);
    expect(canCreateTopLevelPage(null)).toBe(false);
  });

  it("only owners grant or revoke the owner role", () => {
    expect(assignableWorkspaceRoles("owner")).toEqual(["owner", "admin", "member", "guest"]);
    expect(assignableWorkspaceRoles("admin")).toEqual(["admin", "member", "guest"]);
    expect(assignableWorkspaceRoles("member")).toEqual([]);
  });

  it("admins cannot modify owners", () => {
    expect(canModifyMember("owner", "owner")).toBe(true);
    expect(canModifyMember("admin", "owner")).toBe(false);
    expect(canModifyMember("admin", "member")).toBe(true);
    expect(canModifyMember("member", "guest")).toBe(false);
  });
});
