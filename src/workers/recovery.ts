/**
 * Order recovery — makes trades resumable. A crash/restart mid-buy or mid-sell
 * leaves an order in a non-terminal state (submitted/bridging/swapping). This
 * worker reconciles each against ground truth (Relay intent status or the tx
 * receipt) and drives it to filled/refunded/failed, notifying the user.
 */
import { findStuckOrders, updateOrder, withAdvisoryLock, type OrderRow } from "../db/index.js";
import { relayStatus } from "../bridge/relay.js";
import { txSucceeded } from "../chain/explorer.js";
import { logger } from "../logger.js";
import type { WorkerDeps } from "./types.js";

// Give an order this long in a non-terminal state before we reconcile it.
const STALE_SECONDS = 90;
// After this long with no resolution, mark it failed so it stops being retried.
const GIVE_UP_SECONDS = 60 * 30;

export async function recoverOrders(deps: WorkerDeps): Promise<void> {
  const stuck = await findStuckOrders(STALE_SECONDS);
  for (const o of stuck) {
    try {
      // Advisory lock so multiple worker instances can't double-reconcile/notify.
      await withAdvisoryLock(`order:${o.id}`, () => reconcile(o, deps));
    } catch (err) {
      logger.error({ err, orderId: o.id }, "recovery: reconcile failed");
    }
  }
}

async function reconcile(o: OrderRow, deps: WorkerDeps): Promise<void> {
  const ageMs = Date.now() - new Date(o.updated_at).getTime();

  // Cross-chain leg: trust the Relay intent status.
  if (o.relay_request_id) {
    const { status } = await relayStatus(o.relay_request_id);
    if (status === "success") {
      await updateOrder(o.id, { status: "filled" });
      await deps.notify(Number(o.telegram_id), `✅ Your ${o.side} of ${o.token_symbol ?? "token"} completed.`);
      return;
    }
    if (status === "refund" || status === "failure") {
      await updateOrder(o.id, { status: "refunded", error: `relay ${status}` });
      await deps.notify(
        Number(o.telegram_id),
        `↩️ Your ${o.side} of ${o.token_symbol ?? "token"} didn't fill — funds were refunded/settled.`
      );
      return;
    }
    // still pending — leave it, unless it's ancient
  } else if (o.tx_hashes.length > 0) {
    // Same-chain leg: check the last tx receipt.
    const last = o.tx_hashes[o.tx_hashes.length - 1]!;
    if (last.startsWith("0x")) {
      const ok = await txSucceeded(last).catch(() => false);
      if (ok) {
        await updateOrder(o.id, { status: "filled" });
        await deps.notify(Number(o.telegram_id), `✅ Your ${o.side} of ${o.token_symbol ?? "token"} confirmed.`);
        return;
      }
    }
  }

  if (ageMs > GIVE_UP_SECONDS * 1000) {
    await updateOrder(o.id, { status: "failed", error: "recovery timed out" });
    await deps.notify(
      Number(o.telegram_id),
      `⚠️ Your ${o.side} of ${o.token_symbol ?? "token"} could not be confirmed. No further action will be taken — please check /positions.`
    );
  }
}
