-- Sprint A4 Correction 2 — the durable free-attempt claim (tombstone).
--
-- Additive and forward-only. Creates one table, one trigger function, and
-- one trigger. Nothing is renamed, rewritten, backfilled, or deleted, and no
-- existing constraint is relaxed.
--
-- WHY A THIRD ACQUISITION MIGRATION
--
-- Correction 1 made "at most one free-concept generation job per session" a
-- PostgreSQL invariant with a partial unique index on
-- `generation_jobs.acquisition_session_id`. A re-audit found the remaining
-- hole: THAT INDEX ONLY CONSTRAINS ROWS THAT EXIST. Delete the free job and
-- the index has nothing left to enforce, so a direct insert can hand the
-- same session a second free concept.
--
-- The application's own consumed marker survives job deletion (Correction 1
-- deliberately removed its foreign key), so the customer-facing state stayed
-- correct — but an application pre-check is not authority. The database has
-- to have the opinion, and it has to keep having it after the job is gone.
--
-- WHY A SEPARATE TABLE RATHER THAN RESTRICTING JOB DELETION
--
-- The obvious alternative is `ON DELETE RESTRICT` from the claim to the job,
-- making the free job undeletable forever. That buys the invariant by
-- imposing permanent retention on an operational table — every future
-- data-retention, GDPR-erasure, or cleanup routine would have to special-case
-- generation jobs that happen to be acquisition jobs, and would fail
-- confusingly when it did not.
--
-- A claim owned by the SESSION does not have that cost. It holds no foreign
-- key to the job at all: the job id it records is historical evidence for
-- audit and reconciliation, and the row remains perfectly valid — and
-- perfectly enforcing — after the job it names has been deleted. Deleting
-- history is then an operational choice with an operational consequence (the
-- job is unrecoverable), never an entitlement consequence (another free
-- image).
--
-- WHY THE CLAIM IS TAKEN BY A TRIGGER
--
-- Claim and job must be created ATOMICALLY. Two separate application writes
-- reintroduce exactly the crash window Correction 1 closed, in mirror image:
--
--   claim first, then job   a crash between them burns the customer's free
--                           concept for a failure that was ours.
--   job first, then claim   a crash between them leaves an executable job
--                           with no claim — the original defect.
--
-- A `BEFORE INSERT` trigger on `generation_jobs` puts both in one statement
-- and one transaction. The claim's PRIMARY KEY is what refuses the second
-- attempt: the insert into this table raises `unique_violation`, which
-- aborts the `generation_jobs` insert that provoked it. There is no window,
-- and no ordering to get wrong.

-- ---------------------------------------------------------------------------
-- 1. The claim.
-- ---------------------------------------------------------------------------

create table if not exists public.acquisition_free_concept_claims (
  -- PRIMARY KEY, not merely a reference. This single column IS the
  -- invariant: one row per session, so one free attempt per session, for the
  -- lifetime of the session rather than the lifetime of a job.
  acquisition_session_id uuid primary key
    references public.acquisition_sessions (id) on delete restrict,

  -- The job that took the claim. Deliberately NOT a foreign key, and
  -- deliberately nullable: it is audit evidence, not a live relationship. If
  -- the job is later deleted this keeps pointing at an id that no longer
  -- resolves, which is the honest record of what happened and is exactly
  -- what lets the claim outlive it.
  generation_job_id uuid null,

  claimed_at timestamptz not null default now()
);

comment on table public.acquisition_free_concept_claims is
  'Sprint A4 Correction 2: the durable, session-owned tombstone for the ONE free concept attempt. Its primary key is the lifetime entitlement authority — it survives deletion of the generation job that took it, which the partial unique index on generation_jobs cannot. Taken atomically by a BEFORE INSERT trigger on generation_jobs.';

comment on column public.acquisition_free_concept_claims.generation_job_id is
  'Sprint A4 Correction 2: historical evidence only, intentionally NOT a foreign key. Keeps its value after the job is deleted; a dangling id here is correct, not corruption.';

-- ---------------------------------------------------------------------------
-- 2. Atomic claim on free-concept job insert.
-- ---------------------------------------------------------------------------
--
-- SECURITY MODEL, stated explicitly because triggers are easy to get wrong:
--
--   * SECURITY INVOKER (the default — NOT `SECURITY DEFINER`). The only role
--     that writes `generation_jobs` is `service_role`, which holds BYPASSRLS
--     and can therefore write this table too. `SECURITY DEFINER` would run
--     the body with the function owner's privileges, creating an escalation
--     path that buys nothing here. It is not used, and must not be added
--     later "to make the trigger work" — if the trigger ever cannot write
--     this table, the correct response is that the caller had no business
--     inserting the job.
--
--   * No grants are issued to `anon` or `authenticated`, on the table or the
--     function. The server-only contract (20260811191500) is unchanged.
--
--   * `search_path` is pinned so the function cannot be redirected to a
--     shadowed table by a caller-controlled search path.
--
-- BEHAVIOUR:
--
--   NEW.acquisition_session_id IS NULL   → returns immediately. Every
--     ordinary, internal, and legacy job takes this path and is completely
--     unaffected.
--
--   otherwise                            → inserts the claim. A second free
--     job for the same session violates the primary key, the exception
--     propagates, and the `generation_jobs` INSERT is aborted.
--
-- Note there is NO `on conflict do nothing`: swallowing the conflict is
-- precisely the bug. The conflict IS the refusal.

create or replace function public.claim_acquisition_free_concept()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.acquisition_session_id is null then
    return new;
  end if;

  insert into public.acquisition_free_concept_claims
    (acquisition_session_id, generation_job_id)
  values (new.acquisition_session_id, new.id);

  return new;
end;
$$;

comment on function public.claim_acquisition_free_concept() is
  'Sprint A4 Correction 2: atomically takes the session''s one free-concept claim as part of the generation_jobs INSERT. SECURITY INVOKER by design. A duplicate claim raises unique_violation and aborts the insert — that refusal is the entitlement authority.';

drop trigger if exists claim_acquisition_free_concept_trigger on public.generation_jobs;

create trigger claim_acquisition_free_concept_trigger
  before insert on public.generation_jobs
  for each row
  execute function public.claim_acquisition_free_concept();

-- ---------------------------------------------------------------------------
-- 3. Server-only RLS lockdown (see 20260811191500).
-- ---------------------------------------------------------------------------
--
-- Same convention every new application table follows: RLS enabled with zero
-- policies denies every row to every non-bypassing role, and revoking the
-- Data API grants is the second, independent control. `service_role` holds
-- BYPASSRLS and is unaffected, which is what keeps the trigger working.

alter table public.acquisition_free_concept_claims enable row level security;
revoke all privileges on table public.acquisition_free_concept_claims from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. What is NOT changed, and why.
-- ---------------------------------------------------------------------------
--
-- The partial unique index `generation_jobs_acquisition_free_concept_idx`
-- from 20260814180000 is KEPT. It is now redundant for lifetime authority —
-- the claim table covers that, including after deletion — but it remains a
-- cheap, independent second control while the job exists, and it is the
-- index that makes `getFreeConceptGenerationJob` a single-row lookup.
-- Removing a working constraint to tidy up would trade a real guarantee for
-- an aesthetic one.
--
-- `acquisition_sessions.free_concept_consumed_at` is also KEPT. It remains
-- the customer-state and audit marker ("when did this happen"), and it is
-- still written after the job insert. It is explicitly NOT the authority:
-- the claim row is, and the application reconciles from the claim.
