/**
 * Relay client (REST). Relay is the confirmed rail for Solana <-> Robinhood Chain
 * (4663) in both directions with arbitrary tokens + destination Call Execution +
 * appFees (our monetization).
 *
 * We use REST directly (not the SDK) to avoid version churn. Two calls matter:
 *   - POST /quote   → returns `steps` (txs to sign/submit) + fees + requestId
 *   - GET  /intents/status?requestId= → fill status
 *
 * [VERIFY WITH ACCESS] Exact currency markers for native SOL/ETH and the precise
 * step/item field paths can vary by Relay API version. Extractors below are
 * defensive and log the raw payload on shape mismatch so we can pin fields fast.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { RELAY_SOLANA_CHAIN_ID, RH_CHAIN_ID } from "../chain/constants.js";

const BASE = config.RELAY_API_BASE;

/** Native asset markers Relay expects (address-style). [VERIFY] for SOL. */
export const RELAY_NATIVE = {
  ETH: "0x0000000000000000000000000000000000000000",
  SOL: "11111111111111111111111111111111", // SOL native mint
} as const;

export interface RelayCallTx {
  to: string;
  value: string;
  data: string;
}

export interface RelayQuoteParams {
  user: string; // sender (origin) address
  recipient: string; // receiver (destination) address
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string; // base units of originCurrency
  /** Destination Call Execution: swap-on-arrival etc. Solver pays dest gas. */
  txs?: RelayCallTx[];
  appFeeBps?: number;
}

export interface RelayQuote {
  requestId: string | undefined;
  raw: any;
  steps: any[];
  /** Origin transaction(s) the sender must sign+submit to kick off the intent. */
  originItems: any[];
}

export async function relayQuote(p: RelayQuoteParams): Promise<RelayQuote> {
  const body: Record<string, unknown> = {
    user: p.user,
    recipient: p.recipient,
    originChainId: p.originChainId,
    destinationChainId: p.destinationChainId,
    originCurrency: p.originCurrency,
    destinationCurrency: p.destinationCurrency,
    amount: p.amount,
    tradeType: "EXACT_INPUT",
  };
  if (p.txs?.length) body.txs = p.txs;
  if (p.appFeeBps && config.FEE_TREASURY_EVM) {
    body.appFees = [{ recipient: config.FEE_TREASURY_EVM, fee: String(p.appFeeBps) }];
  }

  const res = await fetch(`${BASE}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Relay /quote ${res.status}: ${await res.text()}`);
  }
  const raw: any = await res.json();
  const steps: any[] = raw.steps ?? [];
  // Each step's items carry the tx(s) to submit (Solana: data.instructions[]+ALTs;
  // EVM: data.{to,data,value}). Preserve order (e.g. approve before deposit).
  const originItems: any[] = steps.flatMap((s) => s.items ?? []);

  // Relay returns the requestId inside item.check.endpoint (…?requestId=0x…),
  // NOT as a top-level field. Extract it for status polling.
  const checkEndpoint: string | undefined = originItems
    .map((i) => i?.check?.endpoint)
    .find((e) => typeof e === "string");
  let requestId: string | undefined = raw.requestId;
  if (!requestId && checkEndpoint) {
    const q = checkEndpoint.split("?")[1] ?? "";
    requestId = new URLSearchParams(q).get("requestId") ?? undefined;
  }

  if (steps.length === 0) {
    logger.error({ raw }, "Relay quote returned no steps — verify route/fields");
    throw new Error("Relay returned no executable steps for this route [VERIFY].");
  }
  return { requestId, raw, steps, originItems };
}

export interface RelayStatus {
  status: "waiting" | "pending" | "success" | "refund" | "failure" | string;
  raw: any;
}

export async function relayStatus(requestId: string): Promise<RelayStatus> {
  const url = new URL(`${BASE}/intents/status`);
  url.searchParams.set("requestId", requestId);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Relay status ${res.status}: ${await res.text()}`);
  const raw: any = await res.json();
  return { status: raw.status ?? "pending", raw };
}

/** Convenience presets for our two directions. */
export const RELAY_ROUTES = {
  solToRh: (over: Partial<RelayQuoteParams>): Partial<RelayQuoteParams> => ({
    originChainId: RELAY_SOLANA_CHAIN_ID,
    destinationChainId: RH_CHAIN_ID,
    originCurrency: RELAY_NATIVE.SOL,
    ...over,
  }),
  rhToSol: (over: Partial<RelayQuoteParams>): Partial<RelayQuoteParams> => ({
    originChainId: RH_CHAIN_ID,
    destinationChainId: RELAY_SOLANA_CHAIN_ID,
    destinationCurrency: RELAY_NATIVE.SOL,
    ...over,
  }),
} as const;
