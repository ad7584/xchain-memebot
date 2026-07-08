/** Onboarding + balance aggregation for the bot UI. */
import { getAddress, formatEther, formatUnits } from "viem";
import { getUser, upsertUser, getPositions, type UserRow } from "../db/index.js";
import { createUserWallets } from "../wallets/turnkey.js";
import { rhPublic } from "../chain/rhchain.js";
import { erc20BalanceOf } from "../chain/erc20.js";
import { ADDR } from "../chain/constants.js";
import { solBalanceLamports, lamportsToSol } from "../chain/solana.js";
import { readTokenMeta } from "../chain/erc20.js";

/** Fetch the user, provisioning Turnkey wallets on first contact. */
export async function getOrCreateUser(
  telegramId: number,
  username?: string
): Promise<UserRow> {
  const existing = await getUser(telegramId);
  if (existing?.sol_pubkey && existing?.evm_eoa) return existing;

  // First touch → create isolated Turnkey sub-org with SOL + EVM accounts.
  const w = await createUserWallets(telegramId);
  await upsertUser({
    telegramId,
    username,
    suborgId: w.suborgId,
    solPubkey: w.solAddress,
    evmEoa: w.evmAddress,
  });
  const user = await getUser(telegramId);
  if (!user) throw new Error("Failed to persist new user.");
  return user;
}

export interface BalanceView {
  solAddress: string;
  evmAddress: string;
  solBalance: number;
  ethBalance: string;
  usdgBalance: string;
  positions: Array<{
    symbol: string;
    address: string;
    funding: string;
    amount: string;
  }>;
}

export async function getBalances(user: UserRow): Promise<BalanceView> {
  const evm = getAddress(user.evm_eoa!);
  const [solLamports, eth, usdg, positions] = await Promise.all([
    solBalanceLamports(user.sol_pubkey!),
    rhPublic.getBalance({ address: evm }),
    erc20BalanceOf(ADDR.USDG, evm),
    getPositions(Number(user.telegram_id)),
  ]);

  const posViews = await Promise.all(
    positions.map(async (p) => {
      const meta = await readTokenMeta(p.token_address);
      const decimals = meta?.decimals ?? 18;
      return {
        symbol: p.token_symbol ?? meta?.symbol ?? "?",
        address: p.token_address,
        funding: p.funding_asset,
        amount: formatUnits(BigInt(p.amount_tokens), decimals),
      };
    })
  );

  return {
    solAddress: user.sol_pubkey!,
    evmAddress: user.evm_eoa!,
    solBalance: lamportsToSol(solLamports),
    ethBalance: formatEther(eth),
    usdgBalance: formatUnits(usdg, 6), // USDG has 6 decimals [VERIFY on-chain]
    positions: posViews,
  };
}
