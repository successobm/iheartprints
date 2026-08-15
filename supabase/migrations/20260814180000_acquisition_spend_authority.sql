-- Sprint A4 Correction 1 — acquisition spend authority.
--
-- Additive and forward-only. Adds one nullable column and one partial
-- unique index, and REPLACES four foreign-key rules that were written with
-- the wrong deletion semantics. No row is read, rewritten, backfilled, or
-- deleted.
--
-- WHY THIS CORRECTION EXISTS
--
-- An independent audit of 20260814120000 found four defects. All four are
-- the same underlying mistake: the free-concept entitlement was expressed as
-- APPLICATION state that the database had no opinion about, so every
-- guarantee depended on a write actually happening rather than on a
-- constraint that cannot be circumvented.
--
--   1. (P0) A free concept could consume up to THREE paid image dispatches.
--          `paidIntentBudgetForJob` derives the budget from `concept_count`
--          alone, so a one-concept job still carried the Phase 2C
--          replacement allowance of two. "One free concept" was true of the
--          customer-visible output and false of the money.
--
--   2. (P0) Job creation and consumption were two separate writes. If the
--          job insert succeeded and the consumption write failed, the
--          executable job remained while the session still read as
--          unconsumed — and could authorize a SECOND free job.
--
--   3. (P1) `free_concept_generation_job_id ON DELETE SET NULL` meant
--          deleting the job erased the record that the entitlement had been
--          spent.
--
--   4. (P1) `print_projects.acquisition_session_id ON DELETE SET NULL`
--          meant deleting a session silently converted every project bound
--          to it into a LEGACY project — which the application
--          grandfathers. Deleting a row could hand out unlimited free
--          generation.
--
-- THE CORRECTION, in one sentence: the database now owns "at most one free
-- concept job per acquisition session", and every marker that could be lost
-- or cleared is backed by a constraint that cannot be.

-- ---------------------------------------------------------------------------
-- 1. Bind the free-concept job to the session that paid for it.
-- ---------------------------------------------------------------------------
--
-- This single column does three jobs, which is why it is worth adding rather
-- than deriving any of them:
--
--   (a) IT IS THE AUTHORITY. The partial unique index below makes "at most
--       one free-concept generation job per acquisition session" a
--       PostgreSQL invariant. A second insert is refused by the database
--       under real concurrency — not by application code that read first and
--       hoped nothing changed. This is what closes defect 2: the consumption
--       marker may be missing, late, or lost, and a second free job is still
--       impossible.
--
--   (b) IT IS THE ECONOMICS FLAG. The generation worker must be able to ask
--       "is this the acquisition free-concept attempt?" from durable job
--       authority alone — never from request context, UI state, or a lookup
--       that might itself be the thing that failed. A non-null value here
--       means the paid-image budget for this job is exactly ONE dispatch
--       (see `paidIntentBudgetForGenerationJob`), and Phase 2C replacement
--       is not offered. This is what closes defect 1.
--
--   (c) IT IS THE RECONCILIATION SOURCE. "Has this session spent its free
--       concept?" is answerable from this column even when
--       `acquisition_sessions.free_concept_consumed_at` was never written.
--
-- `ON DELETE RESTRICT`, deliberately. Every other option destroys the
-- authority: `SET NULL` would silently convert the free job into an ordinary
-- one and free the unique slot for a second; `CASCADE` would delete a
-- customer's generation job as a side effect of session cleanup.
--
-- NULL means "not an acquisition free-concept job" — which is every job that
-- has ever existed, every internal job, every legacy-project job, and every
-- ordinary paid job. No backfill: there is nothing to say about them.

alter table public.generation_jobs
  add column if not exists acquisition_session_id uuid null
    references public.acquisition_sessions (id) on delete restrict;

comment on column public.generation_jobs.acquisition_session_id is
  'Sprint A4 Correction 1: the acquisition session whose ONE free concept this job spends. NULL = ordinary job. Non-null caps this job at exactly one paid image dispatch and bars Phase 2C replacement. Unique per session — the database-level authority that a session gets one free job, ever.';

-- THE INVARIANT. A partial unique index rather than a table constraint
-- because only non-acquisition rows may repeat, and Postgres treats NULLs as
-- distinct — so `unique (acquisition_session_id)` alone would already have
-- worked, but the explicit predicate documents the intent and keeps the
-- index off every ordinary job.
--
-- This is the whole correction for defect 2. Two racing requests, a
-- duplicated HTTP call, a retry after a failed consumption write, or a
-- customer who starts a second project all reach the same INSERT, and
-- exactly one of them can succeed.
create unique index if not exists generation_jobs_acquisition_free_concept_idx
  on public.generation_jobs (acquisition_session_id)
  where acquisition_session_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Consumption must survive job cleanup (defect 3).
