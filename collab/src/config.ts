import { createLogger, type LogLevel } from "./logger";

export interface Config {
  /** Public WebSocket listener (Caddy proxies `/collab` here). */
  port: number;
  /** Internal HTTP listener: health, disconnect, import-markdown. Never published. */
  internalPort: number;
  /** Base URL of the Go API's internal listener, without trailing slash. */
  apiInternalUrl: string;
  databaseUrl: string;
  /** HS256 secret shared with the Go API (collab JWTs). */
  jwtSecret: string;
  /** Bearer token for service-to-service calls (both directions). */
  internalToken: string;
  publicUrl: string;
  /** Browser origins allowed to open WebSockets: the PUBLIC_URL origin plus ALLOWED_ORIGINS. */
  allowedOrigins: ReadonlySet<string>;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function parsePort(name: string, raw: string | undefined, fallback: number, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    problems.push(`${name} must be an integer between 0 and 65535 (got ${JSON.stringify(raw)})`);
    return fallback;
  }
  return value;
}

function parseUrl(name: string, raw: string, protocols: string[], problems: string[]): URL | undefined {
  try {
    const url = new URL(raw);
    if (!protocols.includes(url.protocol)) {
      problems.push(`${name} must use ${protocols.join(" or ")} (got ${JSON.stringify(url.protocol)})`);
      return undefined;
    }
    return url;
  } catch {
    problems.push(`${name} must be a valid URL (got ${JSON.stringify(raw)})`);
    return undefined;
  }
}

/**
 * Reads and validates the environment. Throws `ConfigError` listing every problem at once so a misconfigured
 * container fails fast with one readable message instead of one error per restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }
  const jwtSecret = required("COLLAB_JWT_SECRET");
  const internalToken = required("INTERNAL_TOKEN");
  const publicUrlRaw = required("PUBLIC_URL");

  const port = parsePort("COLLAB_PORT", env.COLLAB_PORT, 1234, problems);
  const internalPort = parsePort("COLLAB_INTERNAL_PORT", env.COLLAB_INTERNAL_PORT, 1235, problems);
  if (port !== 0 && port === internalPort) problems.push("COLLAB_PORT and COLLAB_INTERNAL_PORT must differ");

  const apiRaw = (env.API_INTERNAL_URL?.trim() || "http://api:8081").replace(/\/+$/, "");
  const apiUrl = parseUrl("API_INTERNAL_URL", apiRaw, ["http:", "https:"], problems);

  const allowedOrigins = new Set<string>();
  if (publicUrlRaw) {
    const publicUrl = parseUrl("PUBLIC_URL", publicUrlRaw, ["http:", "https:"], problems);
    if (publicUrl) allowedOrigins.add(publicUrl.origin);
  }
  for (const entry of (env.ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const url = parseUrl(`ALLOWED_ORIGINS entry ${JSON.stringify(trimmed)}`, trimmed, ["http:", "https:"], problems);
    if (url) allowedOrigins.add(url.origin);
  }

  const logLevelRaw = (env.LOG_LEVEL?.trim() || "info").toLowerCase();
  const logLevel = LOG_LEVELS.find((l) => l === logLevelRaw);
  if (!logLevel) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got ${JSON.stringify(logLevelRaw)})`);

  if (problems.length > 0 || !logLevel || !apiUrl) throw new ConfigError(problems);

  // Placeholder or tiny secrets still work (dev), but nobody should run production with them.
  const warn = createLogger(logLevel).warn;
  for (const [name, value] of [
    ["COLLAB_JWT_SECRET", jwtSecret],
    ["INTERNAL_TOKEN", internalToken],
  ] as const) {
    if (value === "change-me" || value.length < 16) {
      warn(`${name} is a placeholder or shorter than 16 characters; generate one with scripts/gen-env.sh`);
    }
  }

  return {
    port,
    internalPort,
    apiInternalUrl: apiRaw,
    databaseUrl,
    jwtSecret,
    internalToken,
    publicUrl: publicUrlRaw,
    allowedOrigins,
    logLevel,
  };
}
