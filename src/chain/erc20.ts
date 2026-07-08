/** Minimal ERC-20 reads/encodes on Robinhood Chain via viem. */
import { erc20Abi, getAddress, type Address } from "viem";
import { rhPublic } from "./rhchain.js";

export interface TokenMeta {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
}

/** Returns null if the address has no ERC-20 metadata (likely not a token). */
export async function readTokenMeta(address: string): Promise<TokenMeta | null> {
  let addr: Address;
  try {
    addr = getAddress(address); // checksums + validates
  } catch {
    return null;
  }
  try {
    const [symbol, name, decimals] = await Promise.all([
      rhPublic.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }),
      rhPublic.readContract({ address: addr, abi: erc20Abi, functionName: "name" }),
      rhPublic.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { address: addr, symbol, name, decimals };
  } catch {
    return null;
  }
}

export async function erc20BalanceOf(token: Address, owner: Address): Promise<bigint> {
  return rhPublic.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function erc20Allowance(
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return rhPublic.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  });
}
