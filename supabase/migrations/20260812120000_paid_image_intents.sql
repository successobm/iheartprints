-- Phase 2C0.5: paid image idempotency + spend bound hardening.
-- Additive only. Creates one new table; edits, renames, and rewrites
-- nothing that already exists. No customer data is read or mutated.
--
-- WHY A MIGRATION WAS REQUIRED
--
-- Generation-job ENQUEUE was already idempotent, but paid EXECUTION was
-- not. Initial concept generation dispatches three directions
-- sequentially; OpenAI can bill Bold and Soft successfully and then
-- Minimal can fail. Nothing durable recorded that Bold and Soft had
-- already been bought, so a reclaim of that same job regenerated — and
-- re-billed — all three.
--
-- No existing table could carry that fact safely:
--
--   generation_jobs   one row per JOB. Cannot represent three
--                     independently-completed paid units.
--   artwork_versions  written once, in a single batch, only AFTER every
--                     direction has already succeeded — precisely the
--                     window that has to be checkpointed. Making them
--                     per-direction would also change customer-visible
--                     behavior (a partially-completed concept set), which
--                     this phase explicitly must not do.
--   assets            written per direction, but only AFTER the paid call
--                     returns, carry no direction identity, and have no
--                     uniqueness constraint that could make a paid call
--                     at-most-once.
--
-- And it could not be done race-safely without a migration: the guarantee
-- rests on the database refusing a duplicate intent, which needs a real
-- UNIQUE constraint. Correctness and spend safety win over avoiding a
-- migration.

create table if not exists public.paid_image_intents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  generation_job_id uuid not null references public.generation_jobs (id) on delete cascade,

  -- Deterministic logical identity. Built only from durable facts
  -- (project, job, generation kind, epoch, direction, revision target) —
  -- never from an attempt number, timestamp, random UUID, or provider
  -- request id. See capabilities/shared/paid-image-intent.ts.
  intent_key text not null,
  intent_kind text not null
    check (intent_kind in ('initial_concept', 'targeted_revision', 'replacement')),
  direction_key text not null,

  -- 1-based slot inside this job's paid-intent budget. The unique
  -- constraint below is what makes budget allocation atomic: two racing
  -- workers computing the same next slot cannot both insert it.
  paid_intent_ordinal integer not null
    check (paid_intent_ordinal >= 1 and paid_intent_ordinal <= 5),

  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed')),

  -- Provider DISPATCHES for this one logical intent, across every worker,
  -- reclaim, and transport attempt combined. Bounded in application code
  -- by MAX_PAID_DISPATCHES_PER_INTENT; the check here is the backstop.
  dispatches integer not null default 0 check (dispatches >= 0 and dispatches <= 4),

  -- Fencing token for the live reservation. A zombie worker that resumes
  -- after its job was reclaimed holds a stale token, so its "I succeeded"
  -- write is refused instead of clobbering the newer worker's result.
  claim_token uuid null,

  provider_key text null,
  provider_request_id text null,

  -- SANITIZED concept envelope only: titles, direction, asset ids, asset
  -- dimensions. Never prompt text, never image bytes, never credentials.
  result jsonb null,

  last_error text null,
  succeeded_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The at-most-once guarantee itself.
  unique (project_id, intent_key),
  -- Atomic budget-slot allocation.
  unique (generation_job_id, paid_intent_ordinal)
);

create index if not exists paid_image_intents_job_idx
  on public.paid_image_intents (generation_job_id);

-- Server-Only RLS Lockdown (see 20260811191500): every application table is
-- server-only. RLS with zero policies denies every row to every
-- non-bypassing role; `service_role` holds BYPASSRLS and is unaffected.
-- Revoking the Data API grants is the second, independent control.
alter table public.paid_image_intents enable row level security;
revoke all privileges on table public.paid_image_intents from anon, authenticated;
