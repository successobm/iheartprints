-- "Separate Provider Recovery Attempt Budget" — additive only. Does not
-- edit or rename any previously applied migration.
--
-- FinalArtworkJob.attempts (bumped on every claim, see
-- claimNextQueuedFinalArtworkJob) was designed as a generic worker-crash
-- recovery-loop guard, but MAX_FINAL_ARTWORK_ATTEMPTS also used it as the
-- ONLY ceiling protecting against repeated paid provider submission. That
-- conflates two different things: a claim that could still issue a fresh
-- paid submission, and a claim that can only poll/download an EXISTING,
-- already-paid provider request (Topaz) whose local readback failed for an
-- infrastructure reason. A job whose download kept transient-failing could
-- exhaust the SAME generic counter a genuinely stuck/crashing job would,
-- permanently blocking recovery of an already-billed result.
--
-- This column gives resume/recovery its own separate, bounded budget: how
-- many claims have attempted to poll/download the job's CURRENT
-- provider_request_id (never a fresh submission). See
-- MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS in
-- final-artwork-worker-capability.ts and FinalArtworkJob's domain doc in
-- src/lib/domain/types.ts.

alter table public.final_artwork_jobs
  add column if not exists provider_recovery_attempts integer not null default 0;
