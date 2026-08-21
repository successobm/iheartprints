-- Print'em All Phase 1 — garment-aware production size authority.
--
-- WHY PERSISTENCE IS REQUIRED
--
-- A live Print'em All job spent a Topaz reconstruction credit while
-- `tshirt_design_briefs.intended_print_width_in` was NULL. Nothing crashed:
-- the pipeline read the width, found none, fell back to the placement
-- default (10.5in), and produced a plate at a physical size no person had
-- ever chosen or seen.
--
-- The root cause is not a missing null check. A NUMBER CANNOT CARRY CONSENT.
-- Once a default fills in, "10.5 because the customer said so" and "10.5
-- because nobody said anything" are byte-identical, and no inspection of
-- that column afterwards can separate them. Every gate built on "do we have
-- a width?" therefore passes in precisely the case it exists to catch.
--
-- Consent has to be its own recorded fact, written only when a human
-- actually gives it. That is what this migration adds.
--
-- ============================================================================
-- PART 1 — public.tshirt_design_briefs
-- ============================================================================
--
-- OWNER: the MUTABLE working brief, alongside `intended_print_width_in` and
-- `requested_production_output`, and deliberately NOT
-- `design_brief_versions.content`.
--
-- These are PRODUCTION SPECIFICATIONS, not creative content. Choosing a
-- youth garment or confirming 12 inches must not restyle artwork, supersede
-- an approved brief version, or mark existing concepts stale — nothing about
-- the DESIGN changed. And both must be retractable: an operator who picks
-- the wrong garment class has to be able to pick again, which an immutable
-- approved snapshot would make impossible without a whole new approval
-- cycle.
--
-- BACKWARD COMPATIBILITY: forward-only, additive, nullable, no default, no
-- backfill, no data rewritten.
--
-- THE ABSENCE OF A BACKFILL IS THE POINT, not an omission. Every existing
-- project is honestly unconfirmed: its size, if it has one, came from a
-- default or from a chat instruction that predates the notion of
-- confirmation. Stamping `production_size_confirmed_at = now()` across the
-- table to spare those projects one click would manufacture consent nobody
-- gave, recreate the exact failure above, and be indistinguishable forever
-- afterwards from a real decision. Already-completed `print_ready` jobs are
-- untouched and remain historical truth; only NEW paid provider work
-- requires a confirmation.

alter table public.tshirt_design_briefs
  add column if not exists garment_size_class text null;

comment on column public.tshirt_design_briefs.garment_size_class is
  'Print''em All Phase 1: garment sizing context a production box is RECOMMENDED for (youth | womens_small | adult_standard | adult_plus | custom). Apparel-product sizing terminology only — never an inference about a person. NULL = never stated = assume standard adult for the SUGGESTION only. Not authority: see production_size_confirmed_at.';

-- No CHECK constraint on the value set, consistent with this schema's
-- existing practice for forward-compatible vocabularies (see
-- `artwork_concept_evaluation` and `requested_production_output`): the domain
-- type `GarmentSizeClass` is the authority, unrecognized values are rejected
-- at the capability boundary and read back as NULL (`readGarmentSizeClass`),
-- and a future garment class must not require a migration merely to be
-- namable.

alter table public.tshirt_design_briefs
  add column if not exists production_size_confirmed_at timestamptz null;

comment on column public.tshirt_design_briefs.production_size_confirmed_at is
  'Print''em All Phase 1 — PRODUCTION SPEND AUTHORITY. When a human EXPLICITLY confirmed the physical production size. NULL = never confirmed = no new paid provider work may be authorized. Never backfilled: a default is not a decision.';

alter table public.tshirt_design_briefs
  add column if not exists production_size_confirmed_width_in numeric(6, 2) null;

-- Self-describing on purpose. The confirmation names the exact width it
-- approved, so no other writer of `intended_print_width_in` (a chat
-- instruction, a future brief extractor, an operator correction) can inherit
-- somebody else's consent: a mismatch reads as unconfirmed rather than as
-- approval for a size that was never shown to anyone.
comment on column public.tshirt_design_briefs.production_size_confirmed_width_in is
  'Print''em All Phase 1: the exact physical print WIDTH in inches that production_size_confirmed_at authorizes. A width that disagrees with intended_print_width_in means UNCONFIRMED, never approval-by-proximity.';

alter table public.tshirt_design_briefs
  add column if not exists production_size_confirmed_max_height_in numeric(6, 2) null;

-- What makes a confirmation a CONTAINING BOX rather than a bare width.
-- Confirming a 10.5x10.5 recommendation must contain a 2:3 portrait to
-- 7.0x10.5; a width alone cannot express that, and forcing the portrait to
-- 10.5in wide would be the "10.5 is universal" mistake in a new place. NULL
-- means the operator stated a width alone and height follows the artwork's
-- own aspect ratio, bounded only by the placement's technical limit. Never an
-- independent Y scale — both axes always move together, so no operator
-- surface can distort artwork.
comment on column public.tshirt_design_briefs.production_size_confirmed_max_height_in is
  'Print''em All Phase 1: confirmed containing-box HEIGHT bound in inches, or NULL when a width alone was confirmed. A bound on the artwork, never a canvas and never an independent Y scale.';

-- ============================================================================
-- PART 2 — public.final_artwork_jobs: production width joins job identity for
--          the create_new workflow, as it already had for prepared_upload.
-- ============================================================================
--
-- `production_width_in` already exists on this table (20260810180000) and is
-- already part of the prepared_upload idempotency key. Only create_new jobs
-- left it NULL, reading the live working brief at run time instead — which
-- meant a queued 10.5in job silently re-aimed itself at 12in when the size
-- changed underneath it, and the stale-intent fence (20260813170000) could
-- not see the difference because it compared requested OUTPUT only.
--
-- Binding the width at enqueue makes both problems one comparison:
--
--   * a queued job for a superseded size is STALE and must not dispatch, in
--     either direction (10.5 -> 12 and 12 -> 10.5 alike);
--   * a newly confirmed size gets its OWN job rather than re-targeting a job
--     that may already have been submitted to a paid provider.
--
-- IDENTITY CHANGE — and why it is additive in effect.
--
-- `coalesce(production_width_in, -1)` is what keeps legacy create_new rows in
-- ONE key bucket. Without it Postgres treats NULLs as distinct, and every
-- historical job would stop deduplicating against every other — reintroducing
-- the double-click duplicate (and the duplicate paid reconstruction) this key
-- exists to prevent. With it, every row that was unique before remains unique
-- now: legacy NULLs collapse to a single sentinel exactly as they previously
-- collapsed by being absent from the key, and only rows written by this build
-- carry a real width. `-1` is unreachable as a real width (every placement's
-- technical minimum is positive), so it can never collide with one. This
-- mirrors `normalizeProductionIntent`'s coalesce in the row above; the two
-- must not drift.
--
-- No data is rewritten, dropped, or re-keyed. No RLS or grant changes. The
-- index below replaces an existing key rather than adding a lookup path.

drop index if exists public.final_artwork_jobs_approval_output_idx;

create unique index if not exists final_artwork_jobs_approval_output_size_idx
  on public.final_artwork_jobs (
    project_id,
    final_direction_approval_id,
    (coalesce(requested_production_output, 'production_png')),
    (coalesce(production_width_in, -1))
  )
  where final_direction_approval_id is not null;

comment on column public.final_artwork_jobs.production_width_in is
  'Print''em All Phase 1: the confirmed physical print WIDTH in inches this job was enqueued for, snapshotted at enqueue and immutable. Part of job identity for BOTH workflows. NULL = legacy create_new job predating width binding.';
