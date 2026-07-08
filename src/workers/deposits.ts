/**
 * Deposit detection — polls each user's SOL and RH-ETH balances and notifies on
 * an increase. First observation of an asset just sets a baseline (no notify).
 *
 * NOTE: this is O(users) RPC calls per tick — fine for early scale. At larger
 * scale, move to Solana logsSubscribe / an RH-Chain log filter or multicall
 * batching. Marked for the v2 scaling pass.
 */
import { getAddress } from "viem";
import { allUsers, advanceDepositSeen } from "../db/index.js";
import { solBalanceLamports } from "../chain/solana.js";
import { rhPublic } from "../chain/rhchain.js";
import { logger } from "../logger.js";
import type { WorkerDeps } from "./types.js";

export async function scanDeposits(deps: WorkerDeps): Promise<void> {
  const users = await allUsers();
  for (const u of users) {
    const tid = Number(u.telegram_id);
    try {
      if (u.sol_pubkey) {
        await checkAsset(deps, tid, "SOL", "SOL", 9, "SOL", () => solBalanceLamports(u.sol_pubkey!));
      }
      if (u.evm_eoa) {
        const evm = getAddress(u.evm_eoa);
        await checkAsset(deps, tid, "RH", "ETH", 18, "ETH", () => rhPublic.getBalance({ address: evm }));
      }
    } catch (err) {
      logger.warn({ err, tid }, "deposit scan failed for user");
    }
  }
}

async function checkAsset(
  deps: WorkerDeps,
  tid: number,
  chain: string,
  asset: string,
  decimals: number,
  label: string,
  getBalance: () => Promise<bigint>
): Promise<void> {
  const current = await getBalance();
  // Atomic compare-and-advance: returns the prior amount only if THIS call raised
  // the baseline (first observation / no increase / lost race ⇒ null, no notify).
  const prior = await advanceDepositSeen(tid, chain, asset, current);
  if (prior === null) return;

  const human = Number(current - prior) / 10 ** decimals;
  if (human <= 0) return;
  await deps.notify(
    tid,
    `💰 Deposit received: +${human.toFixed(decimals === 9 ? 4 : 6)} ${label}\nTap /buy to trade.`
  );
}
