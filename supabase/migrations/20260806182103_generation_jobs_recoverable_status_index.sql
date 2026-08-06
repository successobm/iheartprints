-- Follow-up to 20260805140000_background_generation_jobs.sql.
--
-- PostgreSQL requires the transaction that adds enum value 'recoverable'
-- to commit before that value can be referenced in indexes (SQLSTATE
-- 55P04). This migration runs after that commit and installs the claim
-- queue partial index unchanged in intent from the original Part 2A design.

create index if not exists generation_jobs_status_created_at_idx
  on public.generation_jobs (status, created_at)
  where status in ('queued', 'recoverable');
