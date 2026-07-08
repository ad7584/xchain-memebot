/**
 * Robinhood Chain — MAINNET constants.
 *
 * Sourced from docs.robinhood.com/chain (July 2026) and adversarially verified
 * during design research. BECAUSE WE GO STRAIGHT TO MAINNET, treat every address
 * below as "trust-but-verify": `preflight.ts` confirms chainId == 4663 and that
 * bytecode actually exists at each contract before TRADING_ENABLED is honored.
 *
 * DO NOT hand-edit an address here without checking it on the explorer:
 *   https://robinhoodchain.blockscout.com
 */
import { defineChain, type Address } from "viem";

export const RH_CHAIN_ID = 4663; // hex 0x1237  (NOT 0x123F — a common wrong value)
export const RH_CHAIN_ID_HEX = "0x1237" as const;

/** Relay's internal id for Solana (used in Relay quote requests). */
export const RELAY_SOLANA_CHAIN_ID = 792703809;

/** Canonical tokens on Robinhood Chain. USDC is NOT a canonical token here. */
export const ADDR = {
  // Native gas token is ETH; WETH is its wrapped form.
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  // USDG (Paxos Global Dollar) — the canonical stablecoin / deepest quote asset.
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,

  // Uniswap. NOTE: despite a v4 deployment existing, the tradable liquidity on
  // this chain is on Uniswap **V3** (confirmed by decoding real UR swaps). The
  // swap engine routes through V3; the V3 factory is the source of truth.
  UNIVERSAL_ROUTER: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  V3_FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  V4_POOL_MANAGER: "0x8366a39cc670b4001a1121b8f6a443a643e40951" as Address,
  V4_QUOTER: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94" as Address,
  V4_STATE_VIEW: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b" as Address,

  // Canonical (deterministic) Permit2 — VERIFY bytecode on-chain, not on token page.
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,

  // ERC-4337 EntryPoint (v0.7) — used by the future sponsored-paymaster sell path.
  ENTRYPOINT_V07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address,
} as const;

/** The set of contracts preflight must confirm have bytecode before we trade. */
export const REQUIRED_CODE_AT: Array<{ name: string; address: Address }> = [
  { name: "WETH", address: ADDR.WETH },
  { name: "USDG", address: ADDR.USDG },
  { name: "UniversalRouter", address: ADDR.UNIVERSAL_ROUTER },
  { name: "V3Factory", address: ADDR.V3_FACTORY },
  { name: "Permit2", address: ADDR.PERMIT2 },
];

/** viem chain definition for Robinhood Chain mainnet. */
export const robinhoodChain = defineChain({
  id: RH_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
      apiUrl: "https://robinhoodchain.blockscout.com/api",
    },
  },
  testnet: false,
});
