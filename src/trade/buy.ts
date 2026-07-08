/**
 * BUY orchestration.
 *
 *  - fundingAsset = 'RH_ETH': same-chain. Plain Uniswap swap of native ETH ->
 *                             memecoin on Robinhood Chain. No bridge.
 *  - fundingAsset = 'SOL'   : cross-chain. User signs ONE Solana tx; Relay bridges
 *                             native ETH to the user's RH wallet (solver pays
 *                             destination gas). We THEN swap the delivered ETH ->
 *                             memecoin same-chain, with a real slippage floor.
 *                             If that swap fails, the user simply keeps the
 *                             bridged ETH (safe settlement) — no funds lost.
 *
 * Both paths record the ACTUAL on-chain token balance delta into the position
 * (never a placeholder quote), so books + PnL stay correct.
 *
 * Every step is persisted to `orders` so a crash is resumable.
 */
import {
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  PublicKey,
} from "@solana/web3.js";
import { getAddress, type Address } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getSwapCalldata } from "../chain/uniswap.js";
import { erc20BalanceOf } from "../chain/erc20.js";
import { gasTankAddress, tradeFeeEnabled, tradeFee } from "../chain/gas.js";
import { relayQuote, relayStatus, RELAY_ROUTES, RELAY_NATIVE } from "../bridge/relay.js";
import { signSolanaTx, getEvmAccount } from "../wallets/custody.js";
import { rhWalletClientFor, rhPublic } from "../chain/rhchain.js";
import { solana } from "../chain/solana.js";
import { createOrder, updateOrder, addToPosition, type UserRow } from "../db/index.js";
import type { BuyRequest, TradeResult } from "./types.js";

// ETH left behind (out of the bridged amount) to pay for the destination swap's gas.
const BUY_GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 ETH

function assertTradingEnabled() {
  if (!config.TRADING_ENABLED) {
    throw new Error(
      "TRADING_ENABLED=false — quoting works but broadcasting is blocked. " +
        "Flip it on only after `npm run preflight` passes and you've said go."
    );
  }
}

export async function buy(req: BuyRequest): Promise<TradeResult> {
  const telegramId = Number(req.user.telegram_id);
  const orderId = await createOrder({
    telegramId,
    side: "buy",
    fundingAsset: req.fundingAsset,
    tokenAddress: req.tokenAddress,
    tokenSymbol: req.tokenSymbol,
    amountIn: req.amountInBase.toString(),
  });

  try {
    assertTradingEnabled();
    if (req.fundingAsset === "RH_ETH") {
      return await buySameChain(req, orderId);
    }
    return await buyFromSolana(req, orderId);
  } catch (err) {
    const message = (err as Error).message;
    await updateOrder(orderId, { status: "failed", error: message });
    logger.error({ err, orderId }, "buy failed");
    return { orderId, status: "failed", txHashes: [], message };
  }
}

/**
 * Swap native ETH -> memecoin on Robinhood Chain and return the REAL token amount
 * received (on-chain balance delta). Uses a genuine minOut because amountIn is the
 * real ETH amount. Throws if the swap reverts.
 */
async function swapEthForToken(
  user: UserRow,
  tokenAddress: Address,
  ethAmount: bigint,
  slippageBps: number,
  rhWallet: Address
): Promise<{ hash: `0x${string}`; tokenDelta: bigint }> {
  const account = await getEvmAccount(user);
  const wallet = rhWalletClientFor(account);

  // Self-funding fee: send a slice of the input ETH to the gas tank, swap the rest.
  let swapAmountIn = ethAmount;
  if (tradeFeeEnabled()) {
    const fee = tradeFee(ethAmount);
    if (fee > 0n && fee < ethAmount) {
      const feeHash = await wallet.sendTransaction({
        account,
        chain: null,
        to: gasTankAddress(),
        value: fee,
      });
      await rhPublic.waitForTransactionReceipt({ hash: feeHash });
      swapAmountIn = ethAmount - fee;
    }
  }

  const swap = await getSwapCalldata({
    tokenIn: RELAY_NATIVE.ETH as Address,
    tokenOut: tokenAddress,
    amountIn: swapAmountIn,
    slippageBps,
    recipient: rhWallet,
  });
  const balBefore = await erc20BalanceOf(tokenAddress, rhWallet);
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    to: swap.to,
    data: swap.data,
    value: swapAmountIn,
  });
  const rcpt = await rhPublic.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("destination swap tx reverted");
  const balAfter = await erc20BalanceOf(tokenAddress, rhWallet);
  return { hash, tokenDelta: balAfter - balBefore };
}

