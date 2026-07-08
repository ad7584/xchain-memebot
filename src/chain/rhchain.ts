/**
 * Robinhood Chain (EVM) clients.
 *
 * - `rhPublic` : read-only client. Prefers Alchemy if configured, else public RPC.
 * - `getGasTankWallet()` : the isolated hot wallet that fronts dust ETH for the
 *   MVP gas-less-sell path. Uses a raw private key (NOT a user key). User signing
 *   goes through Turnkey, not here (see wallets/turnkey.ts).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, requireConfig } from "../config.js";
import { robinhoodChain } from "./constants.js";

const rpcUrl = config.ALCHEMY_RH_RPC_URL || config.RH_RPC_URL;

export const rhPublic: PublicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(rpcUrl, { batch: true, retryCount: 3 }),
});

let gasTankWallet: WalletClient | undefined;
let gasTankAccount: Account | undefined;

/** The gas-tank wallet client, or throws if the key isn't configured yet. */
export function getGasTankWallet(): { wallet: WalletClient; account: Account } {
  requireConfig("gas-tank", ["GAS_TANK_PRIVATE_KEY"]);
  if (!gasTankWallet || !gasTankAccount) {
    const pk = config.GAS_TANK_PRIVATE_KEY.startsWith("0x")
      ? (config.GAS_TANK_PRIVATE_KEY as `0x${string}`)
      : (`0x${config.GAS_TANK_PRIVATE_KEY}` as `0x${string}`);
    gasTankAccount = privateKeyToAccount(pk);
    gasTankWallet = createWalletClient({
      account: gasTankAccount,
      chain: robinhoodChain,
      transport: http(rpcUrl),
    });
  }
  return { wallet: gasTankWallet, account: gasTankAccount };
}

/** Build a wallet client whose signer is a Turnkey-backed viem Account. */
export function rhWalletClientFor(account: Account): WalletClient {
  return createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(rpcUrl),
  });
}
