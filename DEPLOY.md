# Deploying xchain-memebot (public / production)

This bot is built to run as a real service, not just locally. Two supported shapes:

- **A. Docker Compose** (self-hosted VPS) — bot + Postgres + Redis in one stack.
- **B. PaaS** (Railway / Fly.io / Render) — managed Postgres + Redis, bot as a container.

Either way the moving parts are: **the bot process**, **Postgres**, **Redis**, and (for public prod) a **public HTTPS URL** for the Telegram webhook.

---

## 0. Secrets to set (production)

Fill these in the platform's secret manager (never commit them):

| Var | Notes |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `NODE_ENV` | `production` |
| `BOT_MODE` | `webhook` for public prod |
| `WEBHOOK_DOMAIN` | your public HTTPS base, e.g. `https://bot.yourdomain.com` |
| `WEBHOOK_SECRET` | `openssl rand -hex 24` |
| `DATABASE_URL` | managed Postgres URL (use `?sslmode=require` on most PaaS) |
| `REDIS_URL` | managed Redis URL |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` — encrypts 2FA secrets at rest |
| `TURNKEY_*` | org id + API key pair (custody/signing) |
| `ALCHEMY_RH_RPC_URL` | reliable RH-Chain RPC (recommended over public) |
| `SOLANA_RPC_URL_PAID` | paid Solana RPC (public will rate-limit at scale) |
| `GAS_TANK_PRIVATE_KEY` | isolated hot wallet funding sell-gas |
| `FEE_TREASURY_EVM` | collects affiliate fees |
| `TRADING_ENABLED` | keep `false` until `npm run preflight` passes and you've verified everything |

> In `NODE_ENV=production` the app **refuses to boot** if `REDIS_URL`, `ENCRYPTION_KEY`, or (in webhook mode) `WEBHOOK_DOMAIN`/`WEBHOOK_SECRET` are missing — a guard, not a nuisance.

---

## A. Docker Compose (self-hosted)

```bash
cp .env.example .env          # fill in the secrets above
#   set BOT_MODE=webhook and WEBHOOK_DOMAIN if exposing publicly, or keep
#   BOT_MODE=polling to run without a public URL.
docker compose up -d --build
docker compose logs -f bot
```

- Compose provides Postgres + Redis and injects their URLs (overriding `.env`).
- Migrations run automatically on container start (`dist/scripts/migrate.js`).
- Health check: `GET http://host:8080/health`.
- **Webhook mode** needs the port reachable over HTTPS — put it behind a reverse proxy (Caddy/nginx/Traefik) that terminates TLS and forwards to `:8080`. **Polling mode** needs no inbound port.

Scaling workers out: uncomment the `worker` service in `docker-compose.yml` and set `RUN_WORKERS_IN_PROCESS=false` on `bot`.

---

## B. PaaS (Railway / Render / Fly)

1. Provision **Postgres** and **Redis** add-ons; copy their URLs into env vars.
2. Deploy this repo (it has a `Dockerfile`). Set all secrets above.
3. `BOT_MODE=webhook`, `WEBHOOK_DOMAIN=<the app's public URL>`.
4. The container runs migrations then starts; the platform's health check should hit `/health`.
5. First deploy sets the Telegram webhook automatically on boot.

Polling also works on a PaaS (no public URL needed) — set `BOT_MODE=polling`. Simpler, but a single instance only.

---

## 1. Go-live checklist

1. `npm run preflight` (against mainnet) → all green.
2. Secrets set; `TURNKEY_*`, `GAS_TANK_PRIVATE_KEY`, `FEE_TREASURY_EVM` in place.
3. Fund the **gas tank** wallet with a little ETH on Robinhood Chain (it fronts sell-gas). Monitor its balance (alerts in the recovery/ops layer — TODO).
4. `ENCRYPTION_KEY` set so 2FA secrets are encrypted.
5. Flip `TRADING_ENABLED=true`.
6. Do a tiny real buy + sell + withdraw end-to-end before announcing.
7. Confirm `/health` returns `{"ok":true,"db":"up","redis":"up"}`.

## 2. Ops notes

- **Webhook vs polling**: webhook scales to multiple instances and is lower-latency; polling is single-instance and simplest. Sessions/locks use Redis so multiple instances are safe.
- **Gas tank monitoring**: preflight reports its balance; wire a periodic alert if it dips (so sells don't stall).
- **Single Robinhood sequencer**: no permissionless fallback yet — watch its status; the bot surfaces failures via order recovery.
- **Backups**: back up Postgres (users/positions/orders). Turnkey holds the keys, but your DB maps users→wallets.
- **Do not brand as "Robinhood"** — trademark + custodial/MTL exposure. Get legal review before public launch.
