/**
 * Solana connection + light helpers. User Solana keys live in Turnkey; this
 * module only reads balances and submits already-signed transactions.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "../config.js";

const rpc = config.SOLANA_RPC_URL_PAID || config.SOLANA_RPC_URL;

export const solana = new Connection(rpc, "confirmed");

export async function solBalanceLamports(pubkey: string): Promise<bigint> {
  const lamports = await solana.getBalance(new PublicKey(pubkey), "confirmed");
  return BigInt(lamports);
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}
