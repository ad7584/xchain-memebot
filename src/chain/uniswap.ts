/**
 * Uniswap **V3** routing on Robinhood Chain — this is where the tradable
 * liquidity lives (confirmed by decoding real Universal Router swaps; the v4
 * deployment quotes but barely trades).
 *
 * - Pool discovery: V3 Factory.getPool across fee tiers, pick the deepest.
 * - Pricing: spot price from the pool's slot0 (ignores price impact; we apply
 *   slippage on top, so a thin pool just makes the swap revert safely — never a
 *   silent loss). Good enough for minOut + honeypot screening. A QuoterV2 can be
 *   dropped in later for exact-output pricing.
 * - Execution: on-chain Universal Router V3 calldata (see universalRouter.ts),
 *   validated via eth_call against mainnet.
 */
import { getAddress, type Address, type Hex } from "viem";
import { rhPublic } from "./rhchain.js";
import { ADDR } from "./constants.js";
import {
  buildV3Buy,
  buildV3SellToEth,
  buildV3SellToToken,
  encodeV3Path,
  MSG_SENDER,
  type V3Hop,
} from "./universalRouter.js";

const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

/** Routing base on V3 is WETH (native ETH is wrapped/unwrapped by the router). */
export const QUOTE_BASE = ADDR.WETH;

const FEE_TIERS = [10000, 3000, 500, 100];

const FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

