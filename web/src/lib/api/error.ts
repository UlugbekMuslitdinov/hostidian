import type { ApiError as ErrorEnvelope } from "@hostidian/api-types";

export type ApiErrorCode = ErrorEnvelope["error"]["code"] | "network" | "unknown";

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  422: "validation_failed",
  429: "rate_limited",
  500: "internal",
};

/** Error thrown for every non-2xx API response (and for failed fetches, with status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, string>;

  constructor(status: number, code: ApiErrorCode, message: string, details?: Record<string, string>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Build from the conventions §1 envelope; tolerates non-JSON bodies (proxies, 502 pages). */
  static fromResponse(status: number, body: unknown): ApiError {
    if (isEnvelope(body)) {
      const { code, message, details } = body.error;
      return new ApiError(status, code, message || defaultMessage(status), details);
    }
    return new ApiError(
      status,
      CODE_BY_STATUS[status] ?? (status >= 500 ? "internal" : "unknown"),
      defaultMessage(status),
    );
  }

  static network(cause?: unknown): ApiError {
    const err = new ApiError(0, "network", "Can't reach the server. Check your connection.");
    if (cause !== undefined) err.cause = cause;
    return err;
  }
}

function isEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const inner = (body as { error: unknown }).error;
  return typeof inner === "object" && inner !== null && typeof (inner as { code?: unknown }).code === "string";
}

function defaultMessage(status: number): string {
  if (status === 401) return "You need to sign in.";
  if (status === 403) return "You don't have permission to do that.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Too many attempts. Please wait a moment and try again.";
  if (status === 501) return "This feature isn't available on this server yet.";
  if (status >= 500) return "The server ran into a problem. Please try again.";
  return "Something went wrong.";
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 0;
}

export function hasStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof ApiError && statuses.includes(error.status);
}

/** Errors worth retrying: transport failures and upstream hiccups (never 4xx). */
export function isTransientError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504)
  );
}

/** User-facing message for any thrown value. */
export function errorMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
