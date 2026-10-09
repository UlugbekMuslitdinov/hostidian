import { describe, expect, it, vi } from "vitest";
import {
  attachmentUrl,
  describeUploadError,
  formatBytes,
  uploadAttachment,
  UploadError,
  uploadErrorFromStatus,
  uploadMultipart,
} from "./upload";

/** Just enough of XMLHttpRequest for the code under test; `respond` / `fail` drive the lifecycle. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = "";
  url = "";
  withCredentials = false;
  responseType = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  response: unknown = "";
  responseText = "";
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.response = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const createXhr = () => new FakeXhr() as unknown as XMLHttpRequest;
const file = (name = "pic.png", size = 4) => new File([new Uint8Array(size)], name, { type: "image/png" });

describe("uploadMultipart", () => {
  it("posts multipart with credentials, extra fields first and the file last", async () => {
    const promise = uploadMultipart<{ ok: boolean }>("/api/x", { pageId: "p1", skipped: undefined }, file(), {
      createXhr,
      isOnline: () => true,
    });
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/x");
    expect(xhr.withCredentials).toBe(true);
    expect([...xhr.body!.keys()]).toEqual(["pageId", "file"]);
    expect(xhr.body!.get("pageId")).toBe("p1");
    expect((xhr.body!.get("file") as File).name).toBe("pic.png");
    xhr.respond(201, { ok: true });
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("reports progress and finishes at 100%", async () => {
    const onProgress = vi.fn();
    const promise = uploadMultipart("/api/x", {}, file("a.bin", 100), { createXhr, onProgress, isOnline: () => true });
    const xhr = FakeXhr.last!;
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    xhr.respond(200, {});
    await promise;
    expect(onProgress.mock.calls.map(([p]) => p.fraction)).toEqual([0.25, 0.5, 1]);
  });

  it("fails fast when offline, without touching the network", async () => {
    const created = vi.fn(createXhr);
    await expect(uploadMultipart("/api/x", {}, file(), { createXhr: created, isOnline: () => false })).rejects.toMatchObject(
      { kind: "offline" },
    );
    expect(created).not.toHaveBeenCalled();
  });

  it("rejects empty files before uploading", async () => {
    await expect(uploadMultipart("/api/x", {}, file("e.txt", 0), { createXhr, isOnline: () => true })).rejects.toMatchObject({
      kind: "empty",
    });
  });

  it("maps error statuses to friendly errors, preferring the server message", async () => {
    const run = async (status: number, body: unknown) => {
      const promise = uploadMultipart("/api/x", {}, file(), { createXhr, isOnline: () => true });
      FakeXhr.last!.respond(status, body);
      return promise.catch((e: unknown) => e as UploadError);
    };
    expect(await run(413, { error: { code: "payload_too_large", message: "Max 50 MB." } })).toMatchObject({
      kind: "too_large",
      message: "Max 50 MB.",
      status: 413,
    });
    expect(await run(403, "")).toMatchObject({ kind: "forbidden" });
    expect(await run(401, {})).toMatchObject({ kind: "unauthorized" });
    expect(await run(501, {})).toMatchObject({ kind: "unsupported" });
    expect(await run(502, "<html>bad gateway</html>")).toMatchObject({ kind: "server" });
    expect(await run(418, {})).toMatchObject({ kind: "unknown" });
  });

  it("rejects 2xx responses with an unparseable body", async () => {
    const promise = uploadMultipart("/api/x", {}, file(), { createXhr, isOnline: () => true });
    FakeXhr.last!.respond(201, "not json");
    await expect(promise).rejects.toMatchObject({ kind: "server" });
  });

  it("treats network errors as offline and supports abort signals", async () => {
    const failing = uploadMultipart("/api/x", {}, file(), { createXhr, isOnline: () => true });
    FakeXhr.last!.onerror?.();
    await expect(failing).rejects.toMatchObject({ kind: "offline" });

    const controller = new AbortController();
    const cancelled = uploadMultipart("/api/x", {}, file(), { createXhr, isOnline: () => true, signal: controller.signal });
    controller.abort();
    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(cancelled).rejects.toMatchObject({ kind: "aborted" });

    const already = new AbortController();
    already.abort();
    await expect(
      uploadMultipart("/api/x", {}, file(), { createXhr, isOnline: () => true, signal: already.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("uploadAttachment", () => {
  it("targets the workspace files endpoint with the page id", async () => {
    const promise = uploadAttachment({ workspaceId: "w 1", pageId: "p-1", file: file() }, { createXhr, isOnline: () => true });
    const xhr = FakeXhr.last!;
    expect(xhr.url).toBe("/api/workspaces/w%201/files");
    expect(xhr.body!.get("pageId")).toBe("p-1");
    xhr.respond(201, { id: "f1", url: "/api/files/f1", filename: "pic.png", contentType: "image/png", sizeBytes: 4 });
    await expect(promise).resolves.toMatchObject({ id: "f1" });
  });

  it("omits pageId when the upload isn't tied to a page", async () => {
    const promise = uploadAttachment({ workspaceId: "w", file: file() }, { createXhr, isOnline: () => true });
    expect(FakeXhr.last!.body!.has("pageId")).toBe(false);
    FakeXhr.last!.respond(201, { id: "f2", url: "/api/files/f2" });
    await promise;
  });

  it("rejects a response without an id", async () => {
    const promise = uploadAttachment({ workspaceId: "w", file: file() }, { createXhr, isOnline: () => true });
    FakeXhr.last!.respond(201, { url: "/api/files/x" });
    await expect(promise).rejects.toMatchObject({ kind: "server" });
  });
});

describe("helpers", () => {
  it("attachmentUrl keeps the canonical relative URL and repairs odd ones", () => {
    expect(attachmentUrl({ id: "a", url: "/api/files/a" })).toBe("/api/files/a");
    expect(attachmentUrl({ id: "a", url: "https://evil.example/x" })).toBe("/api/files/a");
    expect(attachmentUrl({ id: "a", url: "" })).toBe("/api/files/a");
  });

  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 820)).toBe("820 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(-1)).toBe("");
  });

  it("describeUploadError", () => {
    expect(describeUploadError(new UploadError("offline", "nope"))).toBe("nope");
    expect(describeUploadError(new Error("boom"))).toBe("boom");
    expect(describeUploadError(null)).toMatch(/failed/);
    expect(uploadErrorFromStatus(404, {}).kind).toBe("not_found");
  });
});