const POOL_ABI = [
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
    { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
    { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" }, { name: "unlocked", type: "bool" } ] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

interface V3Pool { pool: Address; fee: number; sqrtPriceX96: bigint; token0: Address; liquidity: bigint }
interface PoolId { pool: Address; fee: number; token0: Address }

// Cache ONLY immutable pool identity (address/fee/token0) per pair — never the
// mutable price/liquidity, which must be read fresh each quote so minOut tracks
// the live price.
const poolIdCache = new Map<string, PoolId[]>();

async function discoverPools(a: Address, b: Address): Promise<PoolId[]> {
  const key = [a.toLowerCase(), b.toLowerCase()].sort().join(":");
  const cached = poolIdCache.get(key);
  if (cached) return cached;

  const ids: PoolId[] = [];
  for (const fee of FEE_TIERS) {
    let pool: Address;
    try {
      pool = (await rhPublic.readContract({ address: ADDR.V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee] })) as Address;
    } catch {
      continue;
    }
    if (!pool || pool === NATIVE) continue;
    try {
      const token0 = (await rhPublic.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" })) as Address;
      ids.push({ pool, fee, token0 });
    } catch {
      continue;
    }
  }
  poolIdCache.set(key, ids);
  return ids;
}

async function findBestPool(a: Address, b: Address): Promise<V3Pool | null> {
  const ids = await discoverPools(a, b);
  let best: V3Pool | null = null;
  for (const id of ids) {
    try {
      // Fresh reads EVERY time — pricing must not come from a cache.
      const [slot0, liquidity] = await Promise.all([
        rhPublic.readContract({ address: id.pool, abi: POOL_ABI, functionName: "slot0" }),
        rhPublic.readContract({ address: id.pool, abi: POOL_ABI, functionName: "liquidity" }),
      ]);
      const liq = liquidity as bigint;
      const sqrtPriceX96 = (slot0 as readonly bigint[])[0]!;
      if (liq === 0n || sqrtPriceX96 === 0n) continue;
      const p: V3Pool = { pool: id.pool, fee: id.fee, token0: id.token0, sqrtPriceX96, liquidity: liq };
      if (!best || p.liquidity > best.liquidity) best = p;
    } catch {
      continue;
    }
  }
  return best;
}

/** Spot-price output estimate for one pool (impact ignored; slippage covers it). */
function estimateOut(pool: V3Pool, tokenIn: Address, amountIn: bigint): bigint {
  const inIsToken0 = tokenIn.toLowerCase() === pool.token0.toLowerCase();
  const sp = pool.sqrtPriceX96;
  const raw = inIsToken0 ? (amountIn * sp * sp) >> 192n : (amountIn << 192n) / (sp * sp);
  return (raw * BigInt(1_000_000 - pool.fee)) / 1_000_000n;
}

export interface QuoteResult {
  amountOut: bigint;
}

interface V3Route {
  hops: V3Hop[]; // from the input token (WETH for buys) to the output
  amountOut: bigint;
}

async function routeThroughV3(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<V3Route | null> {
  const direct = await findBestPool(tokenIn, tokenOut);
  if (direct) {
    const out = estimateOut(direct, tokenIn, amountIn);
    if (out > 0n) return { hops: [{ tokenOut, fee: direct.fee }], amountOut: out };
  }
  const isW = (x: Address) => x.toLowerCase() === ADDR.WETH.toLowerCase();
  if (!isW(tokenIn) && !isW(tokenOut)) {
    const p1 = await findBestPool(tokenIn, ADDR.WETH);
    if (p1) {
      const mid = estimateOut(p1, tokenIn, amountIn);
      if (mid > 0n) {
        const p2 = await findBestPool(ADDR.WETH, tokenOut);
        if (p2) {
          const out = estimateOut(p2, ADDR.WETH, mid);
          if (out > 0n) return { hops: [{ tokenOut: ADDR.WETH, fee: p1.fee }, { tokenOut, fee: p2.fee }], amountOut: out };
        }
      }
    }
  }
  return null;
}

const toWeth = (x: Address): Address => (x.toLowerCase() === NATIVE.toLowerCase() ? ADDR.WETH : x);

export async function quoteBuyExactIn(base: Address, token: Address, amountIn: bigint): Promise<QuoteResult> {
  const r = await routeThroughV3(toWeth(getAddress(base)), getAddress(token), amountIn);
  return { amountOut: r?.amountOut ?? 0n };
}

export async function quoteSellExactIn(token: Address, base: Address, amountIn: bigint): Promise<QuoteResult> {
  const r = await routeThroughV3(getAddress(token), toWeth(getAddress(base)), amountIn);
  return { amountOut: r?.amountOut ?? 0n };
}

// --- Execution calldata ------------------------------------------------------
export interface SwapCalldata {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  minOut: bigint;
  quotedOut: bigint;
}

/**
 * Build Universal Router V3 swap calldata. `tokenIn`/`tokenOut` may be the native
 * ETH marker (0x0): native in ⇒ buy (WRAP_ETH+swap), native out ⇒ sell to ETH
 * (swap+UNWRAP_WETH); otherwise a token→token swap. Output goes to the signer.
 */
export async function getSwapCalldata(params: {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  recipient: Address;
}): Promise<SwapCalldata> {
  const tokenIn = getAddress(params.tokenIn);
  const tokenOut = getAddress(params.tokenOut);
  const nativeIn = tokenIn.toLowerCase() === NATIVE.toLowerCase();
  const nativeOut = tokenOut.toLowerCase() === NATIVE.toLowerCase();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const applyMin = (out: bigint) => (out * BigInt(10_000 - params.slippageBps)) / 10_000n;

  if (nativeIn) {
    const route = await routeThroughV3(ADDR.WETH, tokenOut, params.amountIn);
    if (!route) throw new Error(`No V3 liquidity for ETH -> ${tokenOut}.`);
    const minOut = applyMin(route.amountOut);
    const built = buildV3Buy({
      wethPath: encodeV3Path(ADDR.WETH, route.hops),
      amountIn: params.amountIn,
      minOut,
      recipient: MSG_SENDER,
      deadline,
    });
    return { to: built.to, data: built.data, value: built.value, minOut, quotedOut: route.amountOut };
  }

  if (nativeOut) {
    const route = await routeThroughV3(tokenIn, ADDR.WETH, params.amountIn);
    if (!route) throw new Error(`No V3 liquidity for ${tokenIn} -> ETH.`);
    const minOut = applyMin(route.amountOut);
    const built = buildV3SellToEth({
      pathToWeth: encodeV3Path(tokenIn, route.hops),
      amountIn: params.amountIn,
      minOut,
      recipient: MSG_SENDER,
      deadline,
    });
    return { to: built.to, data: built.data, value: built.value, minOut, quotedOut: route.amountOut };
  }

  const route = await routeThroughV3(tokenIn, tokenOut, params.amountIn);
  if (!route) throw new Error(`No V3 liquidity for ${tokenIn} -> ${tokenOut}.`);
  const minOut = applyMin(route.amountOut);
  const built = buildV3SellToToken({
    path: encodeV3Path(tokenIn, route.hops),
    amountIn: params.amountIn,
    minOut,
    recipient: MSG_SENDER,
    deadline,
  });
  return { to: built.to, data: built.data, value: built.value, minOut, quotedOut: route.amountOut };
}
