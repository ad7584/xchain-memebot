/**
 * Token safety screening — run BEFORE routing a user into any token.
 *
 * Memecoin liquidity on a ~week-old chain is thin and adversarial (honeypots,
 * transfer taxes, sell blocks). This is the single biggest source of user losses,
 * so we gate every buy on it.
 *
 * v1 does the cheap, high-signal checks synchronously:
 *   - valid ERC-20 with sane metadata
 *   - a real Uniswap pool with non-trivial liquidity exists (via quoteBuy)
 *   - a SELL quote round-trips (honeypot smell test: can you get value back out?)
 *   - implied round-trip tax under a threshold
 *
 * `simulateSell` (eth_call of the actual sell against a pinned state) is the
 * strongest honeypot check and is stubbed for the sell module to fill once the
 * Universal Router calldata builder is finalized.
 */
import { readTokenMeta, type TokenMeta } from "./erc20.js";
import { quoteBuyExactIn, quoteSellExactIn, QUOTE_BASE } from "./uniswap.js";
import { logger } from "../logger.js";

export interface ScreenResult {
  ok: boolean;
  token?: TokenMeta;
  reasons: string[];
  roundTripTaxBps?: number;
}

const MAX_ROUND_TRIP_TAX_BPS = 2500; // 25% — reject worse than this

export async function screenToken(address: string): Promise<ScreenResult> {
  const reasons: string[] = [];

  const token = await readTokenMeta(address);
  if (!token) {
    return { ok: false, reasons: ["Not a valid ERC-20 (no symbol/name/decimals)."] };
  }
  if (token.decimals > 24) reasons.push("Suspicious decimals.");

  // Probe with a tiny notional of native ETH to see if a real pool exists both
  // ways (pools on this chain pair with native ETH, not WETH).
  const probeEthIn = 1_000_000_000_000_000n; // 0.001 ETH
  let roundTripTaxBps: number | undefined;
  try {
    const buy = await quoteBuyExactIn(QUOTE_BASE, token.address, probeEthIn);
    if (buy.amountOut === 0n) {
      reasons.push("No buy liquidity (Uniswap quote returned 0).");
    } else {
      const back = await quoteSellExactIn(token.address, QUOTE_BASE, buy.amountOut);
      if (back.amountOut === 0n) {
        reasons.push("Cannot sell back — likely honeypot (0 out on reverse quote).");
      } else {
        // How much ETH survives a buy→sell round trip vs what we put in.
        const kept = Number(back.amountOut) / Number(probeEthIn);
        roundTripTaxBps = Math.max(0, Math.round((1 - kept) * 10_000));
        if (roundTripTaxBps > MAX_ROUND_TRIP_TAX_BPS) {
          reasons.push(
            `Round-trip tax/slippage too high (~${(roundTripTaxBps / 100).toFixed(1)}%).`
          );
        }
      }
    }
  } catch (err) {
    logger.warn({ err, token: token.address }, "screen: quote probe failed");
    reasons.push("Could not obtain Uniswap quotes (no pool, or RPC issue).");
  }

  return { ok: reasons.length === 0, token, reasons, roundTripTaxBps };
}
