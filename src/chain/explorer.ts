/** Blockscout API helpers (Robinhood Chain). Used for confirmations + token txs. */
import { config } from "../config.js";

const BASE = config.RH_EXPLORER_API; // .../api

async function api(params: Record<string, string>): Promise<any> {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Blockscout ${res.status}: ${await res.text()}`);
  return res.json();
}

/** ERC-20 transfers to/from an address (used to confirm a bridge/swap landed). */
export async function tokenTransfers(address: string): Promise<any[]> {
  const r = await api({ module: "account", action: "tokentx", address });
  return Array.isArray(r.result) ? r.result : [];
}

/** True once a tx hash is mined and status == success. */
export async function txSucceeded(hash: string): Promise<boolean> {
  const r = await api({ module: "transaction", action: "gettxreceiptstatus", txhash: hash });
  return r?.result?.status === "1";
}
