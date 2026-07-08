/**
 * Session storage. Redis when REDIS_URL is set (survives restarts, works across
 * multiple bot instances); otherwise grammY's default in-memory store (fine for
 * a single dev process, NOT for production — see assertProductionReady()).
 */
import { RedisAdapter } from "@grammyjs/storage-redis";
import type { StorageAdapter } from "grammy";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";
import type { SessionData } from "./bot/handlers.js";

export function sessionStorage(): StorageAdapter<SessionData> | undefined {
  const redis = getRedis();
  if (!redis) {
    logger.warn("No REDIS_URL — using in-memory sessions (single instance only).");
    return undefined;
  }
  return new RedisAdapter<SessionData>({ instance: redis });
}
