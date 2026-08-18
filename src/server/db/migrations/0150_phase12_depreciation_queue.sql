-- ---------------------------------------------------------------------------
-- Phase 12.3 — depreciation as a scheduled background job (§18, Phase 01.10).
--
-- The run is long and touches every asset in a branch, so it belongs on the
-- 01.10 queue rather than in a request. Retries are cheap and safe:
-- `asset_depreciation` is unique on (asset, period end), so a redelivery
-- charges nothing a second time.
--
-- Support may retry it. A depreciation run that failed halfway has posted the
-- assets it reached and skipped none silently — running it again finishes the
-- period, and running it again after that does nothing at all.
-- ---------------------------------------------------------------------------
INSERT INTO job_queue
  (name, description, owner_role, retry_limit, retry_delay_seconds, retry_backoff,
   target_seconds, retryable_by_support) VALUES
  ('assets.depreciation',
   'Runs the monthly depreciation charge for a period and branch (§18.5). Idempotent: a repeat delivery charges nothing twice.',
   'accounting_manager', 3, 300, true, 7200, true)
ON CONFLICT (name) DO NOTHING;
