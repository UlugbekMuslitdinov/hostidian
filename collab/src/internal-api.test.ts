import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentNameFor } from "./auth";
import type { ConnectionRegistry } from "./connections";
import type { ImportRequest } from "./import-markdown";
import { createInternalServer, safeEqual } from "./internal-api";
import { INTERNAL_TOKEN, OTHER_PAGE_ID, OTHER_USER_ID, PAGE_ID, USER_ID, recordingLogger } from "./test-utils";

describe("safeEqual", () => {
  it("compares strings of any length", () => {
    expect(safeEqual("secret", "secret")).toBe(true);
    expect(safeEqual("secret", "secreT")).toBe(false);
    expect(safeEqual("secret", "secret2")).toBe(false);
    expect(safeEqual("", "secret")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

function connection(userId: string) {
  return { context: { user: { id: userId, name: "n", color: "#fff", role: "edit" } }, close: vi.fn() };
}

let server: Server;
let baseUrl: string;
let importMarkdown: ReturnType<typeof vi.fn<(request: ImportRequest) => Promise<"imported" | "page_gone">>>;
let a1: ReturnType<typeof connection>;
let a2: ReturnType<typeof connection>;
let b1: ReturnType<typeof connection>;
let lines: ReturnType<typeof recordingLogger>["lines"];

beforeEach(async () => {
  a1 = connection(USER_ID);
  a2 = connection(OTHER_USER_ID);
  b1 = connection(USER_ID);
  const documents: ConnectionRegistry["documents"] = new Map([
    [documentNameFor(PAGE_ID), { connections: new Map<typeof a1, unknown>([[a1, {}], [a2, {}]]) }],
    [documentNameFor(OTHER_PAGE_ID), { connections: new Map<typeof a1, unknown>([[b1, {}]]) }],
  ]);
  importMarkdown = vi.fn(async () => "imported");
  const rec = recordingLogger();
  lines = rec.lines;
  server = createInternalServer({ token: INTERNAL_TOKEN, registry: { documents }, importMarkdown, logger: rec.logger });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const auth = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("health", () => {
  it("needs no authentication", async () => {
    const res = await fetch(`${baseUrl}/internal/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("only allows GET", async () => {
    const res = await post("/internal/health", {});
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("bearer authentication", () => {
  it.each(["/internal/disconnect", "/internal/import-markdown"])("%s rejects missing and wrong tokens", async (path) => {
    const body = { pageId: PAGE_ID, markdown: "x" };
    for (const headers of [
      {} as Record<string, string>,
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${INTERNAL_TOKEN}x` },
      { authorization: INTERNAL_TOKEN },
      { authorization: `Basic ${INTERNAL_TOKEN}` },
      { authorization: "Bearer " },
    ]) {
      const res = await post(path, body, headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Missing or invalid bearer token." } });
    }
    expect(importMarkdown).not.toHaveBeenCalled();
    expect(a1.close).not.toHaveBeenCalled();
  });

  it("authenticates before looking at the method or body", async () => {
    const res = await fetch(`${baseUrl}/internal/disconnect`, { method: "GET" });
    expect(res.status).toBe(401);
    const bad = await post("/internal/disconnect", "{not json", {});
    expect(bad.status).toBe(401);
  });

  it("accepts the right token, case-insensitive scheme", async () => {
    const res = await post("/internal/disconnect", { pageId: PAGE_ID }, { authorization: `bearer ${INTERNAL_TOKEN}` });
    expect(res.status).toBe(200);
  });

  it("never logs the token", async () => {
    await post("/internal/disconnect", { pageId: PAGE_ID });
    await post("/internal/disconnect", { pageId: PAGE_ID }, { authorization: "Bearer nope" });
    expect(JSON.stringify(lines)).not.toContain(INTERNAL_TOKEN);
  });
});

describe("POST /internal/disconnect", () => {
  it("closes the connections of a page and reports how many", async () => {
    const res = await post("/internal/disconnect", { pageId: PAGE_ID, reason: "page_archived" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ closed: 2 });
    expect(a1.close).toHaveBeenCalledWith({ code: 4205, reason: "page_archived" });
    expect(a2.close).toHaveBeenCalled();
    expect(b1.close).not.toHaveBeenCalled();
  });

  it("closes a user's connections everywhere, with the default reason", async () => {
    const res = await post("/internal/disconnect", { userId: USER_ID });
    expect(await res.json()).toEqual({ closed: 2 });
    expect(a1.close).toHaveBeenCalledWith({ code: 4205, reason: "permissions_changed" });
    expect(b1.close).toHaveBeenCalled();
    expect(a2.close).not.toHaveBeenCalled();
  });

  it("intersects pageId and userId; no match is closed:0", async () => {
    expect(await (await post("/internal/disconnect", { pageId: OTHER_PAGE_ID, userId: USER_ID })).json()).toEqual({ closed: 1 });
    expect(await (await post("/internal/disconnect", { pageId: OTHER_PAGE_ID, userId: OTHER_USER_ID })).json()).toEqual({ closed: 0 });
  });

  it.each([
    [{}, "pageId"],
    [{ reason: "x" }, "pageId"],
    [{ pageId: "nope" }, "pageId"],
    [{ userId: 42 }, "userId"],
    [{ pageId: PAGE_ID, reason: "" }, "reason"],
    [{ pageId: PAGE_ID, reason: "x".repeat(101) }, "reason"],
  ])("rejects invalid input %j with 422", async (body, field) => {
    const res = await post("/internal/disconnect", body);
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string; details: Record<string, string> } };
    expect(json.error.code).toBe("validation_failed");
    expect(json.error.details).toHaveProperty(field);
    expect(a1.close).not.toHaveBeenCalled();
  });

  it.each(["{broken", "[]", "null", '"text"'])("rejects malformed JSON body %s with 400", async (body) => {
    const res = await post("/internal/disconnect", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });

  it("rejects oversized bodies with 413", async () => {
    const res = await post("/internal/disconnect", { pageId: PAGE_ID, reason: "x", filler: "y".repeat(20_000) });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
  });
});

describe("POST /internal/import-markdown", () => {
  it("imports and answers 204", async () => {
    const res = await post("/internal/import-markdown", { pageId: PAGE_ID.toUpperCase(), markdown: "# Hi", editorId: USER_ID });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(importMarkdown).toHaveBeenCalledExactlyOnceWith({ pageId: PAGE_ID, markdown: "# Hi", editorId: USER_ID });
  });

  it("accepts empty markdown and a missing editor", async () => {
    expect((await post("/internal/import-markdown", { pageId: PAGE_ID, markdown: "" })).status).toBe(204);
    expect(importMarkdown).toHaveBeenCalledWith({ pageId: PAGE_ID, markdown: "" });
  });

  it.each([
    [{ markdown: "x" }, "pageId"],
    [{ pageId: "nope", markdown: "x" }, "pageId"],
    [{ pageId: PAGE_ID }, "markdown"],
    [{ pageId: PAGE_ID, markdown: 5 }, "markdown"],
    [{ pageId: PAGE_ID, markdown: "x", editorId: "nope" }, "editorId"],
  ])("rejects invalid input %j with 422", async (body, field) => {
    const res = await post("/internal/import-markdown", body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { details: Record<string, string> } }).error.details).toHaveProperty(field);
    expect(importMarkdown).not.toHaveBeenCalled();
  });

  it("answers 404 when the page does not exist", async () => {
    importMarkdown.mockResolvedValueOnce("page_gone");
    const res = await post("/internal/import-markdown", { pageId: PAGE_ID, markdown: "x" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("answers a generic 500 without leaking the cause", async () => {
    importMarkdown.mockRejectedValueOnce(new Error("password=hunter2 refused by 10.0.0.5"));
    const res = await post("/internal/import-markdown", { pageId: PAGE_ID, markdown: "x" });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal error." } });
    expect(JSON.stringify(lines)).toContain("hunter2"); // ...but it is logged for operators
  });

  it("accepts large documents", async () => {
    const markdown = "word ".repeat(400_000);
    expect((await post("/internal/import-markdown", { pageId: PAGE_ID, markdown })).status).toBe(204);
  });
});

describe("routing", () => {
  it("404s unknown paths and 405s wrong methods (after authentication)", async () => {
    expect((await fetch(`${baseUrl}/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${baseUrl}/internal/other`, { headers: auth })).status).toBe(404);
    const wrong = await fetch(`${baseUrl}/internal/disconnect`, { headers: auth });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
  });

  it("ignores query strings", async () => {
    expect((await fetch(`${baseUrl}/internal/health?x=1`)).status).toBe(200);
  });
});
