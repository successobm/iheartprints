-- Forward-only guard against a recurrence of observed schema drift.
--
-- On 2026-08-08 the linked project recorded both
-- `20260808120000_revision_pending` and
-- `20260808180000_revision_lineage_and_final_direction` in
-- `supabase_migrations.schema_migrations` while none of the columns they
-- declare actually existed:
--
--   print_projects.revision_pending            -> 42703 undefined_column
--   print_projects.final_direction_confirmed   -> 42703 undefined_column
--   artwork_versions.source_artwork_version_id -> 42703 undefined_column
--   artwork_versions.concept_direction_key     -> 42703 undefined_column
--   generation_jobs.target_artwork_version_id  -> 42703 undefined_column
--
-- Live impact: `createGenerationJob` writes `target_artwork_version_id` on
-- every insert, so concept generation could not be enqueued at all —
-- approving a design brief failed after the brief version was already
-- durable, stranding projects in `brief_approved` with zero generation
-- jobs.
--
-- Recorded-but-unexecuted history cannot be corrected by re-pushing those
-- two files (`db push` skips versions already in history) and they must
-- not be edited or renamed now that history references them, so this
-- migration re-states their DDL forward-only. Every statement is additive
-- and guarded: it applied as a pure no-op (all six statements reported
-- "already exists, skipping"), and stays a no-op on any database that ran
-- the originals — including a fresh database replaying full history.

alter table public.print_projects
  add column if not exists revision_pending boolean not null default false;

alter table public.print_projects
  add column if not exists final_direction_confirmed boolean not null default false;

alter table public.artwork_versions
  add column if not exists source_artwork_version_id uuid null
    references public.artwork_versions (id) on delete set null,
  add column if not exists concept_direction_key text null
    check (concept_direction_key in ('bold_direct', 'soft_illustrated', 'minimal_badge'));

create index if not exists artwork_versions_source_artwork_version_id_idx
  on public.artwork_versions (source_artwork_version_id)
  where source_artwork_version_id is not null;

alter table public.generation_jobs
  add column if not exists target_artwork_version_id uuid null
    references public.artwork_versions (id) on delete set null;
