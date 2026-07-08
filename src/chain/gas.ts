/**
 * Just-in-time gas top-up — the MVP solution to "user has memecoins but no ETH
 * to pay for the sell". Because the backend custodies the user's EVM key, we can:
 *   1. estimate the sell's gas cost,
 *   2. if the user lacks ETH, push exactly enough (capped) from an ISOLATED
 *      gas-tank wallet,
 *   3. run the sell,
 *   4. sweep the residual ETH back.
 *
 * The gas tank is a separate blast-radius surface: keep it low-balance,
 * rate-limited, and monitored. Hard cap per top-up = GAS_TANK_MAX_TOPUP_WEI.
 */
import { type Address, type WalletClient, type Account } from "viem";
import { rhPublic, getGasTankWallet } from "./rhchain.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

const HEADROOM_BPS = 2500; // fund 125% of the estimate to absorb gas spikes

export interface TopUpResult {
  toppedUp: boolean;
  amountWei: bigint;
  txHash?: `0x${string}`;
}

/** Ensure `user` holds at least `neededWei` ETH; top up from the tank if not. */
export async function ensureGasForSell(
  user: Address,
  neededWei: bigint
): Promise<TopUpResult> {
  const bal = await rhPublic.getBalance({ address: user });
  const target = (neededWei * BigInt(10_000 + HEADROOM_BPS)) / 10_000n;
  if (bal >= target) return { toppedUp: false, amountWei: 0n };

  let amount = target - bal;
  if (amount > config.GAS_TANK_MAX_TOPUP_WEI) {
    // Refuse to push more than the guard allows — surfaces a bad gas estimate.
    logger.warn(
      { user, amount, cap: config.GAS_TANK_MAX_TOPUP_WEI },
      "gas top-up exceeds cap; clamping"
    );
    amount = config.GAS_TANK_MAX_TOPUP_WEI;
  }

  const { wallet, account } = getGasTankWallet();
  const tankBal = await rhPublic.getBalance({ address: account.address });
  if (tankBal <= amount) {
    throw new Error(
      `Gas tank too low: has ${tankBal} wei, needs to send ${amount}. Refill the tank.`
    );
  }

  const txHash = await wallet.sendTransaction({
    account,
    chain: null,
    to: user,
    value: amount,
  });
  await rhPublic.waitForTransactionReceipt({ hash: txHash });
  logger.info({ user, amount: amount.toString(), txHash }, "gas top-up sent");
  return { toppedUp: true, amountWei: amount, txHash };
}

/**
 * After a sell, sweep the user's leftover ETH (minus the sweep's own gas) back to
 * the gas tank. Only call this for SOL-funded users, who hold no ETH of their own
 * — the residual is entirely our earlier top-up. `wallet`/`account` are the user's
 * Turnkey-backed viem signer. Returns null if the dust isn't worth sweeping.
 */
export async function sweepResidualGas(
  userEvm: Address,
  wallet: WalletClient,
  account: Account
): Promise<`0x${string}` | null> {
  const tank = getGasTankWallet().account.address;
  const bal = await rhPublic.getBalance({ address: userEvm });
  const gasPrice = await rhPublic.getGasPrice();
  const sweepCost = 21_000n * gasPrice;
  if (bal <= sweepCost * 2n) return null; // dust not worth a tx
  const value = bal - sweepCost * 2n;
  const hash = await wallet.sendTransaction({ account, chain: null, to: tank, value });
  await rhPublic.waitForTransactionReceipt({ hash });
  logger.info({ userEvm, value: value.toString(), hash }, "swept residual gas to tank");
  return hash;
}