/** RH-ETH → memecoin, single same-chain Uniswap swap. */
async function buySameChain(req: BuyRequest, orderId: string): Promise<TradeResult> {
  const rhWallet = getAddress(req.user.evm_eoa!);
  await updateOrder(orderId, { status: "quoted" });

  const { hash, tokenDelta } = await swapEthForToken(
    req.user,
    req.tokenAddress,
    req.amountInBase,
    req.slippageBps,
    rhWallet
  );
  if (tokenDelta <= 0n) {
    await updateOrder(orderId, { status: "failed", error: "received 0 tokens" });
    return { orderId, status: "failed", txHashes: [hash], message: "Swap returned no tokens." };
  }

  await updateOrder(orderId, { status: "filled", tx_hash: hash, amount_out: tokenDelta.toString() });
  await addToPosition({
    telegramId: Number(req.user.telegram_id),
    tokenAddress: req.tokenAddress,
    fundingAsset: "RH_ETH",
    tokenSymbol: req.tokenSymbol,
    tokensDelta: tokenDelta.toString(),
    costDelta: req.amountInBase.toString(),
  });
  return { orderId, status: "filled", amountOut: tokenDelta, txHashes: [hash], message: "Bought (same-chain)." };
}

/** SOL → (bridge native ETH) → same-chain swap ETH → memecoin. */
async function buyFromSolana(req: BuyRequest, orderId: string): Promise<TradeResult> {
  const rhWallet = getAddress(req.user.evm_eoa!);
  const ethBefore = await rhPublic.getBalance({ address: rhWallet });

  // Deliver native ETH cross-chain (solver pays destination gas). We do NOT attach
  // a 0-input destination swap (that had no slippage floor) — we swap afterwards
  // with the real delivered amount.
  const quote = await relayQuote({
    ...(RELAY_ROUTES.solToRh({}) as Required<
      Pick<Parameters<typeof relayQuote>[0], "originChainId" | "destinationChainId" | "originCurrency">
    >),
    user: req.user.sol_pubkey!,
    recipient: rhWallet,
    destinationCurrency: RELAY_NATIVE.ETH as string,
    amount: req.amountInBase.toString(),
    appFeeBps: config.APP_FEE_BPS,
  } as Parameters<typeof relayQuote>[0]);

  await updateOrder(orderId, {
    status: "quoted",
    relay_request_id: quote.requestId,
    quote: { relayFees: quote.raw.fees ?? null },
  });

  // User's single signature: the Solana origin deposit.
  const originHashes = await submitSolanaOrigin(req, quote.originItems);
  for (const h of originHashes) await updateOrder(orderId, { tx_hash: h });
  await updateOrder(orderId, { status: "bridging" });

  const final = await pollRelay(quote.requestId);
  if (final === "refund" || final === "failure") {
    await updateOrder(orderId, { status: "refunded", error: `relay ${final}` });
    return {
      orderId,
      status: "refunded",
      txHashes: originHashes,
      message: `Bridge didn't fill (status: ${final}). Funds were refunded/settled.`,
    };
  }
  if (final !== "success") {
    // Still pending past our poll window — NOT a refund. Leave the order in
    // 'bridging' so the recovery worker reconciles/finishes it, and tell the user.
    return {
      orderId,
      status: "submitted",
      txHashes: originHashes,
      message:
        "Your bridge is taking longer than usual. Your funds are safe and on the way — " +
        "I'll finish this and notify you when it lands. Check /positions shortly.",
    };
  }

  // ETH delivered — swap it into the memecoin with a REAL slippage floor.
  const ethAfter = await rhPublic.getBalance({ address: rhWallet });
  const delivered = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
  const swapAmount = delivered > BUY_GAS_RESERVE_WEI ? delivered - BUY_GAS_RESERVE_WEI : 0n;

  if (swapAmount <= 0n) {
    await updateOrder(orderId, { status: "filled", error: "delivered amount too small to swap" });
    return {
      orderId,
      status: "filled",
      txHashes: originHashes,
      message: "Bridged, but the amount is too small to swap — the ETH is in your Robinhood wallet.",
    };
  }

  await updateOrder(orderId, { status: "swapping" });
  try {
    const { hash, tokenDelta } = await swapEthForToken(
      req.user,
      req.tokenAddress,
      swapAmount,
      req.slippageBps,
      rhWallet
    );
    if (tokenDelta <= 0n) throw new Error("swap returned 0 tokens");
    await updateOrder(orderId, { status: "filled", tx_hash: hash, amount_out: tokenDelta.toString() });
    // Record the SOL cost against the REAL token amount, so books/PnL stay correct.
    await addToPosition({
      telegramId: Number(req.user.telegram_id),
      tokenAddress: req.tokenAddress,
      fundingAsset: "SOL",
      tokenSymbol: req.tokenSymbol,
      tokensDelta: tokenDelta.toString(),
      costDelta: req.amountInBase.toString(),
    });
    return {
      orderId,
      status: "filled",
      amountOut: tokenDelta,
      txHashes: [...originHashes, hash],
      message: "Bought (SOL → Robinhood Chain).",
    };
  } catch (err) {
    // Swap failed (slippage/liquidity/honeypot). User keeps the bridged ETH.
    await updateOrder(orderId, {
      status: "filled",
      error: `destination swap failed: ${(err as Error).message}`,
    });
    logger.warn({ err, orderId }, "SOL buy: destination swap failed, ETH left in wallet");
    return {
      orderId,
      status: "filled",
      txHashes: originHashes,
      message:
        "Bridged ETH delivered, but the swap into the token failed (slippage/liquidity). " +
        "Your ETH is safe in your Robinhood wallet — try again.",
    };
  }
}

