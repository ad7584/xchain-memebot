import pino from "pino";
import { config, isProd } from "./config.js";

// Sensitive key names — redacted at top level and 1–2 levels of nesting.
const SECRET_KEYS = [
  "privateKey",
  "apiPrivateKey",
  "mnemonic",
  "seed",
  "secret",
  "token",
  "TELEGRAM_BOT_TOKEN",
  "ENCRYPTION_KEY",
  "WEBHOOK_SECRET",
  "GAS_TANK_PRIVATE_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_API_PUBLIC_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "twofa_secret",
];
const SECRET_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }),
  // Never log secrets even if an object carrying one is passed in. Cover each
  // sensitive key name at the top level and one/two levels of nesting.
  redact: {
    paths: SECRET_PATHS,
    censor: "[redacted]",
  },
});
