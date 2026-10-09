import { ApiError } from "./error";

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

async function settle<R extends { error?: unknown; response: Response }>(request: Promise<R>): Promise<R> {
  let result: R;
  try {
    result = await request;
  } catch (cause) {
    // Aborts are deliberate (query cancellation) and must stay recognisable.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw ApiError.network(cause);
  }
  if (result.error !== undefined || !result.response.ok) {
    throw ApiError.fromResponse(result.response.status, result.error);
  }
  return result;
}

/** Resolve an openapi-fetch call to its payload, or throw an {@link ApiError}. */
export async function unwrap<T>(request: Promise<FetchResult<T>>): Promise<T> {
  const result = await settle(request);
  return result.data as T;
}

/** For 204/empty responses. */
export async function unwrapVoid(request: Promise<{ error?: unknown; response: Response }>): Promise<void> {
  await settle(request);
}
