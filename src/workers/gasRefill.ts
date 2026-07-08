/**
 * Gas-tank auto-refill. SOL-sell fees accrue to the gas tank as USDG; buys/RH-sells
 * accrue as ETH. When the tank's ETH runs low, this worker converts its USDG to ETH
 * so gas is self-sustaining and hands-off.
 *
 * Limitation: the swap itself costs gas, so the tank can only self-refill while it
 * still holds a little ETH. If it ever hits ~0 ETH it needs a manual top-up — so
 * keep a small ETH floor in it.
 */
import { getAddress, encodeFunctionData, erc20Abi, maxUint256, type Address, type WalletClient, type Account } from "viem";
import { rhPublic, getGasTankWallet } from "../chain/rhchain.js";
import { erc20BalanceOf, erc20Allowance } from "../chain/erc20.js";
import { getSwapCalldata } from "../chain/uniswap.js";
import { encodePermit2Approve } from "../chain/universalRouter.js";
import { ADDR } from "../chain/constants.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;
const REFILL_BELOW_WEI = 5_000_000_000_000_000n; // top up when ETH < 0.005
const MIN_USDG = 1_000_000n; // 1 USDG (6 decimals) — don't swap dust

export async function refillGasTank(): Promise<void> {
  if (!config.GAS_TANK_PRIVATE_KEY || !config.TRADING_ENABLED) return;

  const { wallet, account } = getGasTankWallet();
  const tank = getAddress(account.address);

  const eth = await rhPublic.getBalance({ address: tank });
  if (eth >= REFILL_BELOW_WEI) return; // enough gas already

  const usdg = await erc20BalanceOf(ADDR.USDG, tank);
  if (usdg < MIN_USDG) return; // nothing worth converting

  // Need a little ETH to pay for the swap itself; can't bootstrap from absolute 0.
  const gasPrice = await rhPublic.getGasPrice();
  if (eth < 400_000n * gasPrice) {
    logger.warn({ tank, eth: eth.toString() }, "gas tank ETH too low to self-refill — needs a manual ETH top-up");
    return;
  }

  logger.info({ tank, usdg: usdg.toString() }, "gas tank low — converting accumulated USDG to ETH");
  await ensureApproval(wallet, account, ADDR.USDG, ADDR.PERMIT2);
  await ensurePermit2Router(wallet, account, ADDR.USDG, usdg);

  const swap = await getSwapCalldata({
    tokenIn: ADDR.USDG,
    tokenOut: NATIVE,
    amountIn: usdg,
    slippageBps: 1500,
    recipient: tank,
  });
  const hash = await wallet.sendTransaction({ account, chain: null, to: swap.to, data: swap.data, value: 0n });
  const rcpt = await rhPublic.waitForTransactionReceipt({ hash });
  logger.info({ hash, status: rcpt.status }, "gas tank USDG→ETH refill complete");
}

async function ensureApproval(wallet: WalletClient, account: Account, token: Address, spender: Address): Promise<void> {
  const owner = getAddress(account.address);
  if ((await erc20Allowance(token, owner, spender)) >= maxUint256 / 2n) return;
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
  const hash = await wallet.sendTransaction({ account, chain: null, to: token, data });
  await rhPublic.waitForTransactionReceipt({ hash });
}

const PERMIT2_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "token", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] },
] as const;

async function ensurePermit2Router(wallet: WalletClient, account: Account, token: Address, amount: bigint): Promise<void> {
  const owner = getAddress(account.address);
  const [amt, expiration] = (await rhPublic.readContract({
    address: ADDR.PERMIT2, abi: PERMIT2_ALLOWANCE_ABI, functionName: "allowance",
    args: [owner, token, ADDR.UNIVERSAL_ROUTER],
  })) as readonly [bigint, number, number];
  const now = Math.floor(Date.now() / 1000);
  if (amt >= amount && expiration > now + 60) return;
  const data = encodePermit2Approve(token, now + 60 * 60 * 24 * 30);
  const hash = await wallet.sendTransaction({ account, chain: null, to: ADDR.PERMIT2, data });
  await rhPublic.waitForTransactionReceipt({ hash });
}
