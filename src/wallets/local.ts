/**
 * Local (self-custody) backend — generates a Solana + EVM keypair per user and
 * stores the private keys AES-256-GCM-encrypted at rest (ENCRYPTION_KEY). Signs
 * by decrypting in-memory just for the operation.
 *
 * This is the pragmatic MVP custody: no external dependency, fully functional.
 * Security note: keys are recoverable by anything with DB + ENCRYPTION_KEY, so
 * keep ENCRYPTION_KEY out of the DB host and rotate on suspicion. Turnkey (TEE,
 * per-user isolation, policy engine) is the stronger option — swap via
 * CUSTODY_PROVIDER=turnkey once its keys are set. Same interface either way.
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { encrypt, decrypt } from "../util/crypto.js";
import { requireConfig } from "../config.js";
import type { UserRow } from "../db/index.js";

export interface Provisioned {
  solAddress: string;
  evmAddress: `0x${string}`;
  solSecretEnc: string;
  evmSecretEnc: string;
}

export async function createUserWallets(_telegramId: number): Promise<Provisioned> {
  // Refuse to provision without a key — otherwise keys can't be encrypted at rest.
  requireConfig("local-custody", ["ENCRYPTION_KEY"]);
  const evmPk = generatePrivateKey();
  const evmAddress = privateKeyToAccount(evmPk).address;

  const kp = Keypair.generate();
  const solAddress = kp.publicKey.toBase58();
  const solSecret = bs58.encode(kp.secretKey); // 64-byte secret key, base58

  return {
    solAddress,
    evmAddress,
    evmSecretEnc: encrypt(evmPk),
    solSecretEnc: encrypt(solSecret),
  };
}

export async function getEvmAccount(user: UserRow): Promise<Account> {
  if (!user.evm_secret_enc) throw new Error("No local EVM key for this user.");
  return privateKeyToAccount(decrypt(user.evm_secret_enc) as `0x${string}`);
}

export async function signSolanaTx<T extends Transaction | VersionedTransaction>(
  user: UserRow,
  tx: T
): Promise<T> {
  if (!user.sol_secret_enc) throw new Error("No local Solana key for this user.");
  const kp = Keypair.fromSecretKey(bs58.decode(decrypt(user.sol_secret_enc)));
  if (tx instanceof VersionedTransaction) tx.sign([kp]);
  else (tx as Transaction).partialSign(kp);
  return tx;
}
