/**
 * SELL orchestration — and the core answer to "they bought with SOL, they have no
 * ETH to pay for the sell".
 *
 * Route mirrors how the position was funded (your rule):
 *   - fundingAsset 'SOL'   : memecoin --swap--> USDG (on RH) --Relay--> SOL (Solana)
 *   - fundingAsset 'RH_ETH': memecoin --swap--> ETH  (stays on the RH wallet)
 *
 * Gas: MVP uses JIT top-up. Before the user (Turnkey) signs anything, the backend
 * pushes just-enough dust ETH from the gas tank so the approve+swap(+bridge)
 * succeeds; residual is swept back afterward. v2 replaces this with a sponsored
 * ERC-4337 UserOp (EntryPoint is live on-chain — see preflight) so no top-up is
 * needed; the interface here stays the same.
 */
import { getAddress, erc20Abi, encodeFunctionData, maxUint256, type Address } from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ADDR } from "../chain/constants.js";
import { getSwapCalldata } from "../chain/uniswap.js";
import { erc20BalanceOf, erc20Allowance } from "../chain/erc20.js";
import { encodePermit2Approve } from "../chain/universalRouter.js";
import { ensureGasForSell, sweepResidualGas, gasTankAddress, tradeFeeEnabled, tradeFee } from "../chain/gas.js";
import { rhPublic, rhWalletClientFor } from "../chain/rhchain.js";
import { getEvmAccount } from "../wallets/custody.js";
import { relayQuote, relayStatus, RELAY_ROUTES, RELAY_NATIVE } from "../bridge/relay.js";
import { createOrder, updateOrder, getPosition, addToPosition } from "../db/index.js";
import type { SellRequest, TradeResult } from "./types.js";

// Rough upper bound on gas for approve + swap + bridge-deposit. Used only to size
// the JIT top-up; actual gas is metered by the chain.
const SELL_GAS_UNITS = 450_000n;

