import { describe, expect, it } from "vitest";
import { ApiError, errorMessage, hasStatus, isNetworkError, isTransientError } from "./error";
import { unwrap, unwrapVoid } from "./unwrap";

const ok = (status = 200) => new Response(null, { status });

describe("unwrap", () => {
  it("returns data for successful responses", async () => {
    await expect(unwrap(Promise.resolve({ data: { id: 1 }, response: ok() }))).resolves.toEqual({ id: 1 });
  });

  it("throws an ApiError carrying the error envelope", async () => {
    const response = new Response(null, { status: 422 });
    const error = {
      error: { code: "validation_failed", message: "Title too long", details: { title: "max 500" } },
    };
    const caught = await unwrap(Promise.resolve({ error, response })).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "Title too long",
      details: { title: "max 500" },
    });
  });

  it("tolerates non-envelope error bodies (proxy HTML, plain text)", async () => {
    const caught = await unwrap(
      Promise.resolve({ error: "<html>Bad gateway</html>", response: new Response(null, { status: 502 }) }),
    ).catch((e: unknown) => e);
    expect(caught).toMatchObject({ status: 502, code: "internal" });
    expect(isTransientError(caught)).toBe(true);
  });

  it("maps fetch failures to a network ApiError", async () => {
    const caught = await unwrap(Promise.reject(new TypeError("Failed to fetch"))).catch((e: unknown) => e);
    expect(isNetworkError(caught)).toBe(true);
    expect(caught).toMatchObject({ status: 0, code: "network" });
    expect(errorMessage(caught)).toMatch(/can't reach the server/i);
  });

  it("keeps aborts recognisable", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(unwrap(Promise.reject(abort))).rejects.toBe(abort);
  });

  it("unwrapVoid accepts empty 204 responses", async () => {
    await expect(unwrapVoid(Promise.resolve({ response: ok(204) }))).resolves.toBeUndefined();
    await expect(
      unwrapVoid(
        Promise.resolve({
          error: { error: { code: "forbidden", message: "no" } },
          response: new Response(null, { status: 403 }),
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("ApiError helpers", () => {
  it("hasStatus", () => {
    const e = ApiError.fromResponse(404, { error: { code: "not_found", message: "x" } });
    expect(hasStatus(e, 403, 404)).toBe(true);
    expect(hasStatus(e, 500)).toBe(false);
    expect(hasStatus(new Error("x"), 404)).toBe(false);
  });
  it("4xx errors are not transient", () => {
    expect(isTransientError(ApiError.fromResponse(409, undefined))).toBe(false);
    expect(isTransientError(ApiError.fromResponse(503, undefined))).toBe(true);
  });
});
