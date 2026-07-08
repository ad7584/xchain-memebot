/** Postgres pool + typed data-access helpers. */
import pg from "pg";
import { config } from "../config.js";
import { logger } from "../logger.js";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

pool.on("error", (err) => logger.error({ err }, "pg pool error"));

export type FundingAsset = "SOL" | "RH_ETH";
export type OrderSide = "buy" | "sell";

export interface UserRow {
  telegram_id: string;
  username: string | null;
  turnkey_suborg_id: string | null;
  sol_pubkey: string | null;
  evm_eoa: string | null;
  rh_smart_account: string | null;
  twofa_secret: string | null;
  sol_secret_enc: string | null;
  evm_secret_enc: string | null;
  settings: Record<string, unknown>;
}

export async function getUser(telegramId: number): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(
    "SELECT * FROM users WHERE telegram_id = $1",
    [telegramId]
  );
  return rows[0] ?? null;
}

export async function upsertUser(u: {
  telegramId: number;
  username?: string;
  suborgId?: string;
  solPubkey: string;
  evmEoa: string;
  rhSmartAccount?: string;
  solSecretEnc?: string;
  evmSecretEnc?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO users (telegram_id, username, turnkey_suborg_id, sol_pubkey, evm_eoa, rh_smart_account, sol_secret_enc, evm_secret_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       turnkey_suborg_id = COALESCE(users.turnkey_suborg_id, EXCLUDED.turnkey_suborg_id),
       sol_pubkey = COALESCE(users.sol_pubkey, EXCLUDED.sol_pubkey),
       evm_eoa = COALESCE(users.evm_eoa, EXCLUDED.evm_eoa),
       rh_smart_account = COALESCE(users.rh_smart_account, EXCLUDED.rh_smart_account),
       sol_secret_enc = COALESCE(users.sol_secret_enc, EXCLUDED.sol_secret_enc),
       evm_secret_enc = COALESCE(users.evm_secret_enc, EXCLUDED.evm_secret_enc)`,
    [
      u.telegramId,
      u.username ?? null,
      u.suborgId ?? null,
      u.solPubkey,
      u.evmEoa,
      u.rhSmartAccount ?? null,
      u.solSecretEnc ?? null,
      u.evmSecretEnc ?? null,
    ]
  );
}

export async function createOrder(o: {
  telegramId: number;
  side: OrderSide;
  fundingAsset: FundingAsset;
  tokenAddress: string;
  tokenSymbol?: string;
  amountIn: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO orders (telegram_id, side, funding_asset, token_address, token_symbol, amount_in)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [o.telegramId, o.side, o.fundingAsset, o.tokenAddress, o.tokenSymbol ?? null, o.amountIn]
  );
  return rows[0]!.id;
}

export async function updateOrder(
  id: string,
  patch: Partial<{
    status: string;
    relay_request_id: string;
    amount_out: string;
    quote: unknown;
    error: string;
    tx_hash: string; // appended to tx_hashes[]
  }>
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "tx_hash") {
      vals.push(JSON.stringify([v]));
      sets.push(`tx_hashes = tx_hashes || $${i++}::jsonb`);
    } else if (k === "quote") {
      vals.push(JSON.stringify(v));
      sets.push(`quote = $${i++}::jsonb`);
    } else {
      vals.push(v);
      sets.push(`${k} = $${i++}`);
    }
  }
  vals.push(id);
  await pool.query(`UPDATE orders SET ${sets.join(", ")} WHERE id = $${i}`, vals);
}

/** Increase a position after a buy (books, not on-chain truth). */
export async function addToPosition(p: {
  telegramId: number;
  tokenAddress: string;
  fundingAsset: FundingAsset;
  tokenSymbol?: string;
  tokensDelta: string;
  costDelta: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO positions (telegram_id, token_address, funding_asset, token_symbol, amount_tokens, cost_basis)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (telegram_id, token_address, funding_asset) DO UPDATE SET
       amount_tokens = positions.amount_tokens + EXCLUDED.amount_tokens,
       cost_basis    = positions.cost_basis + EXCLUDED.cost_basis,
       token_symbol  = COALESCE(EXCLUDED.token_symbol, positions.token_symbol),
       updated_at    = now()`,
    [p.telegramId, p.tokenAddress, p.fundingAsset, p.tokenSymbol ?? null, p.tokensDelta, p.costDelta]
  );
}

export interface PositionRow {
  token_address: string;
  funding_asset: FundingAsset;
  token_symbol: string | null;
  amount_tokens: string;
  cost_basis: string;
  realized_pnl: string;
}

export async function getPositions(telegramId: number): Promise<PositionRow[]> {
  const { rows } = await pool.query<PositionRow>(
    `SELECT token_address, funding_asset, token_symbol, amount_tokens, cost_basis, realized_pnl
     FROM positions WHERE telegram_id = $1 AND amount_tokens > 0
     ORDER BY updated_at DESC`,
    [telegramId]
  );
  return rows;
}

export async function getPosition(
  telegramId: number,
  tokenAddress: string,
  fundingAsset: FundingAsset
): Promise<PositionRow | null> {
  const { rows } = await pool.query<PositionRow>(
    `SELECT token_address, funding_asset, token_symbol, amount_tokens, cost_basis, realized_pnl
     FROM positions WHERE telegram_id=$1 AND token_address=$2 AND funding_asset=$3`,
    [telegramId, tokenAddress, fundingAsset]
  );
  return rows[0] ?? null;
}

// --- 2FA ---------------------------------------------------------------------
export async function setTwoFactorSecret(telegramId: number, encSecret: string): Promise<void> {
  await pool.query("UPDATE users SET twofa_secret=$2 WHERE telegram_id=$1", [
    telegramId,
    encSecret,
  ]);
}

// --- Withdrawals -------------------------------------------------------------
export type WithdrawChain = "SOL" | "RH";
export interface WithdrawalRow {
  id: string;
  telegram_id: string;
  chain: WithdrawChain;
  asset: string;
  amount: string;
  destination: string;
  status: "pending" | "ready" | "sent" | "cancelled" | "failed";
  execute_after: string;
  tx_hash: string | null;
}

export async function createWithdrawal(w: {
  telegramId: number;
  chain: WithdrawChain;
  asset: string;
  amount: string;
  destination: string;
  delaySeconds: number;
}): Promise<WithdrawalRow> {
  const { rows } = await pool.query<WithdrawalRow>(
    `INSERT INTO withdrawals (telegram_id, chain, asset, amount, destination, execute_after)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)
     RETURNING *`,
    [w.telegramId, w.chain, w.asset, w.amount, w.destination, String(w.delaySeconds)]
  );
  return rows[0]!;
}

/**
 * Claim withdrawals to broadcast. Atomic (FOR UPDATE SKIP LOCKED) so multiple
 * worker instances never double-send. Picks up both (a) pending whose delay has
 * elapsed and (b) rows orphaned in 'ready' >10min (a worker crashed mid-send).
 */
export async function claimReadyWithdrawals(limit = 10): Promise<WithdrawalRow[]> {
  const { rows } = await pool.query<WithdrawalRow>(
    `UPDATE withdrawals SET status='ready', updated_at=now()
     WHERE id IN (
       SELECT id FROM withdrawals
       WHERE (status='pending' AND execute_after <= now())
          OR (status='ready' AND updated_at < now() - interval '10 minutes')
       ORDER BY execute_after ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [limit]
  );
  return rows;
}

export async function setWithdrawalStatus(
  id: string,
  status: WithdrawalRow["status"],
  txHash?: string
): Promise<void> {
  await pool.query("UPDATE withdrawals SET status=$2, tx_hash=COALESCE($3, tx_hash) WHERE id=$1", [
    id,
    status,
    txHash ?? null,
  ]);
}

export async function listUserWithdrawals(telegramId: number, limit = 10): Promise<WithdrawalRow[]> {
  const { rows } = await pool.query<WithdrawalRow>(
    "SELECT * FROM withdrawals WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT $2",
    [telegramId, limit]
  );
  return rows;
}

// --- Order recovery ----------------------------------------------------------
export interface OrderRow {
  id: string;
  telegram_id: string;
  side: OrderSide;
  funding_asset: FundingAsset;
  token_address: string;
  token_symbol: string | null;
  status: string;
  relay_request_id: string | null;
  tx_hashes: string[];
  updated_at: string;
}

/** Orders stuck mid-flight (not terminal) older than `staleSeconds`. */
export async function findStuckOrders(staleSeconds = 60, limit = 25): Promise<OrderRow[]> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT id, telegram_id, side, funding_asset, token_address, token_symbol,
            status, relay_request_id, tx_hashes, updated_at
     FROM orders
     WHERE status IN ('submitted','bridging','swapping','signed','quoted')
       AND updated_at < now() - ($1 || ' seconds')::interval
     ORDER BY updated_at ASC LIMIT $2`,
    [String(staleSeconds), limit]
  );
  return rows;
}

// --- Deposit detection -------------------------------------------------------
/** Returns the last-seen base-unit amount, or null if we've never scanned it. */
export async function getDepositSeen(
  telegramId: number,
  chain: string,
  asset: string
): Promise<bigint | null> {
  const { rows } = await pool.query<{ last_amount: string }>(
    "SELECT last_amount FROM deposit_seen WHERE telegram_id=$1 AND chain=$2 AND asset=$3",
    [telegramId, chain, asset]
  );
  return rows[0] ? BigInt(rows[0].last_amount) : null;
}

export async function setDepositSeen(
  telegramId: number,
  chain: string,
  asset: string,
  amount: bigint
): Promise<void> {
  await pool.query(
    `INSERT INTO deposit_seen (telegram_id, chain, asset, last_amount)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id, chain, asset)
     DO UPDATE SET last_amount=EXCLUDED.last_amount, updated_at=now()`,
    [telegramId, chain, asset, amount.toString()]
  );
}

/**
 * Atomically advance the last-seen amount to `current`. Returns the PRIOR amount
 * IF this call is the one that advanced it (⇒ caller should notify of the
 * increase), or null otherwise (first observation / no increase / lost the race).
 * Prevents multiple worker instances from double-notifying the same deposit.
 */
export async function advanceDepositSeen(
  telegramId: number,
  chain: string,
  asset: string,
  current: bigint
): Promise<bigint | null> {
  const { rows } = await pool.query<{ old_amount: string }>(
    `WITH cur AS (
       SELECT last_amount FROM deposit_seen
       WHERE telegram_id=$1 AND chain=$2 AND asset=$3
     ),
     ins AS (
       INSERT INTO deposit_seen (telegram_id, chain, asset, last_amount)
       SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM cur)
       RETURNING last_amount
     ),
     upd AS (
       UPDATE deposit_seen SET last_amount=$4, updated_at=now()
       WHERE telegram_id=$1 AND chain=$2 AND asset=$3 AND last_amount < $4
       RETURNING (SELECT last_amount FROM cur) AS old_amount
     )
     SELECT old_amount FROM upd`,
    [telegramId, chain, asset, current.toString()]
  );
  return rows[0] ? BigInt(rows[0].old_amount) : null;
}

/**
 * Run `fn` while holding a Postgres session advisory lock on `key`, on a
 * dedicated connection. If another session already holds it, `fn` is skipped and
 * `null` is returned. Used to serialize per-order recovery across instances.
 */
export async function withAdvisoryLock<T>(
  key: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ got: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS got",
      [key]
    );
    if (!rows[0]?.got) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

export async function allUsers(): Promise<UserRow[]> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE sol_pubkey IS NOT NULL");
  return rows;
}
