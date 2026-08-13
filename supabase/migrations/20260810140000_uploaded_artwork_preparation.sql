-- Existing Artwork → Print Ready Phase 1: upload, analyze, background
-- preparation, and customer approval of artwork the customer already owns.
-- Additive and forward-only. Does not edit or rename any previously applied
-- migration, and changes nothing about the Create New Artwork workflow.
--
-- SCHEMA DISCIPLINE AUDIT (why this migration exists at all)
--
-- 1. WHAT MUST SURVIVE RELOAD
--    - which asset is the customer's immutable original
--    - the deterministic analysis + repairability verdict already computed
--      for it (so the customer is not re-told a different story on refresh)
--    - which asset is the derived, background-prepared PNG
--    - whether the customer has explicitly approved that prepared artwork
--    - which `artwork_versions` row represents the approved prepared artwork
--      (Phase 2's Final Artwork pipeline consumes it)
--    - implicitly: that this project is an "upload existing artwork" project
--      at all
--
-- 2. WHY EXISTING TABLES CANNOT REPRESENT IT HONESTLY
--    - `assets` has no honest lineage slot. `vector_asset_id` means "an SVG
--      companion" and `print_asset_id` means "a print-ready production
--      asset". Neither means "the customer upload this was derived from",
--      and reusing one would make a narrower documented field lie.
--    - The customer's prepared-artwork approval is not any existing flag.
--      `print_projects.final_direction_confirmed` means "no more creative
--      changes" in the generated-concept lifecycle and is reset by concept
--      selection; `selected_artwork_version_id` means "the direction I'm
--      working with". Neither means "this prepared file faithfully
--      represents the artwork I uploaded".
--    - Storing analysis in `assets.metadata` would bury a first-class
--      lifecycle record inside a column documented as a sanitized provider
--      response envelope.
--
-- 3. SMALLEST ADDITIVE SCHEMA
--    ONE table plus ONE enum value. In particular there is deliberately NO
--    `print_projects.workflow_kind` column: "is this create_new or
--    prepare_existing?" is answered by whether a row exists here, which is a
--    real domain fact rather than a speculative enum added ahead of a second
--    consumer.

-- Customer-supplied artwork, deterministically background-prepared and
-- explicitly approved by the customer. NEVER an AI-generated concept and
-- never a revision of one — its own kind so provenance can never be inferred
-- or confused downstream (Constitution §16).
--
-- Added on its own, referenced by nothing else in this file: a freshly-added
-- enum value cannot be used in the same transaction that adds it (SQLSTATE
-- 55P04 — see 20260805140000 / 20260806182103 / 20260807140000).
alter type public.artwork_kind add value if not exists 'prepared_upload';

create table if not exists public.artwork_preparations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  -- 'analyzed' → immutable original stored, deterministic analysis done.
  -- 'prepared' → derived transparent PNG exists, NOT yet approved.
  -- 'approved' → customer confirmed the prepared artwork faithfully
  --              represents their upload. NOT a production/print-readiness
  --              claim of any kind (Constitution §15).
  status text not null default 'analyzed'
    check (status in ('analyzed', 'prepared', 'approved')),

  -- The customer's uploaded bytes, exactly as received. Immutable: every
  -- transformation produces a NEW asset row and this column never changes.
  -- `on delete restrict` because losing the original silently would leave a
  -- prepared derivative with no provenance at all.
  original_asset_id uuid not null references public.assets (id) on delete restrict,

  -- The derived transparent PNG. Null until background preparation runs.
  prepared_asset_id uuid null references public.assets (id) on delete set null,

  -- The approved prepared artwork's `artwork_versions` row (kind
  -- 'prepared_upload'). Null until the customer approves.
  prepared_artwork_version_id uuid null
    references public.artwork_versions (id) on delete set null,

  -- Sanitized customer filename. DISPLAY ONLY — object keys are always built
  -- from project/preparation ids, never from anything a customer supplied.
  original_filename text null,

  -- Deterministic analysis + the deterministic preparation record. Internal
  -- diagnostics (edge statistics, tolerance, mask pixel counts); customer
  -- copy is DERIVED from these, never rendered from them.
  analysis jsonb not null default '{}'::jsonb,
  preparation jsonb null,

  approved_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists artwork_preparations_project_id_created_at_idx
  on public.artwork_preparations (project_id, created_at desc);
