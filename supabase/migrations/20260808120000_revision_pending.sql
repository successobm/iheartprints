-- Sprint 2M Phase 2G: revision lifecycle + finalization safety.
-- Additive only. Does not edit or rename any previously applied migration.
--
-- The durable authority for "the customer requested a design change that
-- is not yet represented by the artwork." `print_projects.status` already
-- has a `revision_requested` value, but the Revision Lifecycle Audit found
-- it is written on every message in the post-selection revision loop
-- (including ones that changed nothing) and is therefore too weak a
-- signal to gate finalization on. This column is the smallest additional
-- authority needed: `true` from the moment an explicit revision request
-- is understood until a new ArtworkVersion batch produced by that
-- revision actually exists (cleared only on regeneration completion,
-- never merely on enqueue). See `PrintProject.revisionPending` in
-- `src/lib/domain/types.ts`, `FinalArtworkCapability.requestFinalArtwork`,
-- and ARCHITECTURE.md's Revision Lifecycle section.
--
-- Safe default for existing rows: `false` — no historical project is
-- retroactively treated as having a pending revision.

alter table public.print_projects
  add column if not exists revision_pending boolean not null default false;
