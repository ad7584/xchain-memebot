/**
 * HTTP server: liveness/readiness health check + (in webhook mode) the Telegram
 * webhook endpoint. Needed for any real deployment — orchestrators (Railway,
 * Fly, k8s, Render) probe /health, and public bots take updates over HTTPS.
 */
import { createServer, type Server } from "node:http";
import { webhookCallback, type Bot } from "grammy";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/index.js";
import { getRedis } from "./redis.js";
import type { MyContext } from "./bot/handlers.js";

export interface ServerHandle {
  server: Server;
  webhookPath: string;
  close: () => Promise<void>;
}

export function startHttpServer(bot?: Bot<MyContext>): ServerHandle {
  const webhookPath = `/webhook/${config.WEBHOOK_SECRET || "disabled"}`;
  const handleUpdate =
    bot && config.BOT_MODE === "webhook"
      ? webhookCallback(bot, "http", { secretToken: config.WEBHOOK_SECRET || undefined })
      : null;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
        const health = await checkHealth();
        res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }
      if (handleUpdate && req.method === "POST" && req.url === webhookPath) {
        return await handleUpdate(req, res);
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      logger.error({ err }, "http handler error");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    }
  });

  server.listen(config.PORT, () =>
    logger.info(`HTTP server listening on :${config.PORT} (mode=${config.BOT_MODE})`)
  );
  return {
    server,
    webhookPath,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function checkHealth() {
  const out: Record<string, unknown> = {
    ok: true,
    service: "xchain-memebot",
    tradingEnabled: config.TRADING_ENABLED,
  };
  try {
    await pool.query("SELECT 1");
    out.db = "up";
  } catch {
    out.db = "down";
    out.ok = false;
  }
  const redis = getRedis();
  if (redis) {
    try {
      await redis.ping();
      out.redis = "up";
    } catch {
      out.redis = "down";
      out.ok = false;
    }
  } else {
    out.redis = "disabled";
  }
  return out;
}
