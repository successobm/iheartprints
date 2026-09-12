-- Phase R5 (Confirmed-Authority Raster Reconstruction v1): the durable job
-- table backing `RasterReconstructionCapability`/
-- `RasterReconstructionWorkerCapability`. Additive and forward-only. Builds
-- NO DTF/Signs wiring, calls NO Topaz, and changes NO Print Ready authority
-- of any kind — see this phase's own report for the full boundary.
--
-- WHY THIS IS A NEW TABLE, NOT AN EXTENSION OF `final_artwork_jobs`
--
-- `final_artwork_jobs` derives `source_kind` from exactly one of three
-- mutually-exclusive authority foreign keys (`final_direction_approval_id`
-- / `artwork_preparation_id` / `sign_preparation_id`), and carries columns
-- (`production_width_in`, `production_treatment_key`,
-- `requested_production_output`, `artwork_version_id`, `sign_plan_key`)
-- that are meaningful ONLY once a customer has already committed to a DTF
-- or Signs production path. A reconstruction job runs BEFORE that branch —
-- against the canonical original source asset, under confirmed Artwork
-- Fidelity Contract authority, and knows nothing about DTF or Signs. Adding
-- a fourth authority arm to `final_artwork_jobs` would require altering
-- that table's own "exactly one of N" CHECK constraint and touch a
-- production-critical table this phase is explicitly forbidden from
-- rewiring. A small, independent table with the SAME proven claim/
-- heartbeat/attempt-budget SHAPE (mirrors `final_artwork_jobs` structurally,
-- never by inheritance) is the smaller, safer, more isolated choice — see
-- the R5 report's own "L. JOB DESIGN" section for the full reasoning.
--
-- SCHEMA DISCIPLINE AUDIT
--
-- 1. WHAT MUST SURVIVE RELOAD
--
--    - which immutable source asset/bytes this job reconstructs, and that
--      source's own sha256 (re-verified fresh before every provider call —
--      never trusted stale)
--    - which CONFIRMED Artwork Fidelity Contract this job is bound to, and
--      that contract's own `contract_key` at the moment the job was
--      created — so a later contract change (a correction) can be detected
--      as making this job's authority stale, mirroring
--      `sign_preparations.plan_key`'s own staleness precedent
--    - durable paid-provider request identity (`provider_key`/
--      `provider_request_id`/`provider_status`), so a worker crash/race
--      between submitting a paid reconstruction request and persisting its
--      resulting candidate asset never causes a second paid request on
--      retry/recovery — the exact `final_artwork_jobs` precedent
--    - the resulting candidate `AssetRecord` id, once one exists
--    - the CUSTOMER'S post-reconstruction review decision
--      (`review_status`), which is genuinely different authority from
--      whether the provider call itself succeeded (Section 17 of the R5
--      task: "customer confirming what source says BEFORE reconstruction
--      is different from customer approving reconstructed appearance
--      AFTER reconstruction" — this table is the second of those, never
--      the first)
--
-- 2. WHY `artwork_fidelity_contracts`/`assets` CANNOT REPRESENT IT HONESTLY
--
--    `artwork_fidelity_contracts` is confirmed-authority-only — durable
--    intent proof, never a job queue, and its own capability doc is
--    explicit that it has "NO provider port of any kind." `assets` is
--    APPEND-ONLY (Constitution §6.11 — no method exists to update an
--    already-created asset's metadata), which cannot represent a mutable
--    job lifecycle (queued -> running -> completed) or a customer decision
--    that arrives strictly after the candidate asset already exists.
--
-- 3. SMALLEST ADDITIVE SCHEMA
--
--    ONE table, mirroring `final_artwork_jobs`' proven status/claim/
--    heartbeat/attempt-budget shape exactly, plus the fidelity-contract
--    binding and review-decision fields this job type alone needs.

create table if not exists public.artwork_reconstruction_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  -- The immutable original source this job reconstructs. Never patched —
  -- a different source is a different job, mirroring
  -- `artwork_fidelity_contracts.source_asset_id`'s own immutability.
  source_asset_id uuid not null references public.assets (id) on delete restrict,
  -- Measured fresh from the source's own bytes at job-creation time, so a
  -- later re-verification (before the provider is ever called) can prove
  -- the source has not changed underneath this job.
  source_sha256 text not null,

  -- The CONFIRMED fidelity contract this job's authority derives from.
  -- Never a `proposed` contract (enforced at the capability layer, not by
  -- a DB CHECK here, since verifying "the referenced row's OWN status" is
  -- an application-layer join, not a column-local constraint).
  fidelity_contract_id uuid not null references public.artwork_fidelity_contracts (id) on delete restrict,
  -- Snapshotted at job-creation time from the contract's own `contract_key`
  -- — frozen so a LATER contract correction (a new confirmed contract,
  -- since a confirmed contract is itself immutable) can be detected as
  -- making this job stale, exactly like `sign_preparations.plan_key`.
  contract_key text not null,

  -- 'queued'/'running'/'recoverable'/'completed'/'failed'/'cancelled' —
  -- the SAME six-value vocabulary as `final_artwork_jobs.status`.
  status text not null default 'queued'
    check (status in ('queued', 'running', 'recoverable', 'completed', 'failed', 'cancelled')),

  attempts integer not null default 0,
  last_error text null,
  started_at timestamptz null,
  completed_at timestamptz null,
  heartbeat_at timestamptz null,

  -- Durable paid-provider request identity — the `final_artwork_jobs`
  -- precedent verbatim, so a crash/race between submitting a paid
  -- reconstruction request and persisting its resulting candidate never
  -- causes a second paid request on retry/recovery.
  provider_key text null,
  provider_request_id text null,
  provider_status text null,
  provider_recovery_attempts integer not null default 0,

  -- The resulting reconstruction candidate, once the provider succeeds and
  -- normalization/wording-verification has run. Null until then. Never
  -- overwritten once set — a corrected/retried reconstruction is a NEW job
  -- row, mirroring how a fidelity correction is a new contract row.
  candidate_asset_id uuid null references public.assets (id) on delete set null,

  -- Deterministic, sanitized-only evidence computed once the candidate
  -- exists — never a raw provider body, never prompt text.
  wording_verified boolean null,
  geometry_status text null
    check (geometry_status is null or geometry_status in ('verified', 'review_required')),

  -- The customer's POST-reconstruction decision — genuinely separate
  -- authority from `status` (which only tracks whether the PROVIDER call
  -- succeeded). 'pending_review' the moment a candidate exists;
  -- 'approved'/'rejected' only via an explicit customer action. Null until
  -- a candidate exists at all.
  review_status text null
    check (review_status is null or review_status in ('pending_review', 'approved', 'rejected')),
  reviewed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Status-consistency invariant, the same `artwork_fidelity_contracts
  -- _confirmation_consistent` precedent applied to this job's own
  -- lifecycle: a terminal 'completed' job must carry a candidate asset and
  -- a review status; every other status must not (a review decision can
  -- only ever be about a candidate that actually exists).
  constraint artwork_reconstruction_jobs_completion_consistent check (
    (
      status = 'completed'
      and candidate_asset_id is not null
      and review_status is not null
    )
    or
    (
      status != 'completed'
      and candidate_asset_id is null
      and review_status is null
      and reviewed_at is null
    )
  )
);

create index if not exists artwork_reconstruction_jobs_project_id_created_at_idx
  on public.artwork_reconstruction_jobs (project_id, created_at desc);

create index if not exists artwork_reconstruction_jobs_source_asset_id_idx
  on public.artwork_reconstruction_jobs (source_asset_id);

create index if not exists artwork_reconstruction_jobs_status_idx
  on public.artwork_reconstruction_jobs (status);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention `20260811191500_server_only_rls_lockdown.sql` established and
-- `security-lockdown.migration.test.ts` enforces for every table created
-- after it.
alter table public.artwork_reconstruction_jobs enable row level security;
revoke all privileges on table public.artwork_reconstruction_jobs from anon, authenticated;
