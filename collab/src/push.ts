import { errorFields, type Logger } from "./logger";
import type { ExtractedContent } from "./extract";
import { withRetry, type RetryOptions } from "./persistence";

export interface ContentPayload extends ExtractedContent {
  /** Users that changed the document since the last push, most recent first. */
  editorIds: string[];
}

export type PushResult = "ok" | "not_found";

export class PushError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PushError";
  }
}

export interface PusherOptions {
  apiInternalUrl: string;
  internalToken: string;
  logger: Logger;
  retry?: Partial<RetryOptions>;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

/** Retried: network failures, timeouts, 5xx and 429. Everything else from the API is final. */
function isRetryable(error: unknown): boolean {
  if (error instanceof PushError) return error.status === undefined || error.status >= 500 || error.status === 429;
  return true;
}

/**
 * `collab -> api`: pushes extracted content. Each call retries with exponential backoff; a 404 means the page no longer
 * exists and is reported to the caller instead of being retried.
 */
export class ContentPusher {
  private readonly fetchImpl: typeof fetch;
  private closing = false;

  constructor(private readonly options: PusherOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Stops retry loops at the next failure (graceful shutdown). */
  close(): void {
    this.closing = true;
  }

  /**
   * `isStale` lets the caller abandon retries once a newer version of the same page is waiting.
   * Throws `PushError` when retries are exhausted or the API rejects the payload.
   */
  async push(
    pageId: string,
    payload: ContentPayload,
    isStale: () => boolean = () => false,
    retryOverrides: Partial<RetryOptions> = {},
  ): Promise<PushResult> {
    return withRetry(
      () => this.attempt(pageId, payload),
      {
        attempts: 8,
        baseDelayMs: 1_000,
        maxDelayMs: 60_000,
        ...this.options.retry,
        ...retryOverrides,
        shouldRetry: (error) => isRetryable(error) && !this.closing && !isStale(),
      },
      (error, attempt, delayMs) =>
        this.options.logger.warn("content push failed, retrying", { pageId, attempt, delayMs, ...errorFields(error) }),
    );
  }

  private async attempt(pageId: string, payload: ContentPayload): Promise<PushResult> {
    const url = `${this.options.apiInternalUrl}/internal/pages/${encodeURIComponent(pageId)}/content`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.internalToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new PushError(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Drain the body so the connection can be reused.
    const text = await response.text().catch(() => "");
    if (response.status === 204 || response.status === 200) return "ok";
    if (response.status === 404) return "not_found";
    throw new PushError(`API answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`, response.status);
  }
}
