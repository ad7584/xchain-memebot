/**
 * Bot entrypoint.
 *
 *   npm run dev      (local, polling)
 *   npm start        (compiled)
 *
 * Modes (BOT_MODE): "polling" for local/simple, "webhook" for public prod behind
 * HTTPS. Workers run in-process by default (RUN_WORKERS_IN_PROCESS=true); set it
 * false and run `npm run worker` separately to scale the bot horizontally.
 */
import { config, isProd, requireConfig, assertProductionReady } from "./config.js";
import { logger } from "./logger.js";
import { createBot, BOT_COMMANDS } from "./bot/bot.js";
import { startHttpServer } from "./server.js";
import { startWorkers } from "./workers/index.js";
import { installSignalHandlers, onShutdown, isShuttingDown } from "./shutdown.js";
import { pool } from "./db/index.js";
import { closeRedis } from "./redis.js";

async function main() {
  requireConfig("telegram", ["TELEGRAM_BOT_TOKEN"]);
  installSignalHandlers();

  if (isProd) {
    const problems = assertProductionReady();
    if (problems.length) {
      logger.fatal({ problems }, "refusing to start: not production-ready");
      process.exit(1);
    }
  }

  const bot = createBot();
  await bot.api.setMyCommands(BOT_COMMANDS);

  // Infra teardown runs LAST (registered first → LIFO).
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
  if (config.ENABLE_WORKERS && config.RUN_WORKERS_IN_PROCESS) {
    const workers = startWorkers({ notify });
    onShutdown(() => workers.stop());
  }

  onShutdown(async () => {
    await bot.stop().catch(() => {});
  });

  const http = startHttpServer(bot);
  onShutdown(() => http.close()); // runs FIRST: stop taking new requests

  if (!config.TRADING_ENABLED) {
    logger.warn("TRADING_ENABLED=false — quotes/onboarding work, trades will NOT broadcast.");
  }

  if (config.BOT_MODE === "webhook") {
    requireConfig("webhook", ["WEBHOOK_DOMAIN", "WEBHOOK_SECRET"]);
    await bot.init();
    const url = `${config.WEBHOOK_DOMAIN.replace(/\/$/, "")}${http.webhookPath}`;
    await bot.api.setWebhook(url, {
      secret_token: config.WEBHOOK_SECRET,
      drop_pending_updates: false,
    });
    logger.info(`@${bot.botInfo.username} live (webhook → ${url})`);
  } else {
    // Ensure no stale webhook is set when polling.
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
    // Poll resiliently: a 409 (another instance briefly polling — e.g. the old
    // container during a rolling redeploy) must NOT crash the process. Retry until
    // we win the lock, so deploys are seamless instead of a crash-restart blip.
    for (let attempt = 1; !isShuttingDown(); attempt++) {
      try {
        await bot.start({ onStart: (me) => logger.info(`@${me.username} live (polling)`) });
        break; // clean shutdown
      } catch (err) {
        if ((err as { error_code?: number })?.error_code === 409) {
          logger.warn({ attempt }, "getUpdates 409 conflict — another instance is polling; retrying in 5s");
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        throw err;
      }
    }
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
