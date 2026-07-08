# xchain-memebot

Telegram bot to **buy and sell Robinhood Chain memecoins**, funded from **Solana (SOL)** or **Robinhood-Chain ETH** — bot creates and manages both wallets per user. **Mainnet** (chain id `4663` / `0x1237`).

> ⚠️ This trades real value on a young chain. `TRADING_ENABLED=false` by default — the bot onboards, quotes, screens and shows balances but will **not broadcast a trade** until you flip it on *after* `npm run preflight` passes.

## What it does (v1 scope)

- **Onboard** — `/start` creates a Solana wallet + a Robinhood-Chain (EVM) wallet via Turnkey (per-user isolated sub-org).
- **Buy** — paste a token contract → pick **SOL** (cross-chain via Relay, one signature) or **RH-ETH** (same-chain Uniswap swap) → amount. Token is screened for honeypot/tax first.
- **Sell** — `/positions` → Sell. Proceeds come back **in whatever you bought with**: SOL→SOL, RH-ETH→ETH.
- **No gas to sell?** Handled: the backend does a just-in-time dust-ETH top-up (MVP) so a gas-less user can still sell; v2 swaps this for a sponsored ERC-4337 UserOp (EntryPoint is live on-chain).
- **Balances / withdraw** — `/wallet`, `/withdraw` (with a safety delay).

## Architecture

```
Telegram (grammY)
  └─ handlers → onboarding, buy/sell flows, positions
        ├─ wallets/turnkey.ts   custody: per-user sub-org, SOL+EVM signers  [needs keys]
        ├─ bridge/relay.ts      Solana ⇄ Robinhood Chain rail + appFees
        ├─ chain/uniswap.ts     v4 quoting (on-chain) + exec calldata (Trading API)
        ├─ chain/screen.ts      honeypot / tax screening (gate every buy)
        ├─ chain/gas.ts         JIT ETH top-up (sell-without-gas, MVP)
        └─ db/ (Postgres)       users, orders (resumable), positions, fees
```

## Setup

```bash
npm install
cp .env.example .env          # fill in as keys arrive
npm run db:init               # apply Postgres schema
npm run preflight             # MANDATORY before trading: verifies chain 4663 + contracts
npm run dev                   # start the bot
```

## Keys you (the operator) provide

| Env | For | Status |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot | you'll provide |
| `TURNKEY_*` | custody / signing (both chains) | you'll provide |
| `ALCHEMY_RH_RPC_URL` | reliable RPC + future 4337 bundler | you'll provide |
| `SOLANA_RPC_URL_PAID` | avoid public-RPC rate limits | you'll provide |
| `GAS_TANK_PRIVATE_KEY` | isolated wallet that fronts sell-gas | you'll provide |
| `FEE_TREASURY_EVM` | collects your affiliate fees | you'll provide |
| `DATABASE_URL` | Postgres | you'll provide |

The app boots without these; each subsystem throws a clear "missing env X" only when actually used.

## Integration seams (status)

Validated live against the public APIs where possible (searchable: `[VERIFY]` for what remains):

- ✅ **Relay** (`bridge/relay.ts`, `trade/buy.ts`) — CONFIRMED live: Robinhood Chain (4663) and Solana (792703809) are both listed with the exact native markers we use; the quote response shape is confirmed and the code is fixed to match (requestId is read from `item.check.endpoint`; the Solana origin is assembled from `data.instructions[]`+ALTs into a v0 `VersionedTransaction` — validated end-to-end against a real quote, only the Turnkey signature is missing).
- ✅ **USDG decimals = 6** — confirmed via a live quote (0.01 ETH ≈ 17.5 USDG).
- ✅ **Swap engine = on-chain Uniswap V3** (`chain/uniswap.ts`, `chain/universalRouter.ts`) — reverse-engineered from real successful swaps: the tradable liquidity is on **V3** (WETH-based), not v4 (v4 pools quote but barely trade). Pool discovery via the V3 Factory (`0x1f7d…2EfA`), pricing from pool `slot0`, execution via Universal Router V3 calldata (`WRAP_ETH`+`V3_SWAP_EXACT_IN` for buys). **The BUY path is validated end-to-end via eth_call on mainnet** (ETH→USDG and ETH→memecoin both execute). Note: this UR requires the 6-field `V3_SWAP_EXACT_IN` encoding with a trailing empty `bytes` — byte-identical to real swaps; don't "simplify" it.
  - ⚠️ Remaining: the **SELL** builders (`buildV3SellToEth`/`buildV3SellToToken`, same confirmed encoding + Permit2) still need a live validation with a real token + Permit2 allowance. Pricing uses `slot0` spot (conservative + slippage-protected); a QuoterV2 can be added for exact-output pricing.
- ⚠️ **Turnkey** (`wallets/turnkey.ts`) — confirm `createSubOrganization` field names on your installed `@turnkey/sdk-server` major (needs your Turnkey keys).
- ⚠️ **Permit2 / approvals** (`trade/sell.ts`) — confirm whether the swap calldata expects a fresh Permit2 signature vs. a standing approval (needs a live sell).

Each is isolated to one function; nothing else changes when confirmed.

## Roadmap

- **v2 gasless sell** — replace JIT top-up with a sponsored ERC-4337 UserOp (Alchemy Gas Manager / ZeroDev), batched approve→swap→bridge, gas recouped from USDG proceeds. Charge repayment in the **validation** phase (OtterSec drain guard).
- Redis sessions, sequencer-outage handling + third-party RPC failover, full refund state machine, withdrawal 2FA broadcast, pen-test + legal review.

## Safety notes

- Custodial hot-wallet by nature — real safety = Turnkey TEE keys + per-user sub-orgs + policy engine + hardened Telegram surface (the historically-exploited layer). Do **not** brand this "Robinhood".
