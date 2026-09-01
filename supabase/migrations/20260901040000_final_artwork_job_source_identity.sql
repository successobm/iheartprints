-- LIVE PRODUCT BLOCKER #4E: fixes a genuine production defect the real
-- acceptance run exposed — `final_artwork_jobs.artwork_version_id` carries
-- a hard foreign key to `artwork_versions (id)`, `not null`, since the
-- table's very first migration (20260806190000). Signs Phase S2
-- (20260830130000) added the `sign_preparation_id` authority column and
-- correctly widened the `exactly_one_authority` CHECK to a third arm, but
-- never noticed the PRE-EXISTING `artwork_version_id` foreign key would
-- reject the sign preparation id its own application code started writing
-- into that column — a sign preparation is never an `artwork_versions` row.
-- `LocalProjectRepository` (every automated test in this repository runs
-- against it) does not enforce real foreign keys, so nothing could have
-- caught this before the real database did, on the first real "Prepare
-- artwork" click.
--
-- THE FIX. `artwork_version_id` and `sign_preparation_id` are DIFFERENT
-- ENTITY TYPES and must never share a column. `sign_preparation_id`
-- already exists and is already the correct, honest identity for a sign
-- job — this migration does not add a new column for it. It only:
--
--   1. Relaxes `artwork_version_id`'s `not null` — the SAME relaxation
--      `final_direction_approval_id` already received in
--      20260810180000 for the identical reason (a third job kind that
--      does not carry that identity).
--   2. Extends the EXISTING `final_artwork_jobs_exactly_one_authority`
--      CHECK (not a new, separate, possibly-disagreeing constraint) so
--      `artwork_version_id`'s presence is governed by the SAME three-arm
--      source-identity model the authority columns already use:
--        - a `generated_concept` job:  artwork_version_id IS NOT NULL
--        - a `prepared_upload` job:    artwork_version_id IS NOT NULL
--          (a prepared-upload job's `artwork_version_id` is a REAL
--          `artwork_versions` row — the `prepared_upload` ArtworkVersion
--          the preparation produced — never overloaded, never touched by
--          this migration's own reasoning)
--        - a `sign_preparation` job:   artwork_version_id IS NULL
--
-- AUDITED BEFORE WRITING THIS MIGRATION (LIVE PRODUCT BLOCKER #4E's own
-- read-only pass): every application code path that reads
-- `FinalArtworkJob.artworkVersionId` is strictly apparel-scoped
-- (`runGeneratedConceptJob`, `runPreparedUploadJob`, `resolveCurrentMatching
-- ProductionJob`, `findDeliverableJob`) — a sign job is dispatched through
-- `runSignPreparationJob`, which never reads this field at all (its own
-- `PrintValidationInput.artworkVersionId` is a SEPARATE, unrelated field,
-- already set directly from `preparation.id`). No RLS policy, index, or
-- other constraint on this table references `artwork_version_id` beyond
-- the FK and the CHECK this migration touches. `sign_preparation_id`'s own
-- idempotency unique index (`final_artwork_jobs_sign_preparation_plan_idx`,
-- 20260830130000) is untouched — the sign workflow's "one job per (project,
-- sign preparation, plan key)" guarantee does not involve
-- `artwork_version_id` at all and needs no change here.
--
-- EXISTING-ROW COMPATIBILITY (verified against the live table before
-- writing this migration, not assumed): every row in `final_artwork_jobs`
-- today is `generated_concept` or `prepared_upload`, every one has a
-- non-null `artwork_version_id`, and zero rows have `sign_preparation_id`
-- set (the defect this fixes meant no sign job has ever successfully been
-- created) — so 100% of existing rows already satisfy the new CHECK
-- unchanged, and no historical row is rewritten.

alter table public.final_artwork_jobs
  alter column artwork_version_id drop not null;

alter table public.final_artwork_jobs
  drop constraint if exists final_artwork_jobs_exactly_one_authority;

