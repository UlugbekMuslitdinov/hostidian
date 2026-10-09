import type { CollabToken } from "@hostidian/api-types";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/error";
import { unwrap } from "@/lib/api/unwrap";

/** `POST /pages/{id}/collab-token` (conventions §6). The JWT is only checked when the socket connects. */
export function fetchCollabToken(pageId: string, signal?: AbortSignal): Promise<CollabToken> {
  return unwrap(api.POST("/pages/{pageId}/collab-token", { params: { path: { pageId } }, signal }));
}

export type TokenFailure =
  /** 404: the page is gone or not visible to us (conventions §3: never 403 for "no access"). */
  | "no-access"
  /** 401: the session ended. */
  | "unauthorized"
  /** 403 here is a CSRF/origin misconfiguration, not a permission answer: don't wipe local data over it. */
  | "forbidden"
  /** Network failure or a 5xx: try again later. */
  | "retry";

export function classifyTokenError(error: unknown): TokenFailure {
  if (error instanceof ApiError) {
    if (error.status === 404) return "no-access";
    if (error.status === 401) return "unauthorized";
    if (error.status === 403) return "forbidden";
  }
  return "retry";
}
