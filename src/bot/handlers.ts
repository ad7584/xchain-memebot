/**
 * Telegram command + callback handlers (grammY).
 *
 * Buy UX (per your decision — paste contract address):
 *   /buy → "paste the contract" → bot screens it → inline [SOL] / [RH-ETH]
 *        → "enter amount" → confirm → execute.
 * Sell UX: /positions lists holdings with a Sell button each (mirrors funding).
 */
import { InlineKeyboard, type Context, type SessionFlavor } from "grammy";
import { isAddress, parseEther, parseUnits, getAddress } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getOrCreateUser, getBalances } from "./wallets.js";
import { screenToken } from "../chain/screen.js";
import { buy } from "../trade/buy.js";
import { sell } from "../trade/sell.js";
import { setup2FA, requestWithdrawal, has2FA } from "../trade/withdraw.js";
import { solToLamports } from "../chain/solana.js";
import type { FundingAsset, WithdrawChain } from "../db/index.js";

export interface SessionData {
  flow?: "await_contract" | "await_amount";
  pendingToken?: { address: `0x${string}`; symbol: string; decimals: number };
  pendingFunding?: FundingAsset;
}
export type MyContext = Context & SessionFlavor<SessionData>;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function registerHandlers(bot: { command: any; on: any; callbackQuery: any; catch: any }) {
  // /start — onboard
  bot.command("start", async (ctx: MyContext) => {
    try {
      const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
      await ctx.reply(
        `👋 *Welcome.*\n\nI gave you two wallets:\n\n` +
          `🟪 *Solana* (fund this to buy)\n\`${user.sol_pubkey}\`\n\n` +
          `🔶 *Robinhood Chain* (your memecoins land here)\n\`${user.evm_eoa}\`\n\n` +
          `Send SOL to your Solana address, then /buy.\n` +
          `Commands: /buy · /positions · /wallet · /withdraw · /help`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await onboardingError(ctx, err);
    }
  });

  bot.command("help", async (ctx: MyContext) => {
    await ctx.reply(
      `*How it works*\n\n` +
        `• Fund your Solana wallet with SOL (or your RH wallet with ETH).\n` +
        `• /buy → paste a token contract → pick *SOL* or *RH-ETH* → amount.\n` +
        `• /positions → tap *Sell*. You get back whatever you bought with:\n` +
        `   bought with SOL → you receive SOL; bought with RH-ETH → you receive ETH.\n` +
        `• No ETH for gas on a sell? Handled automatically.\n` +
        `• /withdraw → send funds out (${Math.round(
          config.WITHDRAWAL_DELAY_SECONDS / 3600
        )}h safety delay).`,
      { parse_mode: "Markdown" }
    );
  });

  // /wallet — balances + positions
  bot.command(["wallet", "balance"], async (ctx: MyContext) => {
    try {
      const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
      const b = await getBalances(user);
      const pos =
        b.positions.length === 0
          ? "_none yet_"
          : b.positions
              .map((p) => `• *${p.symbol}* — ${p.amount} (via ${p.funding})`)
              .join("\n");
      await ctx.reply(
        `*Your wallets*\n\n` +
          `🟪 Solana \`${short(b.solAddress)}\` — *${b.solBalance.toFixed(4)} SOL*\n` +
          `🔶 RH Chain \`${short(b.evmAddress)}\` — *${(+b.ethBalance).toFixed(5)} ETH*, ${(+b.usdgBalance).toFixed(2)} USDG\n\n` +
          `*Positions*\n${pos}`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await onboardingError(ctx, err);
    }
  });

  // /buy — start the paste-contract flow
  bot.command("buy", async (ctx: MyContext) => {
    ctx.session.flow = "await_contract";
    ctx.session.pendingToken = undefined;
    ctx.session.pendingFunding = undefined;
    await ctx.reply("📋 Paste the *token contract address* you want to buy.", {
      parse_mode: "Markdown",
    });
  });

  // /positions — list with Sell buttons
  bot.command("positions", async (ctx: MyContext) => {
    try {
      const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
      const b = await getBalances(user);
      if (b.positions.length === 0) {
        await ctx.reply("You have no open positions. /buy to start.");
        return;
      }
      for (const p of b.positions) {
        const kb = new InlineKeyboard()
          .text("Sell 50%", `sell:${p.address}:${p.funding}:50`)
          .text("Sell 100%", `sell:${p.address}:${p.funding}:100`);
        await ctx.reply(
          `*${p.symbol}* — ${p.amount}\nfunded via *${p.funding}* → sell returns ${
            p.funding === "SOL" ? "SOL" : "ETH"
          }`,
          { parse_mode: "Markdown", reply_markup: kb }
        );
      }
    } catch (err) {
      await onboardingError(ctx, err);
    }
  });

  // /enable2fa — provision a TOTP secret for withdrawals
  bot.command("enable2fa", async (ctx: MyContext) => {
    try {
      const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
      const s = await setup2FA(user);
      await ctx.reply(
        `🔐 *2FA enabled.*\n\nAdd this to your authenticator app (Google Authenticator, Authy, 1Password):\n\n` +
          `Secret: \`${s.secret}\`\n\nOr use this link:\n\`${s.otpauthUrl}\`\n\n` +
          `You'll enter a 6-digit code with every withdrawal.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await onboardingError(ctx, err);
    }
  });

  // /withdraw <SOL|ETH|tokenAddress> <amount> <destination> <2fa_code>
  bot.command("withdraw", async (ctx: MyContext) => {
    try {
      const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
      const parts = (ctx.match as string | undefined)?.trim().split(/\s+/).filter(Boolean) ?? [];
      if (parts.length < 4) {
        await ctx.reply(
          `Usage: \`/withdraw <SOL|ETH|tokenAddress> <amount> <destination> <2FA code>\`\n\n` +
            `• \`SOL\` → to a Solana address\n• \`ETH\` or a token address → to a Robinhood-Chain address\n` +
            `Executes after a *${Math.round(config.WITHDRAWAL_DELAY_SECONDS / 3600)}h* safety delay.` +
            (has2FA(user) ? "" : "\n\n⚠️ Run /enable2fa first."),
          { parse_mode: "Markdown" }
        );
        return;
      }
      const [assetRaw, amount, destination, code] = parts as [string, string, string, string];
      const assetUpper = assetRaw.toUpperCase();
      const chain: WithdrawChain = assetUpper === "SOL" ? "SOL" : "RH";
      const asset = assetUpper === "SOL" ? "SOL" : assetUpper === "ETH" ? "ETH" : assetRaw;

      const res = await requestWithdrawal({
        user,
        chain,
        asset,
        amountHuman: amount,
        destination,
        totp: code,
      });
      if (!res.ok) {
        await ctx.reply(`⚠️ ${res.error}`);
        return;
      }
      const eta = Math.round(config.WITHDRAWAL_DELAY_SECONDS / 3600);
      await ctx.reply(
        `✅ Withdrawal queued: *${amount} ${assetUpper === "SOL" ? "SOL" : assetUpper === "ETH" ? "ETH" : "token"}* → ${destination.slice(0, 8)}…\n` +
          `It will send in ~${eta}h (safety delay). You'll get a confirmation.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await onboardingError(ctx, err);
    }
  });

  // Text handler drives the multi-step flows.
  bot.on("message:text", async (ctx: MyContext) => {
    const text = (ctx.message?.text ?? "").trim();

    if (ctx.session.flow === "await_contract") {
      await handleContractPaste(ctx, text);
      return;
    }
    if (ctx.session.flow === "await_amount") {
      await handleAmount(ctx, text);
      return;
    }
    // Convenience: pasting an address any time starts a buy.
    if (isAddress(text)) {
      ctx.session.flow = "await_contract";
      await handleContractPaste(ctx, text);
    }
  });

  // Funding choice + sell callbacks
  bot.on("callback_query:data", async (ctx: MyContext) => {
    const data = ctx.callbackQuery!.data!;
    try {
      if (data.startsWith("fund:")) {
        const funding = data.split(":")[1] as FundingAsset;
        ctx.session.pendingFunding = funding;
        ctx.session.flow = "await_amount";
        await ctx.answerCallbackQuery();
        await ctx.reply(
          funding === "SOL"
            ? "Enter the *amount of SOL* to spend (e.g. `0.5`)."
            : "Enter the *amount of ETH* to spend (e.g. `0.05`).",
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (data.startsWith("sell:")) {
        await ctx.answerCallbackQuery();
        await handleSell(ctx, data);
        return;
      }
      await ctx.answerCallbackQuery();
    } catch (err) {
      logger.error({ err }, "callback handler error");
      await ctx.reply(`⚠️ ${(err as Error).message}`);
    }
  });
}

async function handleContractPaste(ctx: MyContext, text: string) {
  if (!isAddress(text)) {
    await ctx.reply("That doesn't look like a valid contract address. Try again.");
    return;
  }
  await ctx.reply("🔎 Screening token…");
  const result = await screenToken(text);
  if (!result.ok || !result.token) {
    await ctx.reply(
      `🚫 *Not safe to trade:*\n${result.reasons.map((r) => `• ${r}`).join("\n")}`,
      { parse_mode: "Markdown" }
    );
    ctx.session.flow = undefined;
    return;
  }
  ctx.session.pendingToken = {
    address: getAddress(text),
    symbol: result.token.symbol,
    decimals: result.token.decimals,
  };
  const tax =
    result.roundTripTaxBps != null
      ? `\nEst. round-trip cost ~${(result.roundTripTaxBps / 100).toFixed(1)}%`
      : "";
  const kb = new InlineKeyboard()
    .text("Pay with SOL", "fund:SOL")
    .text("Pay with RH-ETH", "fund:RH_ETH");
  await ctx.reply(
    `✅ *${result.token.symbol}* — ${result.token.name}\n\`${result.token.address}\`${tax}\n\nHow do you want to pay?`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

async function handleAmount(ctx: MyContext, text: string) {
  const token = ctx.session.pendingToken;
  const funding = ctx.session.pendingFunding;
  if (!token || !funding) {
    ctx.session.flow = undefined;
    await ctx.reply("Something expired — start again with /buy.");
    return;
  }
  const num = Number(text.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(num) || num <= 0) {
    await ctx.reply("Enter a positive number, e.g. `0.5`.", { parse_mode: "Markdown" });
    return;
  }

  const amountInBase = funding === "SOL" ? solToLamports(num) : parseEther(String(num));
  const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);
  ctx.session.flow = undefined;

  await ctx.reply(`⏳ Buying *${token.symbol}* with ${num} ${funding === "SOL" ? "SOL" : "ETH"}…`, {
    parse_mode: "Markdown",
  });
  const res = await buy({
    user,
    fundingAsset: funding,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    amountInBase,
    slippageBps: config.DEFAULT_SLIPPAGE_BPS,
  });
  await ctx.reply(
    (res.status === "filled" ? "✅ " : res.status === "refunded" ? "↩️ " : "❌ ") +
      res.message +
      (res.txHashes.length ? `\n\`${res.txHashes[res.txHashes.length - 1]}\`` : ""),
    { parse_mode: "Markdown" }
  );
}

async function handleSell(ctx: MyContext, data: string) {
  const [, address, funding, pctStr] = data.split(":");
  const pct = Number(pctStr);
  const user = await getOrCreateUser(ctx.from!.id, ctx.from!.username);

  await ctx.reply(`⏳ Selling ${pct}%…`);
  // amountTokens omitted for 100% → sell.ts reads full on-chain balance.
  let amountTokens: bigint | undefined;
  if (pct < 100) {
    const { erc20BalanceOf } = await import("../chain/erc20.js");
    const bal = await erc20BalanceOf(getAddress(address!), getAddress(user.evm_eoa!));
    amountTokens = (bal * BigInt(pct)) / 100n;
  }

  const res = await sell({
    user,
    fundingAsset: funding as FundingAsset,
    tokenAddress: getAddress(address!),
    amountTokens,
    slippageBps: config.DEFAULT_SLIPPAGE_BPS,
  });
  await ctx.reply(
    (res.status === "filled" ? "✅ " : "❌ ") +
      res.message +
      (res.txHashes.length ? `\n\`${res.txHashes[res.txHashes.length - 1]}\`` : ""),
    { parse_mode: "Markdown" }
  );
}

async function onboardingError(ctx: MyContext, err: unknown) {
  const msg = (err as Error).message;
  logger.error({ err }, "onboarding/handler error");
  if (msg.includes("turnkey") || msg.includes("Turnkey")) {
    await ctx.reply(
      "🔧 Wallet provisioning isn't enabled yet (Turnkey keys pending). " +
        "Everything else is wired — this lights up the moment those keys are in."
    );
  } else {
    await ctx.reply(`⚠️ ${msg}`);
  }
}