alter table public.final_artwork_jobs
  add constraint final_artwork_jobs_exactly_one_authority check (
    (
      final_direction_approval_id is not null
      and artwork_preparation_id is null
      and sign_preparation_id is null
      and production_width_in is null
      and artwork_version_id is not null
    )
    or (
      final_direction_approval_id is null
      and artwork_preparation_id is not null
      and sign_preparation_id is null
      and production_width_in is not null
      and artwork_version_id is not null
    )
    or (
      final_direction_approval_id is null
      and artwork_preparation_id is null
      and sign_preparation_id is not null
      and sign_plan_key is not null
      and artwork_version_id is null
    )
  );

-- ---------------------------------------------------------------------------
-- Self-verification, mirroring 20260811191500_server_only_rls_lockdown.sql's
-- own established discipline: assert postconditions against the live
-- catalog and abort the transaction if any one of them does not hold, so
-- correctness never depends on someone remembering to check afterwards.
-- Note that (c) is redundant with Postgres's own automatic validation of a
-- newly-added CHECK against every existing row (the ALTER TABLE above would
-- already have aborted the whole transaction on the first violating row) —
-- it is kept anyway as an explicit, self-documenting guarantee rather than
-- relying implicitly on that behavior.
-- ---------------------------------------------------------------------------

do $$
declare
  offenders text;
  violation_count integer;
begin
  -- (a) artwork_version_id is nullable.
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'final_artwork_jobs'
       and column_name = 'artwork_version_id'
       and is_nullable = 'NO'
  ) then
    raise exception 'final_artwork_job_source_identity: artwork_version_id is still NOT NULL';
  end if;

  -- (b) both foreign keys still exist — DTF referential integrity to
  --     artwork_versions is preserved, and the sign referential integrity
  --     to sign_preparations (added in 20260830130000) is untouched.
  if to_regclass('public.final_artwork_jobs') is null then
    raise exception 'final_artwork_job_source_identity: final_artwork_jobs does not exist';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'final_artwork_jobs_artwork_version_id_fkey'
       and conrelid = 'public.final_artwork_jobs'::regclass
       and contype = 'f'
  ) then
    raise exception 'final_artwork_job_source_identity: artwork_version_id foreign key is missing';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'final_artwork_jobs_sign_preparation_id_fkey'
       and conrelid = 'public.final_artwork_jobs'::regclass
       and contype = 'f'
  ) then
    raise exception 'final_artwork_job_source_identity: sign_preparation_id foreign key is missing';
  end if;

  -- (c) every existing row satisfies the rebuilt invariant (belt-and-
  --     suspenders on top of Postgres's own automatic CHECK validation).
  select count(*)
    into violation_count
    from public.final_artwork_jobs
   where not (
     (
       final_direction_approval_id is not null
       and artwork_preparation_id is null
       and sign_preparation_id is null
       and artwork_version_id is not null
     )
     or (
       final_direction_approval_id is null
       and artwork_preparation_id is not null
       and sign_preparation_id is null
       and artwork_version_id is not null
     )
     or (
       final_direction_approval_id is null
       and artwork_preparation_id is null
       and sign_preparation_id is not null
       and artwork_version_id is null
     )
   );

  if violation_count > 0 then
    raise exception 'final_artwork_job_source_identity: % existing row(s) violate the rebuilt invariant', violation_count;
  end if;

  -- (d) the CHECK constraint itself exists.
  select string_agg(conname, ', ')
    into offenders
    from pg_constraint
   where conname = 'final_artwork_jobs_exactly_one_authority'
     and conrelid = 'public.final_artwork_jobs'::regclass
     and contype = 'c';

  if offenders is null then
    raise exception 'final_artwork_job_source_identity: final_artwork_jobs_exactly_one_authority CHECK is missing';
  end if;

  raise notice 'final_artwork_job_source_identity: verified — artwork_version_id nullable, both source foreign keys present, CHECK present, 0 existing rows violate the invariant';
end
$$;
