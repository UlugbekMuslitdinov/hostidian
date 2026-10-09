import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isUuid } from "./auth";
import { closeMatchingConnections, type ConnectionRegistry } from "./connections";
import type { ImportRequest } from "./import-markdown";
import { errorFields, type Logger } from "./logger";

/** Constant-time string comparison (hashes first so length differences do not leak either). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export interface InternalApiDeps {
  token: string;
  registry: ConnectionRegistry;
  importMarkdown(request: ImportRequest): Promise<"imported" | "page_gone">;
  logger: Logger;
}

const DISCONNECT_BODY_LIMIT = 16 * 1024;
const IMPORT_BODY_LIMIT = 32 * 1024 * 1024;
const DEFAULT_DISCONNECT_REASON = "permissions_changed";

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: HttpError): void {
  sendJson(
    res,
    error.status,
    { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
    error.headers,
  );
}

async function readJsonObject(req: IncomingMessage, limitBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new HttpError(413, "payload_too_large", "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new HttpError(413, "payload_too_large", "Request body is too large.");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "bad_request", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function optionalUuid(body: Record<string, unknown>, field: string, details: Record<string, string>): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (!isUuid(value)) {
    details[field] = "must be a UUID";
    return undefined;
  }
  return value.toLowerCase();
}

function parseDisconnect(body: Record<string, unknown>) {
  const details: Record<string, string> = {};
  const pageId = optionalUuid(body, "pageId", details);
  const userId = optionalUuid(body, "userId", details);
  let reason = DEFAULT_DISCONNECT_REASON;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || body.reason.length === 0 || body.reason.length > 100) {
      details.reason = "must be a non-empty string of at most 100 characters";
    } else {
      reason = body.reason;
    }
  }
  if (!pageId && !userId && !details.pageId && !details.userId) details.pageId = "pageId or userId is required";
  if (Object.keys(details).length > 0) {
    throw new HttpError(422, "validation_failed", "Invalid disconnect request.", details);
  }
  return { pageId, userId, reason };
}

function parseImport(body: Record<string, unknown>): ImportRequest {
  const details: Record<string, string> = {};
  const pageId = optionalUuid(body, "pageId", details);
  if (!pageId && !details.pageId) details.pageId = "is required";
  if (typeof body.markdown !== "string") details.markdown = "must be a string";
  const editorId = optionalUuid(body, "editorId", details);
  if (Object.keys(details).length > 0 || !pageId || typeof body.markdown !== "string") {
    throw new HttpError(422, "validation_failed", "Invalid import request.", details);
  }
  return { pageId, markdown: body.markdown, ...(editorId ? { editorId } : {}) };
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] !== undefined && safeEqual(match[1].trim(), token);
}

/** The internal HTTP listener (api/internal.yaml, `collab-internal` operations). */
export function createInternalServer(deps: InternalApiDeps): Server {
  const { logger } = deps;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    if (path === "/internal/health") {
      if (method !== "GET" && method !== "HEAD") {
        throw new HttpError(405, "method_not_allowed", "Use GET.", undefined, { allow: "GET, HEAD" });
      }
      return sendJson(res, 200, { status: "ok" });
    }

    const handlers: Record<string, string> = {
      "/internal/disconnect": "POST",
      "/internal/import-markdown": "POST",
    };
    const allowed = path === undefined ? undefined : handlers[path];
    if (!allowed) throw new HttpError(404, "not_found", "No such endpoint.");
    // Authenticate before looking at the method or body so unauthenticated callers learn nothing.
    if (!isAuthorized(req, deps.token)) throw new HttpError(401, "unauthorized", "Missing or invalid bearer token.");
    if (method !== allowed) {
      throw new HttpError(405, "method_not_allowed", `Use ${allowed}.`, undefined, { allow: allowed });
    }

    if (path === "/internal/disconnect") {
      const criteria = parseDisconnect(await readJsonObject(req, DISCONNECT_BODY_LIMIT));
      const closed = closeMatchingConnections(deps.registry, criteria);
      logger.info("connections closed on request", { ...criteria, closed });
      return sendJson(res, 200, { closed });
    }

    const request = parseImport(await readJsonObject(req, IMPORT_BODY_LIMIT));
    const outcome = await deps.importMarkdown(request);
    if (outcome === "page_gone") throw new HttpError(404, "not_found", "The page does not exist.");
    logger.info("markdown imported", { pageId: request.pageId, bytes: request.markdown.length });
    return sendJson(res, 204);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendError(res, error);
      logger.error("internal request failed", { method: req.method, url: req.url?.split("?")[0], ...errorFields(error) });
      sendError(res, new HttpError(500, "internal", "Internal error."));
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 20_000;
  return server;
}