export async function sell(req: SellRequest): Promise<TradeResult> {
  const telegramId = Number(req.user.telegram_id);
  const rhWallet = getAddress(req.user.evm_eoa!); // EOA holds tokens in MVP

  // Resolve amount: default to the full on-chain balance.
  const amount =
    req.amountTokens ?? (await erc20BalanceOf(req.tokenAddress, rhWallet));
  if (amount <= 0n) {
    return {
      orderId: "",
      status: "failed",
      txHashes: [],
      message: "Nothing to sell — token balance is 0.",
    };
  }

  const orderId = await createOrder({
    telegramId,
    side: "sell",
    fundingAsset: req.fundingAsset,
    tokenAddress: req.tokenAddress,
    tokenSymbol: req.tokenSymbol,
    amountIn: amount.toString(),
  });

  try {
    if (!config.TRADING_ENABLED) {
      throw new Error("TRADING_ENABLED=false — sell broadcasting blocked.");
    }

    // Proceeds asset on the RH swap: USDG when we'll bridge to SOL, else native ETH.
    const proceedsToken = req.fundingAsset === "SOL" ? ADDR.USDG : (RELAY_NATIVE.ETH as Address);
    const swap = await getSwapCalldata({
      tokenIn: req.tokenAddress,
      tokenOut: proceedsToken,
      amountIn: amount,
      slippageBps: req.slippageBps,
      recipient: rhWallet,
    });
    await updateOrder(orderId, {
      status: "quoted",
      quote: { quotedOut: swap.quotedOut.toString(), minOut: swap.minOut.toString() },
    });

    // --- GAS: make sure the user can pay for approve + swap (+ bridge) ---
    const gasPrice = await rhPublic.getGasPrice();
    const neededWei = SELL_GAS_UNITS * gasPrice;
    const topup = await ensureGasForSell(rhWallet, neededWei);
    if (topup.toppedUp) await updateOrder(orderId, { tx_hash: topup.txHash! });

    const account = await getEvmAccount(req.user);
    const wallet = rhWalletClientFor(account);

    // The Universal Router pulls ERC-20 input via Permit2: (1) ERC-20 approve
    // token→Permit2, (2) Permit2 AllowanceTransfer approve token→UniversalRouter.
    await ensureApproval(wallet, account, req.tokenAddress, ADDR.PERMIT2, amount);
    await ensurePermit2Router(wallet, account, req.tokenAddress, amount);

    // Snapshot USDG before the swap so we can bridge the ACTUAL amount received
    // (not swap.minOut, which would strand the slippage-buffer residual on-chain).
    const usdgBefore = req.fundingAsset === "SOL" ? await erc20BalanceOf(ADDR.USDG, rhWallet) : 0n;

    // Execute the sell swap on Robinhood Chain.
    const swapHash = await wallet.sendTransaction({
      account,
      chain: null,
      to: swap.to,
      data: swap.data,
      value: swap.value,
    });
    await updateOrder(orderId, { status: "swapping", tx_hash: swapHash });
    const rcpt = await rhPublic.waitForTransactionReceipt({ hash: swapHash });
    if (rcpt.status !== "success") {
      await updateOrder(orderId, { status: "failed", error: "sell swap reverted" });
      return { orderId, status: "failed", txHashes: [swapHash], message: "Sell swap reverted." };
    }

    const txHashes: string[] = [swapHash];
    let message: string;
    let resultStatus: TradeResult["status"] = "filled";
    let proceeds = swap.quotedOut; // fallback for RH_ETH bookkeeping

    if (req.fundingAsset === "SOL") {
      const usdgAfter = await erc20BalanceOf(ADDR.USDG, rhWallet);
      let usdgReceived = usdgAfter > usdgBefore ? usdgAfter - usdgBefore : swap.minOut;
      proceeds = usdgReceived;

      // Self-funding fee: skim 0.1% of the USDG proceeds to the gas tank (as USDG).
      if (tradeFeeEnabled()) {
        const feeUsdg = tradeFee(usdgReceived);
        if (feeUsdg > 0n && feeUsdg < usdgReceived) {
          const data = encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [gasTankAddress(), feeUsdg],
          });
          const fh = await wallet.sendTransaction({ account, chain: null, to: ADDR.USDG, data });
          await rhPublic.waitForTransactionReceipt({ hash: fh });
          txHashes.push(fh);
          usdgReceived -= feeUsdg;
        }
      }

      // Bridge the (net) USDG received back to the user's Solana wallet.
      const bridged = await bridgeUsdgToSolana(req, usdgReceived);
      txHashes.push(...bridged.hashes);
      resultStatus = bridged.status === "success" ? "filled" : "submitted";
      await updateOrder(orderId, {
        status: resultStatus === "filled" ? "filled" : "bridging",
        relay_request_id: bridged.requestId,
        amount_out: usdgReceived.toString(),
      });
      message =
        bridged.status === "success"
          ? "Sold → SOL delivered to your Solana wallet."
          : `Sold; bridging USDG→SOL is in progress (status ${bridged.status}). You'll be notified when it lands.`;

      // Recover the ETH we fronted for gas (SOL-funded users hold no ETH of their own).
      if (topup.toppedUp) {
        try {
          await sweepResidualGas(rhWallet, wallet, account, topup.amountWei);
        } catch (e) {
          logger.warn({ e, orderId }, "gas sweep failed (non-fatal)");
        }
      }
    } else {
      // Self-funding fee: skim 0.1% of the ETH proceeds to the gas tank.
      if (tradeFeeEnabled()) {
        const fee = tradeFee(swap.quotedOut);
        if (fee > 0n) {
          const fh = await wallet.sendTransaction({
            account,
            chain: null,
            to: gasTankAddress(),
            value: fee,
          });
          await rhPublic.waitForTransactionReceipt({ hash: fh });
          txHashes.push(fh);
        }
      }
      await updateOrder(orderId, { status: "filled", amount_out: swap.quotedOut.toString() });
      message = "Sold → ETH in your Robinhood Chain wallet.";
    }

    // Books: reduce the position, realize pnl against ACTUAL proceeds.
    await settlePositionOnSell(req, amount, proceeds);

    return { orderId, status: resultStatus, amountOut: proceeds, txHashes, message };
  } catch (err) {
    const message = (err as Error).message;
    await updateOrder(orderId, { status: "failed", error: message });
    logger.error({ err, orderId }, "sell failed");
    return { orderId, status: "failed", txHashes: [], message };
  }
}

