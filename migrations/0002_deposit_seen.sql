-- 0002_deposit_seen — track last-seen balances so the deposit watcher can
-- notify users when new funds arrive.

CREATE TABLE IF NOT EXISTS deposit_seen (
  telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
  chain       TEXT NOT NULL,          -- 'SOL' | 'RH'
  asset       TEXT NOT NULL,          -- 'SOL' | 'ETH' | token address
  last_amount NUMERIC NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, chain, asset)
);
