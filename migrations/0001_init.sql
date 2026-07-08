-- 0001_init — base schema (idempotent).

CREATE TABLE IF NOT EXISTS users (
  telegram_id        BIGINT PRIMARY KEY,
  username           TEXT,
  turnkey_suborg_id  TEXT,
  sol_pubkey         TEXT,
  evm_eoa            TEXT,
  rh_smart_account   TEXT,
  twofa_secret       TEXT,
  settings           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id      BIGINT NOT NULL REFERENCES users(telegram_id),
  side             TEXT NOT NULL CHECK (side IN ('buy','sell')),
  funding_asset    TEXT NOT NULL CHECK (funding_asset IN ('SOL','RH_ETH')),
  token_address    TEXT NOT NULL,
  token_symbol     TEXT,
  amount_in        NUMERIC NOT NULL,
  amount_out       NUMERIC,
  status           TEXT NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','quoted','signed','submitted',
                                       'bridging','swapping','filled','refunded','failed')),
  relay_request_id TEXT,
  tx_hashes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  quote            JSONB,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, updated_at);

CREATE TABLE IF NOT EXISTS positions (
  telegram_id      BIGINT NOT NULL REFERENCES users(telegram_id),
  token_address    TEXT NOT NULL,
  funding_asset    TEXT NOT NULL CHECK (funding_asset IN ('SOL','RH_ETH')),
  token_symbol     TEXT,
  amount_tokens    NUMERIC NOT NULL DEFAULT 0,
  cost_basis       NUMERIC NOT NULL DEFAULT 0,
  realized_pnl     NUMERIC NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (telegram_id, token_address, funding_asset)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
  chain         TEXT NOT NULL CHECK (chain IN ('SOL','RH')),
  asset         TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  destination   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ready','sent','cancelled','failed')),
  execute_after TIMESTAMPTZ NOT NULL,
  tx_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawals_due_idx ON withdrawals(status, execute_after);

CREATE TABLE IF NOT EXISTS fee_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID REFERENCES orders(id),
  bps         INT NOT NULL,
  amount      NUMERIC NOT NULL,
  asset       TEXT NOT NULL,
  treasury    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
