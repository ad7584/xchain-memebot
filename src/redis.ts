/** Shared Redis client (sessions, rate-limits, locks). Null when REDIS_URL unset. */
import { Redis } from "ioredis";
import { config } from "./config.js";
import { logger } from "./logger.js";

let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  if (!config.REDIS_URL) {
    client = null;
    return null;
  }
  client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  client.on("error", (err: Error) => logger.error({ err }, "redis error"));
  client.on("connect", () => logger.info("redis connected"));
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) await client.quit().catch(() => {});
}
