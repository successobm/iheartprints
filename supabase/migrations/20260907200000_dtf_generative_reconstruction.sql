-- DTF Generative Reconstruction Phase 1: the optional pre-stage's own
-- result record, keyed to the original asset id plus a capability/prompt
-- version so a stale record is never mistaken for a current one. Additive
-- JSON column, same pattern as `guided_cleanup`/`separation` before it.
alter table public.artwork_preparations
  add column if not exists generative_reconstruction jsonb null;
