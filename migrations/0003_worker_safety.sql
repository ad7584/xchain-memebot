-- 0003_worker_safety — support safe multi-instance workers.

-- Reclaim withdrawals orphaned in 'ready' if a worker crashed before sending.
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