-- ---------------------------------------------------------------------------
--
-- `free_concept_generation_job_id` was declared `references
-- public.generation_jobs (id) on delete set null`, so deleting the job
-- erased the only pointer recording that the entitlement had been spent.
--
-- The fix is to stop treating that column as a live relationship. It becomes
-- an IMMUTABLE HISTORICAL REFERENCE: the id of the job that spent the free
-- concept, retained for telemetry and audit, which stays truthful even after
-- the job it names is gone. `free_concept_consumed_at` is the authority for
-- "was it spent", and it is a timestamp nothing cascades to.
--
-- Dropping a foreign key rather than switching it to RESTRICT is deliberate.
-- RESTRICT would make an ordinary generation job undeletable forever, which
-- is a real operational cost imposed to protect a field that is not the
-- authority. The authority is the unique index in section 1 (which prevents
-- a second job existing) plus the consumed timestamp (which survives
-- everything).
--
-- The constraint was declared inline and is therefore auto-named, so it is
-- found by its exact column signature rather than by a guessed name — a
-- wrong hard-coded name would leave the bad rule silently in place.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'acquisition_sessions'
    and con.contype = 'f'
    and con.conkey = array(
      select attnum
      from pg_attribute
      where attrelid = rel.oid
        and attname = 'free_concept_generation_job_id'
    );

  if constraint_name is not null then
    execute format(
      'alter table public.acquisition_sessions drop constraint %I',
      constraint_name
    );
  end if;
end $$;

comment on column public.acquisition_sessions.free_concept_generation_job_id is
  'Sprint A4 Correction 1: IMMUTABLE historical reference to the job that spent the free concept. Deliberately NOT a foreign key — it must stay truthful after that job is cleaned up. Not the authority; free_concept_consumed_at is, and generation_jobs.acquisition_session_id enforces it.';

comment on column public.acquisition_sessions.free_concept_consumed_at is
  'Sprint A4 Correction 1: the durable "this session spent its free concept" marker. Nothing cascades to it and nothing clears it. Reconcilable from generation_jobs.acquisition_session_id if a crash prevented it being written.';

-- ---------------------------------------------------------------------------
-- 3. Deleting a session must not manufacture a legacy project (defect 4).
-- ---------------------------------------------------------------------------
--
-- `print_projects.acquisition_session_id` was `ON DELETE SET NULL`. The
-- application reads NULL as LEGACY — a project created before acquisition
-- sessions existed — and grandfathers it into unrestricted generation and
-- finalization. That reading is correct and necessary for genuinely
-- historical rows, and catastrophic if a NULL can be MANUFACTURED: deleting
-- one acquisition_sessions row would have converted every project bound to
-- it into an unlimited-free-generation project.
--
-- `ON DELETE RESTRICT` removes the possibility rather than mitigating it. A
-- session with projects bound to it cannot be deleted at all, so
-- `acquisition_session_id` transitions exactly once — from unset at
-- creation to set at creation — and never again.
--
-- The same reasoning applies to `acquisition_sessions.free_concept_project_id`
-- below: `SET NULL` there would clear an ALLOCATION when its project was
-- deleted, freeing the session to allocate again. Together these two rules
-- mean the project/session relationship is immutable once established, which
-- is what "durable authority" has to mean.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'print_projects'
    and con.contype = 'f'
    and con.conkey = array(
      select attnum
      from pg_attribute
      where attrelid = rel.oid
        and attname = 'acquisition_session_id'
    );

  if constraint_name is not null then
    execute format(
      'alter table public.print_projects drop constraint %I',
      constraint_name
    );
  end if;
end $$;

alter table public.print_projects
  add constraint print_projects_acquisition_session_id_fkey
    foreign key (acquisition_session_id)
    references public.acquisition_sessions (id)
    on delete restrict;

comment on column public.print_projects.acquisition_session_id is
  'Sprint A4 Correction 1: the acquisition session that created this project — the server-side authority every paid-value gate resolves from. ON DELETE RESTRICT: a deleted session must never be able to manufacture the NULL that means "legacy, grandfathered". NULL is reserved for projects that genuinely predate A4. A non-null id whose session cannot be loaded FAILS CLOSED in the application; it is not legacy.';

do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'acquisition_sessions'
    and con.contype = 'f'
    and con.conkey = array(
      select attnum
      from pg_attribute
      where attrelid = rel.oid
        and attname = 'free_concept_project_id'
    );

  if constraint_name is not null then
    execute format(
      'alter table public.acquisition_sessions drop constraint %I',
      constraint_name
    );
  end if;
end $$;

alter table public.acquisition_sessions
  add constraint acquisition_sessions_free_concept_project_id_fkey
    foreign key (free_concept_project_id)
    references public.print_projects (id)
    on delete restrict;

comment on column public.acquisition_sessions.free_concept_project_id is
  'Sprint A4 Correction 1: the project this session''s free concept is ALLOCATED to. ON DELETE RESTRICT: clearing this by deleting the project would free the session to allocate again. Allocation is still not consumption.';

-- ---------------------------------------------------------------------------
-- 4. No RLS or grant changes.
-- ---------------------------------------------------------------------------
--
-- `generation_jobs` and `acquisition_sessions` are already RLS-enabled with
-- zero policies and no `anon`/`authenticated` privileges (20260811191500 and
-- 20260814120000). Nothing here creates a table, so nothing here needs to
-- lock one down. No RPC or SECURITY DEFINER function is introduced: the
-- guarantee this correction needs is a UNIQUE INDEX, which is enforced by
-- the database for every writer including `service_role`, and which requires
-- no elevated execution path to be created or reviewed.
