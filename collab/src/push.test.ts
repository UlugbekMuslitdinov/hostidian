import { describe, expect, it, vi } from "vitest";
import { ContentPusher, PushError, type ContentPayload } from "./push";
import { INTERNAL_TOKEN, PAGE_ID, recordingLogger, silentLogger } from "./test-utils";

const payload: ContentPayload = {
  markdown: "# Hi",
  plaintext: "Hi",
  blocks: [{ type: "heading" }],
  linkTargets: [],
  editorIds: ["0190a5b2-7c3e-7a11-8f44-1234567890aa"],
};

const fastRetry = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 };

function pusherWith(fetchImpl: typeof fetch, retry = fastRetry) {
  return new ContentPusher({
    apiInternalUrl: "http://api.test:8081",
    internalToken: INTERNAL_TOKEN,
    logger: silentLogger,
    fetch: fetchImpl,
    retry,
  });
}

const respond = (status: number, body = "") => new Response(body || null, { status });

describe("ContentPusher", () => {
  it("PUTs the payload with the bearer token", async () => {
    const fetchMock = vi.fn(async () => respond(204));
    await expect(pusherWith(fetchMock as never).push(PAGE_ID, payload)).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test:8081/internal/pages/${PAGE_ID}/content`);
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("reports 404 as not_found without retrying", async () => {
    const fetchMock = vi.fn(async () => respond(404, '{"error":{"code":"not_found","message":"x"}}'));
    await expect(pusherWith(fetchMock as never).push(PAGE_ID, payload)).resolves.toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries server errors, rate limiting and network failures, then succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(respond(503))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(respond(429))
      .mockResolvedValueOnce(respond(204));
    await expect(pusherWith(fetchMock).push(PAGE_ID, payload)).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("gives up after the configured attempts", async () => {
    const fetchMock = vi.fn(async () => respond(500, "boom"));
    const result = pusherWith(fetchMock as never).push(PAGE_ID, payload);
    await expect(result).rejects.toBeInstanceOf(PushError);
    await expect(result).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403, 422])("does not retry a %s", async (status) => {
    const fetchMock = vi.fn(async () => respond(status));
    await expect(pusherWith(fetchMock as never).push(PAGE_ID, payload)).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once a newer version is waiting", async () => {
    let stale = false;
    const fetchMock = vi.fn(async () => {
      stale = true;
      return respond(500);
    });
    await expect(pusherWith(fetchMock as never).push(PAGE_ID, payload, () => stale)).rejects.toBeInstanceOf(PushError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after close() (shutdown)", async () => {
    const fetchMock = vi.fn(async () => respond(500));
    const pusher = pusherWith(fetchMock as never);
    pusher.close();
    await expect(pusher.push(PAGE_ID, payload)).rejects.toBeInstanceOf(PushError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honours per-call retry overrides", async () => {
    const fetchMock = vi.fn(async () => respond(500));
    const pusher = pusherWith(fetchMock as never, { attempts: 10, baseDelayMs: 1, maxDelayMs: 1 });
    await expect(pusher.push(PAGE_ID, payload, () => false, { attempts: 2 })).rejects.toBeInstanceOf(PushError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never logs the token or the content", async () => {
    const { logger, lines } = recordingLogger();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(respond(500)).mockResolvedValueOnce(respond(204));
    const pusher = new ContentPusher({
      apiInternalUrl: "http://api.test:8081",
      internalToken: INTERNAL_TOKEN,
      logger,
      fetch: fetchMock,
      retry: fastRetry,
    });
    await pusher.push(PAGE_ID, { ...payload, markdown: "SECRET-BODY" });
    expect(lines.some((l) => l.level === "warn")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(INTERNAL_TOKEN);
    expect(JSON.stringify(lines)).not.toContain("SECRET-BODY");
  });
});
