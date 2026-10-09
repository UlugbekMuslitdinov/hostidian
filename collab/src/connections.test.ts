import { describe, expect, it, vi } from "vitest";
import { documentNameFor } from "./auth";
import { closeMatchingConnections, type ConnectionRegistry } from "./connections";
import { OTHER_PAGE_ID, OTHER_USER_ID, PAGE_ID, USER_ID } from "./test-utils";

function fakeConnection(userId: string | undefined) {
  return {
    context: userId ? { user: { id: userId, name: "n", color: "#fff", role: "edit" } } : {},
    close: vi.fn(),
    webSocket: { close: vi.fn() },
  };
}

function registry() {
  const a1 = fakeConnection(USER_ID);
  const a2 = fakeConnection(OTHER_USER_ID);
  const a3 = fakeConnection(USER_ID); // same user, second tab
  const b1 = fakeConnection(USER_ID);
  const b2 = fakeConnection(undefined);
  const documents: ConnectionRegistry["documents"] = new Map([
    [documentNameFor(PAGE_ID), { connections: new Map<(typeof a1), unknown>([[a1, {}], [a2, {}], [a3, {}]]) }],
    [documentNameFor(OTHER_PAGE_ID), { connections: new Map<(typeof a1), unknown>([[b1, {}], [b2, {}]]) }],
  ]);
  return { registry: { documents }, a1, a2, a3, b1, b2 };
}

const closedOf = (...connections: Array<ReturnType<typeof fakeConnection>>) =>
  connections.filter((c) => c.close.mock.calls.length > 0);

describe("closeMatchingConnections", () => {
  it("closes every connection of a page", () => {
    const r = registry();
    expect(closeMatchingConnections(r.registry, { pageId: PAGE_ID, reason: "page_archived" })).toBe(3);
    expect(closedOf(r.a1, r.a2, r.a3, r.b1, r.b2)).toEqual([r.a1, r.a2, r.a3]);
    expect(r.a1.close).toHaveBeenCalledWith({ code: 4205, reason: "page_archived" });
    // ...and the socket is closed too, so the provider reconnects and asks for a new token
    expect(r.a1.webSocket.close).toHaveBeenCalledWith(4205, "page_archived");
    expect(r.b1.webSocket.close).not.toHaveBeenCalled();
  });

  it("closes every connection of a user across all pages", () => {
    const r = registry();
    expect(closeMatchingConnections(r.registry, { userId: USER_ID, reason: "user_disabled" })).toBe(3);
    expect(closedOf(r.a1, r.a2, r.a3, r.b1, r.b2)).toEqual([r.a1, r.a3, r.b1]);
  });

  it("intersects page and user", () => {
    const r = registry();
    expect(closeMatchingConnections(r.registry, { pageId: PAGE_ID, userId: USER_ID, reason: "permissions_changed" })).toBe(2);
    expect(closedOf(r.a1, r.a2, r.a3, r.b1, r.b2)).toEqual([r.a1, r.a3]);
  });

  it("matches user ids case-insensitively and counts nothing when nothing matches", () => {
    const r = registry();
    expect(closeMatchingConnections(r.registry, { userId: USER_ID.toUpperCase(), reason: "x" })).toBe(3);
    const r2 = registry();
    expect(closeMatchingConnections(r2.registry, { pageId: "0190a5b2-7c3e-7a11-8f44-ffffffffffff", reason: "x" })).toBe(0);
    expect(closeMatchingConnections(r2.registry, { userId: "0190a5b2-7c3e-7a11-8f44-ffffffffffff", reason: "x" })).toBe(0);
    expect(closedOf(r2.a1, r2.a2, r2.a3, r2.b1, r2.b2)).toEqual([]);
  });

  it("still counts connections whose socket is already gone", () => {
    const r = registry();
    r.a1.webSocket.close.mockImplementation(() => {
      throw new Error("socket already closed");
    });
    expect(closeMatchingConnections(r.registry, { pageId: PAGE_ID, reason: "x" })).toBe(3);
    expect(r.a2.webSocket.close).toHaveBeenCalled();
  });

  it("copes with connections that unregister themselves while being closed", () => {
    const connections = new Map<{ context: unknown; close(): void }, unknown>();
    const make = () => {
      const c = { context: {}, close: () => void connections.delete(c) };
      connections.set(c, {});
      return c;
    };
    make();
    make();
    make();
    const documents: ConnectionRegistry["documents"] = new Map([[documentNameFor(PAGE_ID), { connections }]]);
    expect(closeMatchingConnections({ documents }, { pageId: PAGE_ID, reason: "x" })).toBe(3);
    expect(connections.size).toBe(0);
  });
});
