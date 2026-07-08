/**
 * Withdrawals — the "get funds out" path, hardened against account takeover:
 *   1. 2FA (TOTP) is REQUIRED before any withdrawal.
 *   2. Every withdrawal is queued with a mandatory delay (WITHDRAWAL_DELAY_SECONDS)
 *      before a worker broadcasts it — so a hijacker can't instantly drain funds,
 *      and the real user gets a window to notice/cancel.
 *
 * Supports: SOL (native), RH ETH (native), RH ERC-20 token (with JIT gas top-up).
 */
import {
  Transaction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  getAddress,
  parseEther,
  parseUnits,
  formatEther,
  encodeFunctionData,
  erc20Abi,
  isAddress as isEvmAddress,
} from "viem";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { solana, solToLamports, solBalanceLamports } from "../chain/solana.js";
import { rhPublic, rhWalletClientFor } from "../chain/rhchain.js";
import { erc20BalanceOf, readTokenMeta } from "../chain/erc20.js";
import { ensureGasForSell } from "../chain/gas.js";
import { getEvmAccount, signSolanaTx } from "../wallets/custody.js";
import { encrypt, decrypt } from "../util/crypto.js";
import { generateSecret, otpauthUrl, verifyTotp } from "../util/totp.js";
import {
  setTwoFactorSecret,
  createWithdrawal,
  setWithdrawalStatus,
  type UserRow,
  type WithdrawalRow,
  type WithdrawChain,
} from "../db/index.js";

// Leave this much native gas behind when withdrawing native ETH.
const RH_GAS_RESERVE_WEI = 300_000_000_000_000n; // 0.0003 ETH

export interface Setup2FA {
  secret: string;
  otpauthUrl: string;
}

/** Generate + persist (encrypted) a fresh TOTP secret for the user. */
export async function setup2FA(user: UserRow): Promise<Setup2FA> {
  const secret = generateSecret();
  await setTwoFactorSecret(Number(user.telegram_id), encrypt(secret));
  return {
    secret,
    otpauthUrl: otpauthUrl(secret, user.username ?? String(user.telegram_id)),
  };
}

export function has2FA(user: UserRow): boolean {
  return !!user.twofa_secret;
}

export function check2FA(user: UserRow, token: string): boolean {
  if (!user.twofa_secret) return false;
  try {
    return verifyTotp(decrypt(user.twofa_secret), token);
  } catch {
    return false;
  }
}

export interface WithdrawRequest {
  user: UserRow;
  chain: WithdrawChain;
  asset: string; // 'SOL' | 'ETH' | RH token address
  amountHuman: string; // human units
  destination: string;
  totp: string;
}

/** Validate + 2FA + enqueue with delay. Does NOT broadcast (the worker does). */
export async function requestWithdrawal(
  req: WithdrawRequest
): Promise<{ ok: true; withdrawal: WithdrawalRow } | { ok: false; error: string }> {
  const { user, chain, asset } = req;

  if (!has2FA(user)) return { ok: false, error: "Enable 2FA first: /enable2fa" };
  if (!check2FA(user, req.totp)) return { ok: false, error: "Invalid 2FA code." };

  const amount = Number(req.amountHuman);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Invalid amount." };

  // Destination format per chain.
  if (chain === "SOL") {
    try {
      new PublicKey(req.destination);
    } catch {
      return { ok: false, error: "Invalid Solana destination address." };
    }
  } else if (!isEvmAddress(req.destination)) {
    return { ok: false, error: "Invalid Robinhood Chain (EVM) destination address." };
  }

  // Best-effort balance check.
  const bal = await availableBalanceHuman(user, chain, asset);
  if (bal !== null && amount > bal) {
    return { ok: false, error: `Insufficient balance (have ${bal}).` };
  }

  const w = await createWithdrawal({
    telegramId: Number(user.telegram_id),
    chain,
    asset,
    amount: req.amountHuman,
    destination: req.destination,
    delaySeconds: config.WITHDRAWAL_DELAY_SECONDS,
  });
  return { ok: true, withdrawal: w };
}

/** Broadcast a due withdrawal. Called by the withdrawals worker. */
export async function executeWithdrawal(w: WithdrawalRow, user: UserRow): Promise<string> {
  if (!config.TRADING_ENABLED) throw new Error("TRADING_ENABLED=false — withdrawals blocked.");

  if (w.chain === "SOL") return sendSol(user, w.destination, Number(w.amount));
  if (w.asset === "ETH") return sendRhEth(user, w.destination, w.amount);
  return sendRhToken(user, w.asset, w.destination, w.amount);
}

async function sendSol(user: UserRow, destination: string, amountSol: number): Promise<string> {
  const from = new PublicKey(user.sol_pubkey!);
  const to = new PublicKey(destination);
  const lamports = solToLamports(amountSol);
  const { blockhash, lastValidBlockHeight } = await solana.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: from, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(lamports) })
  );
  await signSolanaTx(user, tx);
  const sig = await solana.sendRawTransaction(tx.serialize());
  await solana.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  logger.info({ sig, amountSol }, "SOL withdrawal sent");
  return sig;
}

async function sendRhEth(user: UserRow, destination: string, amountHuman: string): Promise<string> {
  const account = await getEvmAccount(user);
  const wallet = rhWalletClientFor(account);
  const value = parseEther(amountHuman);
  const hash = await wallet.sendTransaction({
    account,
    chain: null,
    to: getAddress(destination),
    value,
  });
  await rhPublic.waitForTransactionReceipt({ hash });
  logger.info({ hash, amountHuman }, "RH ETH withdrawal sent");
  return hash;
}

async function sendRhToken(
  user: UserRow,
  token: string,
  destination: string,
  amountHuman: string
): Promise<string> {
  const evm = getAddress(user.evm_eoa!);
  const meta = await readTokenMeta(token);
  const decimals = meta?.decimals ?? 18;
  const amount = parseUnits(amountHuman, decimals);

  // Token transfer needs native gas the user may not have → JIT top-up.
  const gasPrice = await rhPublic.getGasPrice();
  await ensureGasForSell(evm, 80_000n * gasPrice);

  const account = await getEvmAccount(user);
  const wallet = rhWalletClientFor(account);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(destination), amount],
  });
  const hash = await wallet.sendTransaction({ account, chain: null, to: getAddress(token), data });
  await rhPublic.waitForTransactionReceipt({ hash });
  logger.info({ hash, token, amountHuman }, "RH token withdrawal sent");
  return hash;
}

/** Returns available human balance for the asset, or null if unknown. */
async function availableBalanceHuman(
  user: UserRow,
  chain: WithdrawChain,
  asset: string
): Promise<number | null> {
  try {
    if (chain === "SOL") {
      const lamports = await solBalanceLamports(user.sol_pubkey!);
      return Number(lamports) / 1e9;
    }
    const evm = getAddress(user.evm_eoa!);
    if (asset === "ETH") {
      const wei = await rhPublic.getBalance({ address: evm });
      const spendable = wei > RH_GAS_RESERVE_WEI ? wei - RH_GAS_RESERVE_WEI : 0n;
      return Number(formatEther(spendable));
    }
    const meta = await readTokenMeta(asset);
    const decimals = meta?.decimals ?? 18;
    const bal = await erc20BalanceOf(getAddress(asset), evm);
    return Number(bal) / 10 ** decimals;
  } catch (err) {
    logger.warn({ err }, "availableBalanceHuman failed");
    return null;
  }
}

// re-export for the worker
export { setWithdrawalStatus };
