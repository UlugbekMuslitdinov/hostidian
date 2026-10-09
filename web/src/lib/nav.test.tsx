import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigation } from "@/test/navigation-mock";
import { AppLink, isShallowNavigation, parseRoute } from "./nav";

describe("parseRoute", () => {
  it("recognises the workspace views", () => {
    expect(parseRoute("/w/acme")).toEqual({ kind: "home", slug: "acme" });
    expect(parseRoute("/w/acme/")).toEqual({ kind: "home", slug: "acme" });
    expect(parseRoute("/w/acme/trash")).toEqual({ kind: "trash", slug: "acme" });
    expect(parseRoute("/w/acme/p/0199-abc")).toEqual({ kind: "page", slug: "acme", pageId: "0199-abc" });
    expect(parseRoute("/w/acme/p/0199-abc?x=1#h")).toEqual({ kind: "page", slug: "acme", pageId: "0199-abc" });
  });

  it("treats everything else as 'other'", () => {
    for (const p of [
      "/",
      "/settings",
      "/settings/workspace",
      "/admin/users",
      "/login",
      "/w",
      "/w/acme/p",
      "/w/acme/other",
      "/s/token",
    ]) {
      expect(parseRoute(p).kind).toBe("other");
    }
  });

  it("decodes encoded segments", () => {
    expect(parseRoute("/w/caf%C3%A9")).toEqual({ kind: "home", slug: "café" });
  });
});

describe("isShallowNavigation", () => {
  it("is true only between workspace views", () => {
    expect(isShallowNavigation("/w/acme", "/w/acme/p/1")).toBe(true);
    expect(isShallowNavigation("/w/acme/p/1", "/w/acme/trash")).toBe(true);
    expect(isShallowNavigation("/w/acme/p/1", "/w/other")).toBe(true);
    expect(isShallowNavigation("/settings", "/w/acme")).toBe(false);
    expect(isShallowNavigation("/w/acme", "/settings")).toBe(false);
    expect(isShallowNavigation("/", "/w/acme")).toBe(false);
  });
});

describe("AppLink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("uses the history API (no server round trip) between workspace views", () => {
    window.history.replaceState(null, "", "/w/acme");
    const push = vi.spyOn(window.history, "pushState");
    render(<AppLink href="/w/acme/p/abc">Open</AppLink>);
    fireEvent.click(screen.getByRole("link", { name: "Open" }));
    expect(push).toHaveBeenCalledWith(null, "", "/w/acme/p/abc");
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("falls back to the router for other destinations", () => {
    window.history.replaceState(null, "", "/w/acme");
    render(<AppLink href="/settings">Settings</AppLink>);
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(navigation.push).toHaveBeenCalledWith("/settings");
  });

  it("leaves modified clicks to the browser (open in new tab)", () => {
    window.history.replaceState(null, "", "/w/acme");
    const push = vi.spyOn(window.history, "pushState");
    render(<AppLink href="/w/acme/trash">Trash</AppLink>);
    // Record whether our handler cancelled the click, then cancel it ourselves so jsdom doesn't "navigate".
    let prevented: boolean | undefined;
    const spy = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    };
    window.addEventListener("click", spy);
    fireEvent.click(screen.getByRole("link", { name: "Trash" }), { metaKey: true });
    window.removeEventListener("click", spy);
    expect(prevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("supports replace", () => {
    window.history.replaceState(null, "", "/w/acme");
    const replace = vi.spyOn(window.history, "replaceState");
    render(
      <AppLink href="/w/acme/trash" replace>
        Trash
      </AppLink>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Trash" }));
    expect(replace).toHaveBeenCalledWith(null, "", "/w/acme/trash");
  });
});
