-- Phase R6A (Geometry-Qualified Clean Master v1): the durable, CAS-protected
-- lifecycle of ONE deterministic geometry-qualification attempt against ONE
-- approved reconstruction job's candidate. Additive and forward-only. Builds
-- NO Signs/DTF wiring, calls NO provider, and changes NO Print Ready
-- authority of any kind — see this phase's own implementation report for
-- the full boundary.
--
-- WHY THIS IS A NEW TABLE, NOT AN EXTENSION OF `artwork_reconstruction_jobs`
--
-- `artwork_reconstruction_jobs.review_status` already answers "did the
-- customer approve the REBUILT ARTWORK'S APPEARANCE" — a genuinely
-- different authority from "did the customer confirm the DETERMINISTIC
-- BACKGROUND/CANVAS NORMALIZATION did not crop anything incorrectly",
-- which is what THIS table's `qualification_status` answers. Folding the
-- second lifecycle onto the first row would mean touching that table's own
-- working `artwork_reconstruction_jobs_completion_consistent` CHECK and
-- `..._active_binding_uidx` partial index — a materially larger, riskier
-- surface than a small satellite table, mirroring exactly why
-- `artwork_reconstruction_jobs` itself was a new table rather than a
-- fourth authority arm on `final_artwork_jobs` (see that migration's own
-- header comment).
--
-- WHY `assets` CANNOT REPRESENT THE CUSTOMER'S GEOMETRY DECISION
--
-- `assets` is APPEND-ONLY (Constitution §6.11 — no method exists to update
-- an already-created asset's metadata), which cannot represent a customer
-- decision that arrives strictly AFTER the geometry-normalized derivative
-- asset already exists (the customer must see it before confirming or
-- rejecting it). This table is the mutable, CAS-protected record of that
-- decision; the derivative's own bytes and immutable evidence live in its
-- own `assets` row, referenced here by id and never duplicated.
--
-- SMALLEST ADDITIVE SCHEMA
--
-- ONE table, mirroring `artwork_reconstruction_jobs`' proven CAS/staleness
-- shape exactly, plus the geometry evidence this qualification alone needs.

create table if not exists public.artwork_geometry_qualifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  -- Exactly one qualification lifecycle may ever exist per reconstruction
  -- job — see the unique index below. `on delete restrict`: a qualification
  -- must never survive its own job being deleted out from under it (the
  -- same `artwork_reconstruction_jobs.candidate_asset_id` precedent).
  reconstruction_job_id uuid not null references public.artwork_reconstruction_jobs (id) on delete restrict,
  -- Snapshotted from the job's own `candidate_asset_id` at
  -- qualification-creation time — the immutable input this qualification
  -- measured. Never patched; a different candidate is a different job,
  -- and therefore a different qualification.
  candidate_asset_id uuid not null references public.assets (id) on delete restrict,

  -- The CONFIRMED fidelity contract current when this qualification was
  -- created, and its `contract_key` snapshot — the SAME staleness-
  -- detection pattern `artwork_reconstruction_jobs.fidelity_contract_id`/
  -- `.contract_key` already establish.
  fidelity_contract_id uuid not null references public.artwork_fidelity_contracts (id) on delete restrict,
  contract_key text not null,

  -- `RepairabilityClassification`'s own value — sanitized internal
  -- diagnostic only, never customer-facing, never a production decision by
  -- itself.
  classifier_verdict text not null,

  -- 'normalized_pending_confirmation' the moment deterministic
  -- qualification succeeds; 'unusable' the moment it abstains. Only the
  -- CUSTOMER'S explicit action ever moves a pending row to
  -- 'confirmed'/'rejected' — never a machine verdict alone.
  qualification_status text not null
    check (qualification_status in ('normalized_pending_confirmation', 'confirmed', 'rejected', 'unusable')),

  -- The new, append-only, geometry-normalized derivative asset. `null`
  -- only for 'unusable' (deterministic qualification abstained before any
  -- derivative was ever created) — every other status requires one, per
  -- the CHECK below. `on delete restrict`: a confirmed/rejected
  -- qualification's own evidence asset must never be deletable out from
  -- under it.
  derived_asset_id uuid null references public.assets (id) on delete restrict,

  original_canvas_width_px integer not null,
  original_canvas_height_px integer not null,
  -- {"left": int, "top": int, "right": int, "bottom": int} — the tight
  -- colour-based content box BEFORE the physical trim's small
  -- artwork-edge safety margin. `null` only for 'unusable'.
  content_bounds jsonb null,
  normalized_width_px integer null,
  normalized_height_px integer null,
  content_aspect_ratio double precision null,
  -- {"r": int, "g": int, "b": int}. `null` only for 'unusable'.
  detected_background_color jsonb null,
  -- `GEOMETRY_QUALIFICATION_VERSION` at creation time — never re-derived,
  -- so a future algorithm change never silently reinterprets an old row.
  normalization_method text not null,

  -- The CUSTOMER'S explicit geometry confirmation — never a machine
  -- verdict. `null` until `qualification_status = 'confirmed'`.
  confirmed_at timestamptz null,
  -- Reuses the SAME narrow customer/operator actor type every other
  -- confirmation in this codebase uses.
  confirmed_by text null
    check (confirmed_by is null or confirmed_by in ('customer', 'operator')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Status-consistency invariant, mirroring
  -- `artwork_reconstruction_jobs_completion_consistent`'s own "one atomic
  -- snapshot, never an impossible combination" discipline:
  --   - 'normalized_pending_confirmation': a derivative and its geometry
  --     evidence exist; no customer decision has been recorded yet.
  --   - 'confirmed': a derivative and its geometry evidence exist; the
  --     customer's decision is fully recorded.
  --   - 'rejected': a derivative and its geometry evidence exist (the
  --     customer rejected what they were shown, not nothing), but no
  --     `confirmed_at`/`confirmed_by` — a rejection is not an attestation.
  --   - 'unusable': deterministic qualification abstained before any
  --     derivative existed — no derivative, no geometry evidence, no
  --     customer decision was ever possible.
  constraint artwork_geometry_qualifications_status_consistent check (
    (
      qualification_status in ('normalized_pending_confirmation', 'confirmed', 'rejected')
      and derived_asset_id is not null
      and content_bounds is not null
      and normalized_width_px is not null
      and normalized_height_px is not null
      and content_aspect_ratio is not null
      and detected_background_color is not null
      and (
        (qualification_status = 'confirmed' and confirmed_at is not null and confirmed_by is not null)
        or
        (qualification_status <> 'confirmed' and confirmed_at is null and confirmed_by is null)
      )
    )
    or
    (
      qualification_status = 'unusable'
      and derived_asset_id is null
      and content_bounds is null
      and normalized_width_px is null
      and normalized_height_px is null
      and content_aspect_ratio is null
      and detected_background_color is null
      and confirmed_at is null
      and confirmed_by is null
    )
  )
);

-- Idempotent derivative creation/lookup — exactly one qualification
-- lifecycle per reconstruction job, ever. Repeated loads and concurrent
-- qualification attempts converge on this one row rather than creating
-- duplicate derivative assets (R6A implementation task, Section 4/17).
create unique index if not exists artwork_geometry_qualifications_job_uidx
  on public.artwork_geometry_qualifications (reconstruction_job_id);

create index if not exists artwork_geometry_qualifications_project_id_idx
  on public.artwork_geometry_qualifications (project_id);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention `20260811191500_server_only_rls_lockdown.sql` established and
-- `security-lockdown.migration.test.ts` enforces for every table created
-- after it. Customer confirmation/rejection is never a direct client
-- mutation — it passes through a server route that independently resolves
-- and validates project/contract/reconstruction/qualification authority
-- before writing (R6A implementation task, Section 6/13).
alter table public.artwork_geometry_qualifications enable row level security;
revoke all privileges on table public.artwork_geometry_qualifications from anon, authenticated;
