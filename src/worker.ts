/**
 * Standalone worker process (optional). Run this when you set
 * RUN_WORKERS_IN_PROCESS=false on the bot, to scale the bot separately from the
 * background jobs.
 *
 *   npm run worker        (dev)
 *   npm run start:worker  (compiled)
 *
 * It uses a bare Bot only for its `api` (to send notifications) — it does NOT
 * consume updates, so it won't conflict with the bot's polling/webhook.
 */
import { Bot } from "grammy";
import { config, requireConfig } from "./config.js";
import { logger } from "./logger.js";
import { startWorkers } from "./workers/index.js";
import { startHttpServer } from "./server.js";
import { installSignalHandlers, onShutdown } from "./shutdown.js";
import { pool } from "./db/index.js";
import { closeRedis } from "./redis.js";

async function main() {
  requireConfig("telegram", ["TELEGRAM_BOT_TOKEN"]);
  installSignalHandlers();

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  await bot.init();

  onShutdown(async () => {
    await pool.end().catch(() => {});
    await closeRedis();
  });

  const notify = async (id: number, text: string) => {
    try {
      await bot.api.sendMessage(id, text, { parse_mode: "Markdown" });
    } catch (err) {
      logger.warn({ err, id }, "notify failed");
    }
  };

  const workers = startWorkers({ notify });
  onShutdown(() => workers.stop());

  const http = startHttpServer(); // health only
  onShutdown(() => http.close());

  logger.info("worker process started");
}

main().catch((err) => {
  logger.error({ err }, "worker fatal");
  process.exit(1);
});
