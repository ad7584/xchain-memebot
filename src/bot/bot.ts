/** Builds the configured Bot instance (shared by polling + webhook + worker). */
import { Bot, session } from "grammy";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { sessionStorage } from "../session.js";
import { registerHandlers, type MyContext, type SessionData } from "./handlers.js";

export function createBot(): Bot<MyContext> {
  const bot = new Bot<MyContext>(config.TELEGRAM_BOT_TOKEN);

  bot.use(
    session<SessionData, MyContext>({
      initial: (): SessionData => ({}),
      storage: sessionStorage(),
    })
  );

  registerHandlers(bot as unknown as Parameters<typeof registerHandlers>[0]);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, "bot error");
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: "start", description: "Create your wallets" },
  { command: "buy", description: "Buy a token by contract address" },
  { command: "positions", description: "View holdings / sell" },
  { command: "wallet", description: "Balances" },
  { command: "withdraw", description: "Withdraw funds (2FA + delay)" },
  { command: "enable2fa", description: "Set up withdrawal 2FA" },
  { command: "help", description: "How it works" },
];
