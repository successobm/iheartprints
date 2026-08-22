-- Print'em All Phase 2 — production treatment authority (DTF halftone).
--
-- WHY THIS IS PERSISTED STATE AND NOT A REQUEST PARAMETER
--
-- Phase 1 established that a NUMBER CANNOT CARRY CONSENT: once a default
-- fills a column in, "10.5 because a human said so" and "10.5 because nobody
-- said anything" become byte-identical, so every gate built on "do we have a
-- value?" passes in exactly the case it exists to catch.
--
-- A production TREATMENT has the same property and a sharper failure mode.
-- Standard raster refuses artwork it cannot honestly reconstruct — the live
-- Print'em All file needs 5.6x against a proven 4x provider ceiling, so it is
-- refused before dispatch, for free. DTF halftone can produce that file at
-- the requested physical size because it generates dot geometry at final size
-- instead of reconstructing detail.
--
-- Which means the one thing that must never be constructible is:
--
--     standard raster was refused  ->  therefore halftone
--
-- That is a machine talking itself into changing a customer's artwork. A
-- treatment is only ever a decision A HUMAN MADE, so it is recorded as one:
-- what they chose, with which settings, and when. A row that has never been
-- written is honestly standard raster, which is also every historical
-- project's real behavior.
--
-- ============================================================================
-- PART 1 — public.tshirt_design_briefs
-- ============================================================================
--
-- OWNER: the MUTABLE working brief, alongside `intended_print_width_in`,
-- `garment_size_class`, and the Phase 1 confirmation columns — deliberately
-- NOT `design_brief_versions.content`.
--
-- Same reasoning as Phase 1's columns, and it is the reasoning that decides
-- this: a production treatment is a PRODUCTION SPECIFICATION, not creative
-- content. Choosing a halftone must not restyle artwork, supersede an
-- approved brief version, or mark existing concepts stale — nothing about the
-- DESIGN changed. And it must be retractable: an operator who screens a proof,
-- looks at it, and goes back to standard raster has to be able to, which an
-- immutable approved snapshot would turn into a whole new approval cycle.
--
-- BACKWARD COMPATIBILITY: forward-only, additive, nullable, no default, no
-- backfill, no data rewritten. Every existing project reads as standard
-- raster because that is what every existing project actually is.

alter table public.tshirt_design_briefs
  add column if not exists production_treatment text null;

comment on column public.tshirt_design_briefs.production_treatment is
  'Print''em All Phase 2: which apparel-raster production REPRESENTATION this project produces (standard_raster | halftone_dtf). NULL = never chosen = standard_raster. Never inferred from a failed standard-raster validation: that would let a refusal silently change the customer''s artwork.';

-- No CHECK constraint on the value set, consistent with this schema's
-- existing practice for forward-compatible vocabularies (see
-- `artwork_concept_evaluation`, `requested_production_output`, and
-- `garment_size_class`): the domain type `ProductionTreatment` is the
-- authority, and `readProductionTreatment` reads an unrecognized value as the
-- DEFAULT rather than honouring it — a build cannot produce a treatment it
-- does not implement, and guessing would make a plate nobody specified.

alter table public.tshirt_design_briefs
  add column if not exists halftone_settings jsonb null;

comment on column public.tshirt_design_briefs.halftone_settings is
  'Print''em All Phase 2: the exact halftone screen settings (lpi, angle, dot shape, midtone, choke, resolved garment colour, engine version) the operator selected. One JSONB document rather than six columns because these values are only ever meaningful together — a plate made with five of six settings is not reproducible. NULL whenever production_treatment is not halftone_dtf.';

alter table public.tshirt_design_briefs
  add column if not exists production_treatment_selected_at timestamptz null;

comment on column public.tshirt_design_briefs.production_treatment_selected_at is
  'Print''em All Phase 2: when a human EXPLICITLY selected this production treatment. The audit fact that separates a chosen treatment from a defaulted one. Never backfilled.';

-- ============================================================================
-- PART 2 — public.final_artwork_jobs: treatment joins job identity
-- ============================================================================
--
-- Exactly the move Phase 1 made for `production_width_in`, for exactly the
-- same reason, against a value that changes far more often.
--
-- A queued job that read the project's live treatment at run time would
-- silently re-aim itself every time an operator adjusted a slider: change LPI
-- while a job is queued and the plate that comes out is not the one that was
-- authorized. Worse, the stale-intent fence could not see the difference,
-- because it compares requested output and confirmed size only.
--
-- Binding the treatment at enqueue makes all of it one comparison:
--
--   * a queued job for superseded settings is STALE and never dispatches;
--   * new settings get their OWN job, with their own evidence, rather than
--     overwriting the record of what the previous settings produced;
--   * coming BACK to previous settings reuses that job's finished plate
--     instead of regenerating it.
--
-- WHY A READABLE KEY AND NOT A HASH. This column is read by people
-- diagnosing a physical print. `halftone_dtf/iheartprints_halftone_am_v1/
-- lpi=35/ang=45/dot=round/tone=1.00/choke=0/garment=#000000` answers "what
-- was this plate?"; a hex digest only ever answers "was it the same?".
--
-- IDENTITY CHANGE — and why it is additive in effect.
--
-- `coalesce(production_treatment_key, 'standard_raster')` is what keeps
-- legacy rows in ONE key bucket, mirroring Phase 1's
-- `coalesce(production_width_in, -1)` exactly. Without it Postgres treats
-- NULLs as distinct and every historical job stops deduplicating against
-- every other, reintroducing the duplicate paid reconstruction these keys
-- exist to prevent. With it, every row unique before remains unique now:
-- legacy NULLs collapse to the same sentinel they effectively already had by
-- being absent from the key, and only rows written by this build carry a real
-- treatment. 'standard_raster' is the literal key
-- `productionTreatmentKey({treatment:"standard_raster"})` returns, so the
-- sentinel and the real value for the default treatment are deliberately the
-- SAME string — a legacy job and a newly written standard-raster job are the
-- same production intent and must share a bucket.
--
-- No data is rewritten, dropped, or re-keyed. No RLS or grant changes. Both
-- statements replace an existing key rather than adding a lookup path.

alter table public.final_artwork_jobs
  add column if not exists production_treatment_key text null;

comment on column public.final_artwork_jobs.production_treatment_key is
  'Print''em All Phase 2: the canonical production-treatment identity this job was enqueued for, snapshotted at enqueue and immutable. Part of job identity for BOTH workflows. NULL = legacy job predating treatment binding, which can only ever have been standard raster.';

drop index if exists public.final_artwork_jobs_approval_output_size_idx;

create unique index if not exists final_artwork_jobs_approval_output_size_treatment_idx
  on public.final_artwork_jobs (
    project_id,
    final_direction_approval_id,
    (coalesce(requested_production_output, 'production_png')),
    (coalesce(production_width_in, -1)),
    (coalesce(production_treatment_key, 'standard_raster'))
  )
  where final_direction_approval_id is not null;

drop index if exists public.final_artwork_jobs_preparation_size_output_idx;

create unique index if not exists final_artwork_jobs_preparation_size_output_treatment_idx
  on public.final_artwork_jobs (
    project_id,
    artwork_preparation_id,
    production_width_in,
    (coalesce(requested_production_output, 'production_png')),
    (coalesce(production_treatment_key, 'standard_raster'))
  )
  where artwork_preparation_id is not null;
