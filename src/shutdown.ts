/** Graceful shutdown registry. Hooks run LIFO on SIGINT/SIGTERM. */
import { logger } from "./logger.js";

type Hook = () => Promise<void> | void;
const hooks: Hook[] = [];
let shuttingDown = false;

export function onShutdown(hook: Hook): void {
  hooks.push(hook);
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

export function installSignalHandlers(): void {
  const handler = async (sig: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, "graceful shutdown starting");
    // Hard deadline: if a hook hangs, force-exit rather than wedge forever.
    const killer = setTimeout(() => {
      logger.error("shutdown timed out — forcing exit");
      process.exit(code || 1);
    }, SHUTDOWN_TIMEOUT_MS);
    killer.unref();
    // Iterate a COPY (reverse() mutates in place) so hooks run LIFO reliably.
    for (const hook of [...hooks].reverse()) {
      try {
        await hook();
      } catch (err) {
        logger.error({ err }, "shutdown hook failed");
      }
    }
    clearTimeout(killer);
    logger.info("shutdown complete");
    process.exit(code);
  };
  process.on("SIGINT", () => void handler("SIGINT"));
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("unhandledRejection", (reason) =>
    logger.error({ reason }, "unhandledRejection")
  );
  // A corrupt process must NOT keep running — log then exit (via graceful path).
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException — exiting");
    void handler("uncaughtException", 1);
  });
}

export const isShuttingDown = () => shuttingDown;
