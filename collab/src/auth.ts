import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { errors, jwtVerify } from "jose";
import type { Extension, onAuthenticatePayload, onUpgradePayload, beforeHandleAwarenessPayload } from "@hocuspocus/server";
import { errorFields, type Logger } from "./logger";

export const JWT_ISSUER = "hostidian-api";
export const JWT_AUDIENCE = "hostidian-collab";
export const REQUIRED_CLAIMS = ["sub", "pageId", "role", "name", "color", "exp"] as const;

export type PageRole = "view" | "comment" | "edit" | "full";
const ROLES: readonly PageRole[] = ["view", "comment", "edit", "full"];
const READ_ONLY_ROLES: ReadonlySet<PageRole> = new Set(["view", "comment"]);

/** What the rest of the service knows about a connected user. Stored as the Hocuspocus connection context. */
export interface CollabUser {
  id: string;
  name: string;
  color: string;
  role: PageRole;
}

export interface ConnectionContext {
  user?: CollabUser;
}

/** Why a connection was refused. `reason` is what the provider's `authenticationFailed` event carries. */
export class AuthError extends Error {
  constructor(
    public readonly reason: string,
    detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "AuthError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DOCUMENT_PREFIX = "page:";

export const documentNameFor = (pageId: string): string => `${DOCUMENT_PREFIX}${pageId.toLowerCase()}`;

/** `page:<uuid>` -> lower-case uuid, anything else -> undefined. */
export function pageIdFromDocumentName(documentName: string): string | undefined {
  if (!documentName.startsWith(DOCUMENT_PREFIX)) return undefined;
  const id = documentName.slice(DOCUMENT_PREFIX.length);
  return UUID_RE.test(id) ? id.toLowerCase() : undefined;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Exact-match allow-list on the normalised origin. A missing/empty/`null` Origin is refused: browsers always send one on
 * WebSocket upgrades, so its absence means a non-browser client that is not covered by the cookie/CSRF model.
 */
export function isOriginAllowed(origin: string | null | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return false;
  try {
    return allowed.has(new URL(origin).origin);
  } catch {
    return false;
  }
}

export interface AuthOptions {
  secret: Uint8Array;
  allowedOrigins: ReadonlySet<string>;
  /** Seconds of clock skew tolerated when checking `exp`. */
  clockToleranceSeconds?: number;
}

export interface AuthResult {
  user: CollabUser;
  readOnly: boolean;
}

/**
 * Verifies a collab JWT for `documentName` and decides the connection's mode.
 * Checks, in order: origin, signature/issuer/audience/expiry/required claims, claim shapes, token page == document.
 */
export async function authenticate(
  options: AuthOptions,
  input: { token: string; documentName: string; origin: string | null | undefined },
): Promise<AuthResult> {
  if (!isOriginAllowed(input.origin, options.allowedOrigins)) throw new AuthError("forbidden-origin");

  const documentPageId = pageIdFromDocumentName(input.documentName);
  if (!documentPageId) throw new AuthError("invalid-document");
  if (!input.token) throw new AuthError("unauthorized", "missing token");

  let payload;
  try {
    ({ payload } = await jwtVerify(input.token, options.secret, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      requiredClaims: [...REQUIRED_CLAIMS],
      clockTolerance: options.clockToleranceSeconds ?? 5,
    }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw new AuthError("token-expired");
    throw new AuthError("unauthorized", error instanceof Error ? error.message : "invalid token");
  }

  const { sub, pageId, role, name, color } = payload;
  if (!isUuid(sub)) throw new AuthError("unauthorized", "invalid sub claim");
  if (!isUuid(pageId)) throw new AuthError("unauthorized", "invalid pageId claim");
  if (typeof role !== "string" || !ROLES.includes(role as PageRole)) throw new AuthError("unauthorized", "invalid role claim");
  if (typeof name !== "string" || name.length === 0 || name.length > 200) throw new AuthError("unauthorized", "invalid name claim");
  // The colour ends up in CSS (cursor/avatar styles) on every other client, so it is validated strictly.
  if (typeof color !== "string" || !COLOR_RE.test(color)) throw new AuthError("unauthorized", "invalid color claim");

  if (pageId.toLowerCase() !== documentPageId) throw new AuthError("forbidden-page");

  const typedRole = role as PageRole;
  return {
    user: { id: sub.toLowerCase(), name, color, role: typedRole },
    readOnly: READ_ONLY_ROLES.has(typedRole),
  };
}

/** Paths Caddy may forward (it strips `/collab`, dev setups may not). */
const WS_PATHS = new Set(["/", "/collab", "/collab/"]);

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function requestPath(request: IncomingMessage): string {
  return (request.url ?? "/").split("?")[0] || "/";
}

/**
 * The Hocuspocus extension that guards every connection:
 * - `onUpgrade`: path and Origin are checked before the WebSocket exists (cheap early rejection),
 * - `onAuthenticate`: the JWT, the Origin again (defence in depth) and read-only roles,
 * - `beforeHandleAwareness`: presence identity comes from the verified token, never from the client.
 */
export function createAuthExtension(options: AuthOptions, logger: Logger): Extension<ConnectionContext> {
  return {
    extensionName: "hostidian-auth",
    // Run before any other extension's hooks.
    priority: 1000,

    async onUpgrade({ request, socket }: onUpgradePayload) {
      if (!WS_PATHS.has(requestPath(request))) {
        rejectUpgrade(socket, 404, "Not Found");
        return Promise.reject();
      }
      if (!isOriginAllowed(request.headers.origin, options.allowedOrigins)) {
        logger.warn("websocket upgrade refused", { reason: "forbidden-origin", origin: request.headers.origin ?? null });
        rejectUpgrade(socket, 403, "Forbidden");
        return Promise.reject();
      }
    },

    async onAuthenticate({ token, documentName, request, connectionConfig }: onAuthenticatePayload<ConnectionContext>) {
      try {
        const { user, readOnly } = await authenticate(options, {
          token,
          documentName,
          origin: request.headers.get("origin"),
        });
        connectionConfig.readOnly = readOnly;
        logger.debug("client authenticated", { documentName, userId: user.id, role: user.role });
        return { user };
      } catch (error) {
        if (error instanceof AuthError) {
          logger.info("client refused", { documentName, reason: error.reason, detail: error.message });
          // Hocuspocus forwards `reason` to the provider; a bare object avoids its console error for Error messages.
          throw { reason: error.reason };
        }
        logger.error("authentication crashed", { documentName, ...errorFields(error) });
        throw { reason: "internal" };
      }
    },

    async beforeHandleAwareness({ context, states }: beforeHandleAwarenessPayload<ConnectionContext>) {
      const user = context?.user;
      if (!user) return;
      for (const state of states.values()) {
        if (state && typeof state === "object") {
          state.user = { id: user.id, name: user.name, color: user.color };
        }
      }
    },
  };
}
