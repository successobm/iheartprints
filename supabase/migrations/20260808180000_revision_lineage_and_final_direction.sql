-- Sprint 2G Live Acceptance Corrective Pass.
-- Additive only. Does not edit or rename any previously applied migration.
--
-- Three related, additive lifecycle facts exposed by live browser
-- acceptance testing:
--
-- 1. `print_projects.final_direction_confirmed` — the explicit "no more
--    changes, this is final" confirmation, distinct from and strictly
--    stronger than `selected_artwork_version_id` (which only ever means
--    "I want to work with this direction" and is immediately revisable).
--    See `PrintProject.finalDirectionConfirmed` in `src/lib/domain/types.ts`.
--
-- 2. `artwork_versions.source_artwork_version_id` — durable revision
--    lineage: which artwork (if any) a given row is a targeted revision
--    of. A self-referencing nullable FK, not a parallel history table —
--    the original three concepts and every revision batch already live in
--    this same table; this column is the only addition needed to chain
--    them. `on delete set null` rather than cascade: artwork rows are
--    never deleted (Constitution §6.11), but this is defensive in case a
--    future cleanup path ever does.
--
-- 3. `artwork_versions.concept_direction_key` — which of the three catalog
--    creative directions (`lib/domain/concept-directions.ts`) a concept
--    used, so a later single-concept revision regenerates in the SAME
--    direction instead of defaulting to a different one.
--
-- 4. `generation_jobs.target_artwork_version_id` — when set, this job is a
--    targeted single-concept revision (produces exactly one new concept,
--    tagged back to this source) rather than a three-direction
--    exploration. See `GenerationJob.targetArtworkVersionId`.
--
-- Safe defaults for existing rows: `final_direction_confirmed` defaults
-- `false` (no historical project is retroactively treated as confirmed);
-- the three new nullable columns default `null` (no historical artwork/job
-- had a source, direction, or target — they were all three-direction
-- explorations, which remains a true statement about them).

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
