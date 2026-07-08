/**
 * Custody abstraction — the rest of the app talks to THIS, not a specific
 * backend. Selects Turnkey or the local encrypted keystore via CUSTODY_PROVIDER
 * ('auto' uses Turnkey when its org id is configured, else local).
 */
import type { Account } from "viem";
import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { UserRow } from "../db/index.js";
import * as turnkey from "./turnkey.js";
import * as local from "./local.js";

const useTurnkey =
  config.CUSTODY_PROVIDER === "turnkey" ||
  (config.CUSTODY_PROVIDER === "auto" && !!config.TURNKEY_ORGANIZATION_ID);

logger.info(`custody backend: ${useTurnkey ? "turnkey" : "local (encrypted keystore)"}`);

export interface ProvisionResult {
  solAddress: string;
  evmAddress: `0x${string}`;
  suborgId?: string;
  solSecretEnc?: string;
  evmSecretEnc?: string;
}

export async function provisionWallets(telegramId: number): Promise<ProvisionResult> {
  if (useTurnkey) {
    const w = await turnkey.createUserWallets(telegramId);
    return { solAddress: w.solAddress, evmAddress: w.evmAddress, suborgId: w.suborgId };
  }
  const w = await local.createUserWallets(telegramId);
  return {
    solAddress: w.solAddress,
    evmAddress: w.evmAddress,
    solSecretEnc: w.solSecretEnc,
    evmSecretEnc: w.evmSecretEnc,
  };
}

/**
 * Choose the signing backend by what the USER ROW actually holds — never the
 * global flag. A user provisioned under 'local' keeps signing via local even if
 * the deployment later switches to Turnkey (and vice-versa), so a config change
 * can never lock existing users out of their funds. The global flag only decides
 * which backend NEW users are provisioned with.
 */
function backendFor(user: UserRow) {
  if (user.turnkey_suborg_id) return turnkey;
  if (user.evm_secret_enc || user.sol_secret_enc) return local;
  return useTurnkey ? turnkey : local;
}

export async function getEvmAccount(user: UserRow): Promise<Account> {
  return backendFor(user).getEvmAccount(user);
}

export async function signSolanaTx<T extends Transaction | VersionedTransaction>(
  user: UserRow,
  tx: T
): Promise<T> {
  return backendFor(user).signSolanaTx(user, tx);
}
