-- Sprint 2I Phase 1: provider-neutral Concept Evaluation persistence on
-- artwork_versions. Additive only. Does not assume a specific evaluation
-- provider (no OpenAI / vision / OCR columns or constraints).
--
-- evaluation_status already exists (text, nullable) from Sprint 2H Part 1.
-- Application contracts restrict values to:
--   pending | passed | needs_review | failed
-- No CHECK constraint — keep the column provider-neutral and forward-compatible.

alter table public.artwork_versions
  add column if not exists evaluation jsonb null,
  add column if not exists evaluation_evaluated_at timestamptz null,
  add column if not exists evaluation_provider_key text null;
