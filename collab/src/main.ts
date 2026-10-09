import { format } from "node:util";
import { ConfigError, loadConfig } from "./config";
import { createLogger, errorFields, type Logger } from "./logger";
import { createCollabServer } from "./server";

/** Hocuspocus and friends print with console.*; route that through the JSON logger. */
function captureConsole(logger: Logger): void {
  const forward = (level: "debug" | "info" | "warn" | "error") => (...args: unknown[]) => {
    logger[level](format(...args), { source: "console" });
  };
  console.debug = forward("debug");
  console.log = forward("info");
  console.info = forward("info");
  console.warn = forward("warn");
  console.error = forward("error");
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  captureConsole(logger);
  const server = createCollabServer(config, { logger });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      logger.warn("second signal received, exiting immediately", { signal });
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("signal received", { signal });
    server.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("shutdown failed", errorFields(error));
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection", errorFields(reason)));
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", errorFields(error));
    process.exit(1);
  });

  await server.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
