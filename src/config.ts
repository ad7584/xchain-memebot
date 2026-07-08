/**
 * Central config. Loads `.env`, validates with zod, and exposes a typed object.
 *
 * Design choice: missing secrets do NOT crash the process at boot — the bot must
 * be inspectable before you hand me keys. Instead each subsystem calls
 * `requireConfig(...)` at the point of use and throws a clear, actionable error.
 */
import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().default(""),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  TRADING_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),

  RH_RPC_URL: z.string().url(),
  ALCHEMY_RH_RPC_URL: z.string().url().or(z.literal("")).default(""),
  RH_WS_FEED_URL: z.string().default(""),
  RH_EXPLORER_API: z.string().url(),

  SOLANA_RPC_URL: z.string().url(),
  SOLANA_RPC_URL_PAID: z.string().url().or(z.literal("")).default(""),

  // Custody backend. 'local' = per-user keys generated + encrypted at rest in the
  // DB (needs ENCRYPTION_KEY). 'turnkey' = Turnkey TEE custody (needs the keys
  // below). 'auto' picks turnkey when its org id is set, else local.
  CUSTODY_PROVIDER: z.enum(["local", "turnkey", "auto"]).default("auto"),
  TURNKEY_API_BASE_URL: z.string().url().default("https://api.turnkey.com"),
  TURNKEY_ORGANIZATION_ID: z.string().default(""),
  TURNKEY_API_PUBLIC_KEY: z.string().default(""),
  TURNKEY_API_PRIVATE_KEY: z.string().default(""),

  RELAY_API_BASE: z.string().url().default("https://api.relay.link"),
  // Fee treasuries. Relay pays app fees in the ORIGIN currency/chain, so buys
  // (Solana origin) pay to the Solana address and sells (RH origin) to the EVM one.
  FEE_TREASURY_EVM: z.string().default(""),
  FEE_TREASURY_SOL: z.string().default(""),
  APP_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(100),

  // Uniswap Trading API (swap calldata). Confirmed reachable for chain 4663 but
  // REQUIRES an api key. Alternative: an on-chain Universal Router v4 builder.
  UNISWAP_TRADING_API: z.string().url().default("https://trade-api.gateway.uniswap.org/v1"),
  UNISWAP_API_KEY: z.string().default(""),

  GAS_TANK_PRIVATE_KEY: z.string().default(""),
  GAS_TANK_MAX_TOPUP_WEI: z.coerce.bigint().default(2_000_000_000_000_000n),

  DATABASE_URL: z.string(),

  DEFAULT_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(5000).default(800),
  MAX_BUY_USD: z.coerce.number().positive().default(500),
  WITHDRAWAL_DELAY_SECONDS: z.coerce.number().int().min(0).default(7200),

  // --- Production / deployment ---------------------------------------------
  // polling: simple, single instance. webhook: for public prod behind HTTPS.
  BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
  PORT: z.coerce.number().int().default(8080),
  // Public HTTPS base where Telegram reaches the webhook, e.g. https://bot.example.com
  WEBHOOK_DOMAIN: z.string().default(""),
  // Random path/secret token guarding the webhook endpoint.
  WEBHOOK_SECRET: z.string().default(""),
  // redis[s]://user:pass@host:port. Empty ⇒ in-memory sessions (single instance only).
  REDIS_URL: z.string().default(""),
  // Run the background workers (withdrawals, recovery, deposits).
  ENABLE_WORKERS: z.string().default("true").transform((v) => v.toLowerCase() === "true"),
  // true: workers run inside the bot process (simple deploy). false: run `worker.ts` separately.
  RUN_WORKERS_IN_PROCESS: z.string().default("true").transform((v) => v.toLowerCase() === "true"),
  // Comma-separated Telegram user ids allowed to use /admin controls.
  ADMIN_TELEGRAM_IDS: z.string().default(""),
  // 32-byte hex key used to encrypt 2FA secrets at rest (AES-256-GCM). Required in prod.
  ENCRYPTION_KEY: z.string().default(""),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();

/**
 * Assert that a set of config keys are non-empty, or throw a clear error naming
 * exactly which env vars the caller needs. Use at the entry of any subsystem
 * that needs secrets you'll supply later.
 */
export function requireConfig<K extends keyof Config>(
  subsystem: string,
  keys: K[]
): void {
  const missing = keys.filter((k) => {
    const v = config[k];
    return v === "" || v === undefined || v === null;
  });
  if (missing.length > 0) {
    throw new Error(
      `[${subsystem}] missing required env: ${missing.join(", ")}. ` +
        `Fill these in .env (see .env.example).`
    );
  }
}

export const isProd = config.NODE_ENV === "production";

export const adminIds: number[] = config.ADMIN_TELEGRAM_IDS.split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number)
  .filter(Number.isFinite);

export const isAdmin = (id: number): boolean => adminIds.includes(id);

/**
 * Fail fast in production if critical prod-only settings are missing. Called from
 * the entrypoint. Kept out of `load()` so local/dev boots freely.
 */
export function assertProductionReady(): string[] {
  const problems: string[] = [];
  if (!config.TELEGRAM_BOT_TOKEN) problems.push("TELEGRAM_BOT_TOKEN is required.");
  if (config.BOT_MODE === "webhook") {
    if (!config.WEBHOOK_DOMAIN) problems.push("WEBHOOK_DOMAIN required for webhook mode.");
    if (!config.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET required for webhook mode.");
  }
  if (!config.REDIS_URL) problems.push("REDIS_URL required in prod (in-memory sessions don't survive restarts / multi-instance).");
  if (!config.ENCRYPTION_KEY) problems.push("ENCRYPTION_KEY required in prod (encrypts 2FA secrets AND local-custody wallet private keys at rest).");
  if (config.TRADING_ENABLED && !config.FEE_TREASURY_EVM) problems.push("FEE_TREASURY_EVM required once trading is enabled.");
  return problems;
}
