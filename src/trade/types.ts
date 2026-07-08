import type { FundingAsset } from "../db/index.js";
import type { UserRow } from "../db/index.js";

export interface BuyRequest {
  user: UserRow;
  fundingAsset: FundingAsset; // SOL (cross-chain) | RH_ETH (same-chain)
  tokenAddress: `0x${string}`;
  tokenSymbol?: string;
  /** Amount of the funding asset to spend, in BASE units (lamports | wei). */
  amountInBase: bigint;
  slippageBps: number;
}

export interface SellRequest {
  user: UserRow;
  fundingAsset: FundingAsset; // which position → dictates where proceeds go
  tokenAddress: `0x${string}`;
  tokenSymbol?: string;
  /** Token amount to sell, in base units. If omitted, sell full balance. */
  amountTokens?: bigint;
  slippageBps: number;
}

export interface TradeResult {
  orderId: string;
  status: "filled" | "refunded" | "failed" | "submitted";
  amountOut?: bigint;
  txHashes: string[];
  message: string;
}
