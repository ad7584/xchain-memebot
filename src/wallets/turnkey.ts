/**
 * Turnkey custody layer.
 *
 * Model: one Turnkey SUB-ORGANIZATION per Telegram user. The backend's API key is
 * the sub-org's root user, so the bot can sign on the user's behalf (custodial
 * hot-wallet reality), while each user's keys stay cryptographically isolated in
 * a TEE — a compromise of one sub-org can't reach another's keys.
 *
 * Each sub-org gets ONE wallet with TWO derived accounts:
 *   - EVM  (secp256k1, m/44'/60'/0'/0/0)  → Robinhood Chain
 *   - Solana (ed25519, m/44'/501'/0'/0')  → Solana
 *
 * [VERIFY WITH KEYS] Field names on createSubOrganization/signing can shift across
 * @turnkey/sdk-server majors. The shapes below follow the current server SDK; if
 * a call 400s, the error will name the offending field. Nothing else in the app
 * needs to change — this file is the only Turnkey touch-point.
 */
import { Turnkey } from "@turnkey/sdk-server";
import { createAccount } from "@turnkey/viem";
import { TurnkeySigner } from "@turnkey/solana";
import type { Account } from "viem";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { config, requireConfig } from "../config.js";
import { logger } from "../logger.js";
import type { UserRow } from "../db/index.js";

let _turnkey: Turnkey | undefined;

function turnkey(): Turnkey {
  requireConfig("turnkey", [
    "TURNKEY_ORGANIZATION_ID",
    "TURNKEY_API_PUBLIC_KEY",
    "TURNKEY_API_PRIVATE_KEY",
  ]);
  if (!_turnkey) {
    _turnkey = new Turnkey({
      apiBaseUrl: config.TURNKEY_API_BASE_URL,
      apiPublicKey: config.TURNKEY_API_PUBLIC_KEY,
      apiPrivateKey: config.TURNKEY_API_PRIVATE_KEY,
      defaultOrganizationId: config.TURNKEY_ORGANIZATION_ID,
    });
  }
  return _turnkey;
}

/**
 * The server API client, typed as `any` at this boundary on purpose: @turnkey/viem
 * and @turnkey/solana each declare their own `client` supertype and assignability
 * drifts across package majors. The client is runtime-correct; precise types get
 * pinned in the live integration pass. [VERIFY]
 */
function tkClient(): any {
  return turnkey().apiClient();
}

export interface CreatedWallets {
  suborgId: string;
  evmAddress: `0x${string}`;
  solAddress: string;
}

/** Create a per-user sub-org with an EVM + Solana account. */
export async function createUserWallets(telegramId: number): Promise<CreatedWallets> {
  const client = turnkey().apiClient();
  const res = await client.createSubOrganization({
    subOrganizationName: `tg-${telegramId}`,
    rootQuorumThreshold: 1,
    rootUsers: [
      {
        userName: "backend",
        userEmail: undefined as unknown as string | undefined,
        apiKeys: [
          {
            apiKeyName: "backend-signer",
            publicKey: config.TURNKEY_API_PUBLIC_KEY,
            curveType: "API_KEY_CURVE_P256",
          },
        ],
        authenticators: [],
        oauthProviders: [],
      },
    ],
    wallet: {
      walletName: "default",
      accounts: [
        {
          curve: "CURVE_SECP256K1",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/60'/0'/0/0",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
        {
          curve: "CURVE_ED25519",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/501'/0'/0'",
          addressFormat: "ADDRESS_FORMAT_SOLANA",
        },
      ],
    },
  });

  const suborgId = res.subOrganizationId;
  const addresses = res.wallet?.addresses ?? [];
  const evmAddress = addresses.find((a) => a.startsWith("0x")) as `0x${string}` | undefined;
  const solAddress = addresses.find((a) => !a.startsWith("0x"));

  if (!suborgId || !evmAddress || !solAddress) {
    logger.error({ res }, "Turnkey createSubOrganization: unexpected response shape");
    throw new Error("Turnkey did not return both an EVM and Solana address [VERIFY].");
  }
  return { suborgId, evmAddress, solAddress };
}

/** viem Account backed by the user's Turnkey EVM key. Signs RH-Chain txs. */
export async function getEvmAccount(user: UserRow): Promise<Account> {
  if (!user.turnkey_suborg_id || !user.evm_eoa) {
    throw new Error("User has no Turnkey EVM wallet provisioned.");
  }
  return createAccount({
    client: tkClient(),
    organizationId: user.turnkey_suborg_id,
    signWith: user.evm_eoa,
    ethereumAddress: user.evm_eoa,
  });
}

/** Signs a Solana transaction in-place with the user's Turnkey ed25519 key. */
export async function signSolanaTx<T extends Transaction | VersionedTransaction>(
  user: UserRow,
  tx: T
): Promise<T> {
  if (!user.turnkey_suborg_id || !user.sol_pubkey) {
    throw new Error("User has no Turnkey Solana wallet provisioned.");
  }
  const signer = new TurnkeySigner({
    organizationId: user.turnkey_suborg_id,
    client: tkClient(),
  });
  await signer.addSignature(tx, user.sol_pubkey);
  return tx;
}
