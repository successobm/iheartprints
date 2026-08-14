-- Sprint A2 Correction 2 — job-bound production intent.
--
-- WHY THIS IS REQUIRED
--
-- `tshirt_design_briefs.requested_production_output` (added 20260813120000)
-- is the customer's CURRENT intent, and it is deliberately mutable — people
-- change their minds, and a request must be retractable. A FinalArtworkJob,
-- however, carried no record of what it was created to satisfy, so every
-- gate downstream had to re-read that mutable value and hope it had not
-- moved. Three concrete failures followed:
--
--   1. A running PNG job could still set `print_ready` after the customer
--      had changed the request to separations.
--   2. A completed unsupported job was handed back as "already requested"
--      after the customer retracted to PNG, so finalization never re-ran and
--      the project was stuck forever.
--   3. An existing `print_ready` PNG kept telling the customer their work
--      was done after they had asked for something else entirely.
--
-- Binding the intent to the job at enqueue makes all three answerable by
-- comparing two values instead of trusting one.
--
-- TABLE / COLUMN / TYPE / NULLABILITY / DEFAULT
--
--   public.final_artwork_jobs.requested_production_output  text  NULL  (no default)
--
-- No default: a default would silently stamp `'production_png'` onto rows
-- inserted by an older app build that does not know about this column, which
-- is exactly the fabricated authority this migration must avoid. The
-- application always supplies the value explicitly on insert.
--
-- BACKFILL SEMANTICS: none, deliberately.
--
-- Every pre-existing job was enqueued when no mechanism existed to request
-- anything but the Production PNG, so NULL genuinely means `production_png`
-- for historical rows — an interpretation, applied at read time by
-- `normalizeProductionIntent`, not a rewrite of anybody's data. Writing that
-- value into old rows would claim we know something we inferred, and would
-- be indistinguishable afterwards from a real customer request.
--
-- Note the asymmetry with the brief column, which is intentional and load-
-- bearing: on `tshirt_design_briefs`, NULL means "the customer never asked"
-- (unspecified). Here, NULL means "enqueued before requests existed"
-- (legacy). Both resolve to the Production PNG path; neither is the same as
-- an UNRECOGNIZED string, which fails closed in the application (see
-- `readStoredRequestedProductionOutput`).
--
-- IDENTITY CHANGE
--
-- Intent becomes part of job identity. A PNG job and a separations job for
-- the same approval are different jobs, not one row reinterpreted — which is
-- what lets a customer go PNG -> separations -> PNG and get their ALREADY
-- PRODUCED plate back rather than paying for it twice.
--
-- The create_new key was a table CONSTRAINT, which cannot express the
-- `coalesce` below, so it is replaced by an equivalent unique INDEX. This is
-- additive in effect: every row that was unique before remains unique now,
-- because the new key is a strict superset of the old one. No data is
-- rewritten, dropped, or re-keyed.
--
-- `coalesce(requested_production_output, 'production_png')` is what keeps
-- legacy NULL rows and explicit `'production_png'` rows in ONE key. Without
-- it, Postgres treats NULLs as distinct and a legacy job would no longer
-- deduplicate against a new one — reintroducing the double-click duplicate
-- (and, for uploads, a duplicate paid reconstruction) this key exists to
-- prevent. It mirrors `normalizeProductionIntent` in the domain exactly; the
-- two must not drift.
--
-- No RLS or grant changes. No new non-unique indexes: both indexes below
-- replace an existing key rather than adding a lookup path.

alter table public.final_artwork_jobs
  add column if not exists requested_production_output text null;

comment on column public.final_artwork_jobs.requested_production_output is
  'Sprint A2 Correction 2: immutable production output this job was created to satisfy, snapshotted at enqueue. NULL = legacy job predating requestable outputs = production_png. Part of job identity.';

-- --- create_new: (project, approval, intent) ---------------------------------
-- The old key was declared inline as `unique (project_id,
-- final_direction_approval_id)`, so Postgres auto-named it. Rather than
-- hard-coding a computed name (which, if wrong, would leave the old
-- constraint silently in place and reject every intent-keyed insert), find
-- it by its exact column signature and drop whatever it is called.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'final_artwork_jobs'
    and con.contype = 'u'
    and con.conkey = array(
      select attnum
      from pg_attribute
      where attrelid = rel.oid
        and attname in ('project_id', 'final_direction_approval_id')
      order by attnum
    );

  if constraint_name is not null then
    execute format(
      'alter table public.final_artwork_jobs drop constraint %I',
      constraint_name
    );
  end if;
end $$;

create unique index if not exists final_artwork_jobs_approval_output_idx
  on public.final_artwork_jobs (
    project_id,
    final_direction_approval_id,
    (coalesce(requested_production_output, 'production_png'))
  )
  where final_direction_approval_id is not null;

-- --- prepared_upload: (project, preparation, width, intent) ------------------
-- Replaces 20260810180000's (project, preparation, width) key. Production
-- size and requested output are independent specifications, and BOTH have to
-- distinguish a deliverable: a 12in PNG is not an 11in PNG, and neither is a
-- set of separations.
drop index if exists public.final_artwork_jobs_preparation_size_idx;

create unique index if not exists final_artwork_jobs_preparation_size_output_idx
  on public.final_artwork_jobs (
    project_id,
    artwork_preparation_id,
    production_width_in,
    (coalesce(requested_production_output, 'production_png'))
  )
  where artwork_preparation_id is not null;
