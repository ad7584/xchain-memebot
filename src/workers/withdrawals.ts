/**
 * Withdrawal worker — claims withdrawals whose safety delay has elapsed and
 * broadcasts them. `claimReadyWithdrawals` uses FOR UPDATE SKIP LOCKED so running
 * multiple worker instances is safe (no double-send).
 */
import { claimReadyWithdrawals, setWithdrawalStatus, getUser } from "../db/index.js";
import { executeWithdrawal } from "../trade/withdraw.js";
import { logger } from "../logger.js";
import type { WorkerDeps } from "./types.js";

export async function processWithdrawals(deps: WorkerDeps): Promise<void> {
  const due = await claimReadyWithdrawals(10);
  for (const w of due) {
    const telegramId = Number(w.telegram_id);
    try {
      const user = await getUser(telegramId);
      if (!user) throw new Error("user not found");
      const txHash = await executeWithdrawal(w, user);
      await setWithdrawalStatus(w.id, "sent", txHash);
      await deps.notify(
        telegramId,
        `✅ Withdrawal sent: ${w.amount} ${assetLabel(w.asset)} → ${short(w.destination)}\n\`${txHash}\``
      );
    } catch (err) {
      const msg = (err as Error).message;
      await setWithdrawalStatus(w.id, "failed");
      logger.error({ err, withdrawalId: w.id }, "withdrawal failed");
      await deps.notify(telegramId, `❌ Withdrawal failed: ${msg}. Your funds are safe.`);
    }
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const assetLabel = (a: string) => (a.startsWith("0x") ? short(a) : a);