async function ensureApproval(
  wallet: ReturnType<typeof rhWalletClientFor>,
  account: Awaited<ReturnType<typeof getEvmAccount>>,
  token: Address,
  spender: Address,
  amount: bigint
): Promise<void> {
  const current = await erc20Allowance(token, getAddress(account.address), spender);
  if (current >= amount) return;
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
  });
  const hash = await wallet.sendTransaction({ account, chain: null, to: token, data });
  await rhPublic.waitForTransactionReceipt({ hash });
}

const PERMIT2_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

/** Ensure Permit2 grants the Universal Router allowance to pull `token`. */
async function ensurePermit2Router(
  wallet: ReturnType<typeof rhWalletClientFor>,
  account: Awaited<ReturnType<typeof getEvmAccount>>,
  token: Address,
  amount: bigint
): Promise<void> {
  const owner = getAddress(account.address);
  const [amt, expiration] = (await rhPublic.readContract({
    address: ADDR.PERMIT2,
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [owner, token, ADDR.UNIVERSAL_ROUTER],
  })) as readonly [bigint, number, number];

  const now = Math.floor(Date.now() / 1000);
  if (amt >= amount && expiration > now + 60) return;

  const data = encodePermit2Approve(token, now + 60 * 60 * 24 * 30); // +30 days
  const hash = await wallet.sendTransaction({ account, chain: null, to: ADDR.PERMIT2, data });
  await rhPublic.waitForTransactionReceipt({ hash });
}

async function bridgeUsdgToSolana(
  req: SellRequest,
  usdgAmount: bigint
): Promise<{ hashes: string[]; requestId?: string; status: string }> {
  const rhWallet = getAddress(req.user.evm_eoa!);
  const quote = await relayQuote({
    ...(RELAY_ROUTES.rhToSol({}) as any),
    user: rhWallet,
    recipient: req.user.sol_pubkey!,
    originCurrency: ADDR.USDG,
    amount: usdgAmount.toString(),
    appFeeBps: config.APP_FEE_BPS,
  } as Parameters<typeof relayQuote>[0]);

  // Submit the EVM origin deposit tx(s) with the user's Turnkey key.
  const account = await getEvmAccount(req.user);
  const wallet = rhWalletClientFor(account);
  const hashes: string[] = [];
  for (const item of quote.originItems) {
    const d = item?.data;
    if (!d?.to || !d?.data) continue;
    const hash = await wallet.sendTransaction({
      account,
      chain: null,
      to: getAddress(d.to),
      data: d.data,
      value: BigInt(d.value ?? "0"),
    });
    await rhPublic.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  // Poll fill.
  let status = "pending";
  if (quote.requestId) {
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      status = (await relayStatus(quote.requestId)).status;
      if (["success", "refund", "failure"].includes(status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { hashes, requestId: quote.requestId, status };
}

async function settlePositionOnSell(
  req: SellRequest,
  tokensSold: bigint,
  proceeds: bigint
): Promise<void> {
  const pos = await getPosition(
    Number(req.user.telegram_id),
    req.tokenAddress,
    req.fundingAsset
  );
  if (!pos) return;
  // Reduce token balance; realize proportional pnl (proceeds vs cost slice).
  const held = BigInt(pos.amount_tokens);
  const cost = BigInt(pos.cost_basis);
  const soldCost = held > 0n ? (cost * tokensSold) / held : 0n;
  await addToPosition({
    telegramId: Number(req.user.telegram_id),
    tokenAddress: req.tokenAddress,
    fundingAsset: req.fundingAsset,
    tokenSymbol: req.tokenSymbol,
    tokensDelta: (-tokensSold).toString(),
    costDelta: (-soldCost).toString(),
  });
  logger.info(
    { token: req.tokenAddress, tokensSold: tokensSold.toString(), proceeds: proceeds.toString() },
    "position settled on sell"
  );
}
