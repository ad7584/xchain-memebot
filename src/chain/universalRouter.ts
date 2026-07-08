/**
 * Universal Router builder — targets Uniswap **V3** (the protocol that actually
 * holds the tradable liquidity on Robinhood Chain; v4 pools quote but barely
 * trade). Self-contained, no external API.
 *
 * CONFIRMED against real successful swaps on chain 4663 (and eth_call-validated):
 *   - Buy  (native ETH → token): commands = WRAP_ETH · V3_SWAP_EXACT_IN
 *   - Sell → ETH  (token → ETH): commands = V3_SWAP_EXACT_IN · UNWRAP_WETH
 *   - Sell → token (e.g. USDG) : commands = V3_SWAP_EXACT_IN
 *
 * CRUCIAL: this deployment's V3_SWAP_EXACT_IN input must be encoded as
 *   (address recipient, uint256 amountIn, uint256 amountOutMin, bytes path,
 *    bool payerIsUser, bytes /*empty*​/)
 * — i.e. a 6-field encoding with a TRAILING EMPTY BYTES. The canonical 5-field
 * encoding reverts (0x3b99b53d); the 6-field version is byte-identical to real
 * swaps. Do not "simplify" it back to 5 fields.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  concatHex,
  type Address,
  type Hex,
} from "viem";
import { ADDR } from "./constants.js";

// Universal Router address-constants.
export const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;

// UR commands (1 byte each).
const CMD_V3_SWAP_EXACT_IN: Hex = "0x00";
const CMD_WRAP_ETH: Hex = "0x0b";
const CMD_UNWRAP_WETH: Hex = "0x0c";

const UR_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const V3_SWAP_TYPES = [
  { type: "address" }, // recipient
  { type: "uint256" }, // amountIn
  { type: "uint256" }, // amountOutMinimum
  { type: "bytes" }, // path
  { type: "bool" }, // payerIsUser
  { type: "bytes" }, // trailing empty (required by this UR deployment)
] as const;

const WRAP_TYPES = [{ type: "address" }, { type: "uint256" }] as const;

export interface V3Hop {
  tokenOut: Address;
  fee: number;
}

/** Encode a V3 path: tokenIn (fee, token)+. */
export function encodeV3Path(tokenIn: Address, hops: V3Hop[]): Hex {
  const parts: Hex[] = [tokenIn];
  for (const h of hops) {
    parts.push(encodePacked(["uint24"], [h.fee]));
    parts.push(h.tokenOut);
  }
  return concatHex(parts);
}

function encodeV3Swap(recipient: Address, amountIn: bigint, minOut: bigint, path: Hex, payerIsUser: boolean): Hex {
  return encodeAbiParameters(V3_SWAP_TYPES, [recipient, amountIn, minOut, path, payerIsUser, "0x"]);
}

function execute(commands: Hex, inputs: Hex[], deadline: bigint): Hex {
  return encodeFunctionData({ abi: UR_EXECUTE_ABI, functionName: "execute", args: [commands, inputs, deadline] });
}

export interface BuiltSwap {
  to: Address;
  data: Hex;
  value: bigint;
}

/** Native ETH → token. path starts at WETH. */
export function buildV3Buy(args: {
  wethPath: Hex; // WETH (fee, token)+
  amountIn: bigint;
  minOut: bigint;
  recipient: Address; // MSG_SENDER (the signer receives) recommended
  deadline: bigint;
}): BuiltSwap {
  const commands = concatHex([CMD_WRAP_ETH, CMD_V3_SWAP_EXACT_IN]);
  const wrap = encodeAbiParameters(WRAP_TYPES, [ADDRESS_THIS, args.amountIn]);
  // Router pays the swap from its just-wrapped WETH → payerIsUser = false.
  const swap = encodeV3Swap(args.recipient, args.amountIn, args.minOut, args.wethPath, false);
  return { to: ADDR.UNIVERSAL_ROUTER, data: execute(commands, [wrap, swap], args.deadline), value: args.amountIn };
}

/** token → native ETH. path ends at WETH; result is unwrapped to the user. */
export function buildV3SellToEth(args: {
  pathToWeth: Hex; // token (fee, ...)* WETH
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
  deadline: bigint;
}): BuiltSwap {
  const commands = concatHex([CMD_V3_SWAP_EXACT_IN, CMD_UNWRAP_WETH]);
  // Swap into the router (ADDRESS_THIS), pulling the token from the user (Permit2).
  const swap = encodeV3Swap(ADDRESS_THIS, args.amountIn, args.minOut, args.pathToWeth, true);
  const unwrap = encodeAbiParameters(WRAP_TYPES, [args.recipient, args.minOut]);
  return { to: ADDR.UNIVERSAL_ROUTER, data: execute(commands, [swap, unwrap], args.deadline), value: 0n };
}

/** token → token (e.g. memecoin → USDG). Output goes straight to the recipient. */
export function buildV3SellToToken(args: {
  path: Hex; // token (fee, ...)* outToken
  amountIn: bigint;
  minOut: bigint;
  recipient: Address;
  deadline: bigint;
}): BuiltSwap {
  const commands = CMD_V3_SWAP_EXACT_IN;
  const swap = encodeV3Swap(args.recipient, args.amountIn, args.minOut, args.path, true); // payerIsUser
  return { to: ADDR.UNIVERSAL_ROUTER, data: execute(commands, [swap], args.deadline), value: 0n };
}

// --- Permit2 (ERC-20 sell input) ---------------------------------------------
const PERMIT2_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

const UINT160_MAX = (1n << 160n) - 1n;

/** Calldata for Permit2.approve(token, UniversalRouter, max, expiration). Send to ADDR.PERMIT2. */
export function encodePermit2Approve(token: Address, expirationUnix: number): Hex {
  return encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: "approve",
    args: [token, ADDR.UNIVERSAL_ROUTER, UINT160_MAX, expirationUnix],
  });
}
