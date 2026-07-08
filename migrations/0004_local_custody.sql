-- 0004_local_custody — encrypted per-user keys for the local custody backend.
-- Values are AES-256-GCM ciphertext (ENCRYPTION_KEY); NULL when Turnkey custody
-- is used instead.

ALTER TABLE users ADD COLUMN IF NOT EXISTS sol_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_secret_enc TEXT;
