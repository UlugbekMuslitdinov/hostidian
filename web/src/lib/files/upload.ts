import type { Attachment } from "@hostidian/api-types";

/**
 * Multipart uploads with progress. `fetch` cannot report upload progress, so this uses XMLHttpRequest
 * (injectable for tests). Pure of React and of the app's API client on purpose: it is used for attachments
 * (editor image/file blocks) and for the import zip.
 */

export type UploadErrorKind =
  | "offline"
  | "empty"
  | "too_large"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "unsupported"
  | "server"
  | "aborted"
  | "unknown";

export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  readonly status: number;

  constructor(kind: UploadErrorKind, message: string, status = 0) {
    super(message);
    this.name = "UploadError";
    this.kind = kind;
    this.status = status;
  }
}

export interface UploadProgress {
  loaded: number;
  total: number;
  /** 0..1; 0 while the total is unknown. */
  fraction: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Test seam. */
  createXhr?: () => XMLHttpRequest;
  /** Test seam; defaults to `navigator.onLine`. */
  isOnline?: () => boolean;
}

export type UploadFields = Record<string, string | undefined>;

const defaultIsOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

/** Conventions §1 error envelope → its message, if the body has one. */
function envelopeMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message ? message : undefined;
}

export function uploadErrorFromStatus(status: number, body: unknown): UploadError {
  const server = envelopeMessage(body);
  switch (status) {
    case 401:
      return new UploadError("unauthorized", "Your session has expired. Sign in again to upload files.", status);
    case 403:
      return new UploadError("forbidden", server ?? "You don't have permission to upload files here.", status);
    case 404:
      return new UploadError("not_found", server ?? "The page or workspace no longer exists.", status);
    case 413:
      return new UploadError("too_large", server ?? "That file is too large for this server.", status);
    case 501:
      return new UploadError("unsupported", "File uploads aren't available on this server yet.", status);
    default:
      if (status >= 500) return new UploadError("server", "The server ran into a problem. Please try again.", status);
      return new UploadError("unknown", server ?? `The upload failed (HTTP ${status}).`, status);
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** POST `file` (+ extra text fields) as multipart/form-data to `url` and resolve with the parsed JSON body. */
export function uploadMultipart<T>(url: string, fields: UploadFields, file: File, options: UploadOptions = {}): Promise<T> {
  const isOnline = options.isOnline ?? defaultIsOnline;
  if (file.size === 0) return Promise.reject(new UploadError("empty", `“${file.name}” is empty.`));
  if (!isOnline()) {
    return Promise.reject(new UploadError("offline", "You're offline. Reconnect to upload files."));
  }
  if (options.signal?.aborted) return Promise.reject(new UploadError("aborted", "The upload was cancelled."));

  return new Promise<T>((resolve, reject) => {
    const xhr = (options.createXhr ?? (() => new XMLHttpRequest()))();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, value);
    }
    // The file goes last so servers that stream multipart bodies see the metadata first.
    form.append("file", file, file.name);

    const onAbort = () => xhr.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);

    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.responseType = "text";
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size;
      options.onProgress?.({
        loaded: event.loaded,
        total,
        fraction: total > 0 ? Math.min(1, event.loaded / total) : 0,
      });
    };
    xhr.onload = () => {
      cleanup();
      const body = parseJson(typeof xhr.response === "string" ? xhr.response : (xhr.responseText ?? ""));
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.({ loaded: file.size, total: file.size, fraction: 1 });
        if (body === undefined) reject(new UploadError("server", "The server sent an unexpected response.", xhr.status));
        else resolve(body as T);
      } else {
        reject(uploadErrorFromStatus(xhr.status, body));
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new UploadError("offline", "Can't reach the server. Check your connection and try again."));
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(new UploadError("offline", "The upload timed out. Check your connection and try again."));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new UploadError("aborted", "The upload was cancelled."));
    };
    xhr.send(form);
  });
}

export interface UploadAttachmentParams {
  workspaceId: string;
  /** Page the file belongs to (needs `edit` on it); omitted for uploads that aren't tied to a page. */
  pageId?: string;
  file: File;
}

/** The URL a document stores for an attachment (conventions §7). */
export function attachmentUrl(attachment: Pick<Attachment, "id" | "url">): string {
  const url = typeof attachment.url === "string" ? attachment.url : "";
  return url.startsWith("/api/files/") ? url : `/api/files/${attachment.id}`;
}

export async function uploadAttachment(params: UploadAttachmentParams, options: UploadOptions = {}): Promise<Attachment> {
  const attachment = await uploadMultipart<Attachment>(
    `/api/workspaces/${encodeURIComponent(params.workspaceId)}/files`,
    { pageId: params.pageId },
    params.file,
    options,
  );
  if (typeof attachment?.id !== "string") {
    throw new UploadError("server", "The server sent an unexpected response.");
  }
  return attachment;
}

export function describeUploadError(error: unknown): string {
  if (error instanceof UploadError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "The upload failed. Please try again.";
}

/** "1.4 MB", "820 KB"; for progress toasts. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
