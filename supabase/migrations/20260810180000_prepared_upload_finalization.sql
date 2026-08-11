-- Existing Artwork → Print Ready Phase 2: production finalization for
-- artwork the customer already owns. Additive and forward-only. Does not
-- edit or rename any previously applied migration, and changes nothing about
-- the Create New Artwork finalization path (every existing row keeps its
-- `final_direction_approval_id` and satisfies the new CHECK unchanged).
--
-- SCHEMA DISCIPLINE AUDIT (why this migration exists at all)
--
-- 1. WHAT MUST SURVIVE RELOAD, AND CANNOT ALREADY BE REPRESENTED
--
--    (a) WHICH CUSTOMER AUTHORITY a finalization job was created under.
--        `final_artwork_jobs.final_direction_approval_id` is NOT NULL and
--        references `final_direction_approvals`, whose own
--        `design_brief_version_id` is NOT NULL. Uploaded artwork has no
--        approved Design Brief version — the customer's own file is the
--        authority — so a prepared-upload job literally cannot be inserted
--        today without fabricating both an approval row and a brief version
--        for artwork no brief ever described.
--
--        The alternative considered and REJECTED: create a synthetic
--        `final_direction_approval` for uploads. That would (i) require
--        making `design_brief_version_id` nullable, weakening a column that
--        is honest for every existing row, and (ii) create a SECOND, competing
--        production-approval authority for the same customer decision the
--        `artwork_preparations` row already records (`status = 'approved'`,
--        `approved_at`, `prepared_artwork_version_id`). "Do not create
--        duplicate competing approval authorities" is the governing rule, and
--        the preparation row is already the durable, auditable record of
--        exactly this decision.
--
--        Chosen instead: `final_artwork_jobs` carries EITHER an approval id
--        (Create New Artwork) OR a preparation id (Upload Existing Artwork),
--        with a CHECK enforcing exactly one. No new table, no new enum
--        column: the job's "source kind" is DERIVED from which id is set, so
--        there is no third fact that could disagree with the two keys.
--
--    (b) WHICH PRODUCTION SIZE a job was enqueued for. Idempotency for the
--        upload workflow is "one active finalization per preparation approval
--        + production-size intent". Without the width on the job, a customer
--        who changes the print size after a plate already exists would either
--        silently receive the old, mismatched deliverable (the size on the
--        file would be a lie) or force a rewrite of an immutable production
--        asset. Recording the width makes "a different physical specification
--        is a different deliverable" expressible, and it also freezes each
--        job's own target so a later size change cannot retroactively change
--        what an already-running job produces.
--
--        Deliberately NOT added for the create_new path, which keeps reading
--        `design_briefs.intended_print_width_in` at run time exactly as it
--        does today — this migration adds no behavior there at all.
--
-- 2. WHY NOT A SECOND JOB TABLE
--    Both workflows converge on identical work: resolve an exact source
--    asset, run the production transform, persist ONE production asset, run
--    authoritative Print Validation, and decide print_ready. A parallel table
--    would duplicate the claim/heartbeat/recovery/paid-request-idempotency
--    lifecycle that already exists here, and would need its own worker. The
--    only genuine difference is which record authorizes the job, which is
--    exactly what these two columns express.

-- The Upload Existing Artwork production authority. `on delete cascade`
-- mirrors `final_direction_approval_id`: a job whose authorizing record is
-- gone has no meaning, and leaving it behind would let a worker resolve a
-- source it can no longer prove the customer approved.
alter table public.final_artwork_jobs
  add column if not exists artwork_preparation_id uuid null
    references public.artwork_preparations (id) on delete cascade;

-- The production print WIDTH, in inches, this job was enqueued for. Set only
-- for prepared-upload jobs (see the CHECK below). `numeric(6,2)` because
-- production widths are quarter-inch figures a human reads, never a float to
-- accumulate error in.
alter table public.final_artwork_jobs
  add column if not exists production_width_in numeric(6, 2) null;

-- Uploaded artwork has no `final_direction_approval_id`, so the column can no
-- longer be NOT NULL. The CHECK below is what keeps it from becoming
-- optional in practice: every row still names exactly one authority.
alter table public.final_artwork_jobs
  alter column final_direction_approval_id drop not null;

-- EXACTLY ONE production authority per job, enforced by the database rather
-- than by application code alone — the same reasoning as
-- `final_direction_approvals_active_per_project_idx`. A prepared-upload job
-- must also carry its production width, because that width is half of its
-- idempotency key and a NULL there would silently disable the unique index
-- below (NULLs are distinct in a unique index).
alter table public.final_artwork_jobs
  drop constraint if exists final_artwork_jobs_exactly_one_authority;

alter table public.final_artwork_jobs
  add constraint final_artwork_jobs_exactly_one_authority check (
    (
      final_direction_approval_id is not null
      and artwork_preparation_id is null
      and production_width_in is null
    )
    or (
      final_direction_approval_id is null
      and artwork_preparation_id is not null
      and production_width_in is not null
    )
  );

-- The upload workflow's idempotency key: one job per (project, preparation
-- approval, production size). A double click, a page reload, a retry, or two
-- tabs all land on the same row; choosing a different print width creates a
-- new one, because a different physical specification is a different
-- deliverable and the old production asset must never be silently reused for
-- it.
--
-- Partial, so it never applies to (nor conflicts with) create_new rows, whose
-- own `unique (project_id, final_direction_approval_id)` constraint is
-- untouched by this migration.
create unique index if not exists final_artwork_jobs_preparation_size_idx
  on public.final_artwork_jobs (
    project_id,
    artwork_preparation_id,
    production_width_in
  )
  where artwork_preparation_id is not null;

create index if not exists final_artwork_jobs_artwork_preparation_id_idx
  on public.final_artwork_jobs (artwork_preparation_id)
  where artwork_preparation_id is not null;
