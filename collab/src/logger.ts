export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Same logger with extra fields on every line. */
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

/** Errors serialise to `{name, message, stack}`; everything else passes through JSON as-is. */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    const fields: LogFields = { err: error.message, errName: error.name };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") fields.errCode = code;
    if (error.stack) fields.stack = error.stack;
    return fields;
  }
  return { err: String(error) };
}

/** One JSON object per line on stdout (docker-friendly). Deliberately tiny: no transports, no formatting. */
export function createLogger(
  level: LogLevel = "info",
  base: LogFields = {},
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < threshold) return;
    let line: string;
    try {
      line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...base, ...fields });
    } catch {
      line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, logError: "unserialisable fields" });
    }
    sink(line);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
