import { SignJWT } from "jose";
import { JWT_AUDIENCE, JWT_ISSUER } from "./auth";
import type { Config } from "./config";
import { silentLogger, type LogFields, type Logger } from "./logger";

export const SECRET = "unit-test-secret-0123456789abcdef";
export const INTERNAL_TOKEN = "unit-test-internal-token-0123456789";
export const PUBLIC_ORIGIN = "https://notes.example.com";
export const USER_ID = "0190a5b2-7c3e-7a11-8f44-1234567890aa";
export const OTHER_USER_ID = "0190a5b2-7c3e-7a11-8f44-1234567890bb";
export const PAGE_ID = "0190a5b2-7c3e-7a11-8f44-1234567890ab";
export const OTHER_PAGE_ID = "0190a5b2-7c3e-7a11-8f44-1234567890ac";
export const TARGET_PAGE_ID = "0190a5b2-7c3e-7a11-8f44-1234567890ad";

export interface TokenOptions {
  secret?: string;
  sub?: string | null;
  pageId?: string | null;
  role?: string | null;
  name?: string | null;
  color?: string | null;
  issuer?: string | null;
  audience?: string | null;
  alg?: "HS256" | "HS384" | "HS512";
  /** Seconds relative to now; negative = already expired. `null` omits the claim. */
  expiresIn?: number | null;
}

/** Signs a collab JWT the way the Go API does, with overridable (and removable) claims. */
export async function signToken(options: TokenOptions = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  const set = (key: string, value: string | null | undefined, fallback: string) => {
    if (value !== null) claims[key] = value ?? fallback;
  };
  set("pageId", options.pageId, PAGE_ID);
  set("role", options.role, "edit");
  set("name", options.name, "Ada Lovelace");
  set("color", options.color, "#6366f1");

  let jwt = new SignJWT(claims).setProtectedHeader({ alg: options.alg ?? "HS256" }).setIssuedAt();
  if (options.sub !== null) jwt = jwt.setSubject(options.sub ?? USER_ID);
  if (options.issuer !== null) jwt = jwt.setIssuer(options.issuer ?? JWT_ISSUER);
  if (options.audience !== null) jwt = jwt.setAudience(options.audience ?? JWT_AUDIENCE);
  if (options.expiresIn !== null) jwt = jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 120));
  return jwt.sign(new TextEncoder().encode(options.secret ?? SECRET));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    internalPort: 0,
    apiInternalUrl: "http://api.test:8081",
    databaseUrl: "postgres://user:pass@localhost:5432/db",
    jwtSecret: SECRET,
    internalToken: INTERNAL_TOKEN,
    publicUrl: PUBLIC_ORIGIN,
    allowedOrigins: new Set([PUBLIC_ORIGIN]),
    logLevel: "error",
    ...overrides,
  };
}

/** Logger that records every line so tests can assert on (and on the absence of) log output. */
export function recordingLogger(): { logger: Logger; lines: Array<{ level: string; msg: string } & LogFields> } {
  const lines: Array<{ level: string; msg: string } & LogFields> = [];
  const make = (base: LogFields): Logger => {
    const emit = (level: string) => (msg: string, fields?: LogFields) => {
      lines.push({ level, msg, ...base, ...fields });
    };
    return {
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error"),
      child: (fields) => make({ ...base, ...fields }),
    };
  };
  return { logger: make({}), lines };
}

export { silentLogger };
