-- Signs Phase S2: rigid-sign production authority on `final_artwork_jobs`.
-- Additive and forward-only. Does not edit or rename any previously applied
-- migration, and changes nothing about the Create New Artwork or Upload
-- Existing Artwork finalization paths (every existing row keeps its current
-- authority column and satisfies the widened CHECK unchanged).
--
-- SCHEMA DISCIPLINE AUDIT (why this migration exists at all — S2's own
-- Rule 2 investigation, recorded here rather than assumed)
--
-- 1. THE EXISTING AUTHORITY MODEL, AND WHY IT CANNOT REPRESENT A SIGN
--
--    `final_artwork_jobs` already carries EITHER `final_direction_approval_id`
--    (Create New Artwork) OR `artwork_preparation_id` (Upload Existing
--    Artwork), with a CHECK enforcing exactly one — see
--    `20260810180000_prepared_upload_finalization.sql`'s own audit, which
--    rejected fabricating a synthetic `final_direction_approval` for uploads
--    for exactly the reason that applies here too: it would require widening
--    a column that is honest for every existing row, and it would create a
--    SECOND, competing production-approval authority for a decision another
--    table already records durably.
--
--    A rigid-sign preparation (`sign_preparations`, S1) is neither of the
--    two existing authorities. It has no Design Brief version (no
--    `final_direction_approval` is honest for it — that record's own
--    `design_brief_version_id` is NOT NULL for real reasons), and it is not
--    an `artwork_preparations` row (a different table entirely, with
--    apparel-shaped columns — background-isolation diagnostics, a derived
--    transparent PNG, a `prepared_upload` `ArtworkVersion` — none of which a
--    sign preparation has or needs). Routing a sign job's authority through
--    either existing column would be dishonest: the FK would point at a row
--    that did not actually authorize this job.
--
--    Because the existing model is FK-based (not an enum the application
--    interprets), a third kind of authority genuinely requires a third
--    nullable column — there is no way to add a third case to an "exactly
--    one of two FKs" CHECK without a third FK to check. This mirrors the
--    2020810180000 migration's own shape and size exactly: one new nullable
--    FK, one new nullable identity column, one widened CHECK, one partial
--    unique index. Not a larger authority model — the same one, extended
--    the same way it already was once.
--
-- 2. WHAT MUST SURVIVE RELOAD
--
--    (a) WHICH SIGN PREPARATION a job was created under.
--    (b) WHICH EXACT PLAN the job was created to execute — `sign_plan_key`,
--        snapshotted at enqueue and immutable, mirroring
--        `production_treatment_key`'s exact reasoning: a `SignPreparation`
--        can be re-planned (a human confirms a different size, or the
--        planner's own logic changes), and a queued job must stay bound to
--        the PLAN it was authorized for — never silently re-aimed at
--        whatever the preparation's plan happens to be when the worker gets
--        to it. A plan-key change supersedes a queued job; it never re-aims
--        one. Returning to a previously-planned size reuses that job's own
--        evidence rather than redoing it.
--
--    Unlike the upload workflow, no separate `production_width_in` binding
--    is needed here: `sign_plan_key` already encodes the ordered width AND
--    height (Constitution §16A.2 — both axes authoritative) along with the
--    policy and every step, so it is a STRICTLY MORE PRECISE idempotency key
--    than width alone would be, without inventing a second figure that could
--    disagree with the plan it is supposed to describe.
--
-- 3. WHY NOT A SECOND JOB TABLE
--    Same reasoning as the upload migration: claim/heartbeat/recovery,
--    idempotent production-asset reuse, and authoritative Print Validation
--    are infrastructure every production path shares. A parallel table would
--    duplicate all of it for no genuine difference — the only real
--    difference is which record authorizes the job, which is exactly what
--    this column expresses.
--
-- 4. `artwork_version_id` REMAINS NOT NULL, AND WHAT IT MEANS FOR A SIGN JOB
--    A sign preparation has no `ArtworkVersion` — nothing generated it and
--    no Design Brief describes it (Constitution §16A). Widening this column
--    (or the matching field on `PrintValidationReport`/`PrintValidationInput`
--    in `print-validation/contracts.ts`) to `NULL` would ripple through
--    every apparel consumer of a column that has been a trustworthy
--    non-null string for every prior sprint. The narrower, equally honest
--    choice made here: for a `sign_preparation` job, `artwork_version_id`
--    holds the SIGN PREPARATION's own id — a real, durable, project-scoped
--    identity that fills the same structural role ("which creative-source
--    record does this job/report describe") without inventing a fake
--    `ArtworkVersion` row. Documented at every call site that sets it.

-- The rigid-sign production authority. `on delete cascade` mirrors
-- `artwork_preparation_id`: a job whose authorizing record is gone has no
-- meaning, and leaving it behind would let a worker resolve a source it can
-- no longer prove was planned.
alter table public.final_artwork_jobs
  add column if not exists sign_preparation_id uuid null
    references public.sign_preparations (id) on delete cascade;

-- The canonical repair-plan identity this job was enqueued to execute.
-- Frozen at enqueue and immutable — a re-plan supersedes the job rather than
-- re-aiming it. `text`, matching `production_treatment_key`'s own type: an
-- opaque identity string, never a figure to parse or recompute here.
alter table public.final_artwork_jobs
  add column if not exists sign_plan_key text null;

-- EXACTLY ONE production authority per job, widened from two to three.
-- Every existing row satisfies this unchanged: both new columns are NULL for
-- every row written before this migration, and the two prior arms of the
-- disjunction are byte-for-byte what they already were.
alter table public.final_artwork_jobs
  drop constraint if exists final_artwork_jobs_exactly_one_authority;

alter table public.final_artwork_jobs
  add constraint final_artwork_jobs_exactly_one_authority check (
    (
      final_direction_approval_id is not null
      and artwork_preparation_id is null
      and sign_preparation_id is null
      and production_width_in is null
    )
    or (
      final_direction_approval_id is null
      and artwork_preparation_id is not null
      and sign_preparation_id is null
      and production_width_in is not null
    )
    or (
      final_direction_approval_id is null
      and artwork_preparation_id is null
      and sign_preparation_id is not null
      and sign_plan_key is not null
    )
  );

-- The sign workflow's idempotency key: one job per (project, sign
-- preparation, plan). A double click, a page reload, a retry, or two tabs
-- all land on the same row; a re-plan (different ordered size, different
-- policy, different steps) creates a new one, because a different plan is a
-- different deliverable and the old production asset (if any) must never be
-- silently reused for it.
create unique index if not exists final_artwork_jobs_sign_preparation_plan_idx
  on public.final_artwork_jobs (
    project_id,
    sign_preparation_id,
    sign_plan_key
  )
  where sign_preparation_id is not null;

create index if not exists final_artwork_jobs_sign_preparation_id_idx
  on public.final_artwork_jobs (sign_preparation_id)
  where sign_preparation_id is not null;