/**
 * Submit the Relay origin transaction on Solana. Confirmed against the live Relay
 * API: each origin item carries `data.instructions[]` ({keys, programId, hex data})
 * plus `data.addressLookupTableAddresses[]`. We assemble a v0 VersionedTransaction
 * (payer = the user's Solana wallet), Turnkey-sign, and broadcast.
 */
async function submitSolanaOrigin(req: BuyRequest, items: any[]): Promise<string[]> {
  const hashes: string[] = [];
  const payer = new PublicKey(req.user.sol_pubkey!);

  for (const item of items) {
    const d = item?.data;
    if (!d?.instructions?.length) {
      logger.warn({ item }, "Relay origin item without Solana instructions — skipping");
      continue;
    }

    // Resolve any address lookup tables the instructions reference.
    const alts = [];
    for (const addr of (d.addressLookupTableAddresses as string[]) ?? []) {
      const res = await solana.getAddressLookupTable(new PublicKey(addr));
      if (res.value) alts.push(res.value);
    }

    const instructions = (d.instructions as any[]).map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: (ix.keys as any[]).map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: !!k.isSigner,
            isWritable: !!k.isWritable,
          })),
          data: Buffer.from(String(ix.data).replace(/^0x/, ""), "hex"),
        })
    );

    const { blockhash } = await solana.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(alts);
    const tx = new VersionedTransaction(message);

    await signSolanaTx(req.user, tx);
    const sig = await solana.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await solana.confirmTransaction(sig, "confirmed");
    hashes.push(sig);
  }

  if (hashes.length === 0) throw new Error("No Solana origin instructions to submit.");
  return hashes;
}

async function pollRelay(requestId: string | undefined, timeoutMs = 90_000): Promise<string> {
  if (!requestId) throw new Error("Relay quote returned no requestId to poll.");
  const start = Date.now();
  for (let attempt = 0; Date.now() - start < timeoutMs; attempt++) {
    const { status } = await relayStatus(requestId);
    if (["success", "refund", "failure"].includes(status)) return status;
    await new Promise((r) => setTimeout(r, Math.min(1000 + attempt * 500, 5000)));
  }
  return "pending";
}
