-- True Source-Image Targeted Revision.
-- Additive only. Does not edit or rename any previously applied migration.
--
-- `generation_jobs.revision_instruction` — the customer's literal revision
-- instruction for a targeted single-concept revision ("make the border red
-- and change it to a shield"), captured at enqueue time.
--
-- Why a column rather than a derivation: a targeted revision is defined as
-- SOURCE ARTWORK + REQUESTED DELTA, and the delta exists only in the
-- customer's own words. `design_brief_versions.content` records design
-- STATE ("the design is a red badge"), never the CHANGE, and the derived
-- RegenerationPlan knows only which brief SECTIONS were touched. Without a
-- durable delta the worker had nothing to tell an image-edit provider to
-- change — which is precisely how a "targeted revision" silently degraded
-- into a fresh text-to-image generation from the brief.
--
-- Internal only: never exposed through ProjectSnapshot, never rendered to a
-- customer, and never treated as prompt text (Prompt Translation decides
-- how it reaches a provider). Nullable with no default: initial generation
-- and three-direction "show me alternatives" regeneration legitimately have
-- no delta, and every job created before this column existed keeps `null`,
-- which stays a true statement about them.

alter table public.generation_jobs
  add column if not exists revision_instruction text null;
