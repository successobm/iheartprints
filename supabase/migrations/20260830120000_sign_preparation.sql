-- Signs Phase S1: rigid-sign preparation — inspection, diagnosis, and repair
-- PLANNING for the admitted-but-unimplemented rigid_sign_raster production
-- profile (Constitution 3.0 §16A / §16B). Additive and forward-only. Changes
-- nothing about the apparel workflows, executes no repair, and creates no
-- production/print-readiness state of any kind.
--
-- NOT APPLIED to any live database by this change. This repository's
-- convention is to land migration + dependent code together and apply the
-- migration only as part of an explicit, reviewed deploy step, never
-- automatically from a feature change.
--
-- SCHEMA DISCIPLINE AUDIT
--
-- 1. WHAT MUST SURVIVE RELOAD, AND CANNOT ALREADY BE REPRESENTED
--
--    - which asset is the sign customer's immutable original
--    - the HUMAN-CONFIRMED ordered physical size — width AND height — and
--      when it was confirmed (Constitution §16A.2: never defaulted, never
--      inferred from artwork, filename, prose, or the dormant `signage`
--      placeholder)
--    - which sign resolution policy governed that confirmation, so a later
--      policy revision cannot silently re-govern an old order
--    - the deterministic inspection already computed for the artwork
--    - the persisted, ordered repair PLAN and its canonical identity key
--      (the future FinalArtworkJob binding key — the
--      `production_treatment_key` precedent)
--    - implicitly: that this project is a rigid-sign preparation at all
--
-- 2. WHY `artwork_preparations` CANNOT REPRESENT IT HONESTLY
--
--    That record IS the apparel upload workflow: its status vocabulary
--    ('analyzed'/'prepared'/'approved'), its background-isolation
--    diagnostics, and its derived transparent PNG are apparel-DTF facts a
--    sign preparation does not have. A sign preparation's own facts
--    (ordered width AND height, a resolution-policy identity, a repair
--    plan) have no honest column there, and the apparel width-only
--    placement model (`intended_print_width_in` + placement) is exactly
--    what Constitution §16A forbids sign dimensions to flow through.
--
-- 3. SMALLEST ADDITIVE SCHEMA
--
--    ONE table. No enum changes, no new columns on existing tables, and
--    deliberately NO `print_projects.workflow_kind` column — "is this a
--    rigid-sign project?" is answered by whether a row exists here, the
--    same real-domain-fact rule `artwork_preparations` established.
--
--    `inspection` and `plan` are loosely-typed jsonb narrowed at the
--    SignPreparationCapability boundary (the `analysis`/`preparation`
--    precedent): internal diagnostics, recomputed rather than trusted as
--    authority, never rendered raw to a customer.

create table if not exists public.sign_preparations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  -- 'inspected' → immutable original stored, deterministic inspection done.
  -- 'planned'   → a repair PLAN exists for the confirmed ordered size.
  --               NOT executed, NOT approved, NOT print-ready — S1 changes
  --               no pixels and claims no production readiness.
  status text not null default 'inspected'
    check (status in ('inspected', 'planned')),

  -- The customer's uploaded bytes, exactly as received. Immutable: every
  -- later transformation derives a NEW asset and this column never changes.
  -- `on delete restrict` because losing the original silently would leave a
  -- plan with no provenance at all.
  original_asset_id uuid not null references public.assets (id) on delete restrict,

  -- Sanitized customer filename. DISPLAY ONLY — object keys are always built
  -- from project/preparation ids, never from anything a customer supplied.
  original_filename text null,

  -- The human-confirmed ordered physical size. BOTH dimensions are
  -- authoritative (Constitution §16A.2). Null means "never confirmed", and
  -- planning fails closed on null — a default is not a decision
  -- (the production_size_confirmed_* precedent).
  ordered_width_in numeric(6, 2) null,
  ordered_height_in numeric(6, 2) null,
  spec_confirmed_at timestamptz null,

  -- Which sign resolution policy governed the confirmation (e.g. the V1
  -- rigid-rectangle 150-target/100-minimum policy id). Stamped at confirm
  -- time; internal vocabulary, never customer-facing copy.
  resolution_policy_id text null,

  -- Deterministic SignInspectionReport / persisted SignRepairPlan. Internal
  -- diagnostics narrowed at the capability boundary; customer copy is
  -- DERIVED from these, never rendered from them.
  inspection jsonb null,
  plan jsonb null,

  -- Canonical, serialization-insensitive identity of `plan` — the future
  -- FinalArtworkJob binding key. Null until planning succeeds.
  plan_key text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sign_preparations_project_id_created_at_idx
  on public.sign_preparations (project_id, created_at desc);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention 20260811191500 established and
-- `security-lockdown.migration.test.ts` enforces. Two independent controls:
-- RLS with no policies (no row qualifies for any non-bypassing role) AND
-- revoked table privileges for the browser-facing roles.
alter table public.sign_preparations enable row level security;
revoke all privileges on table public.sign_preparations from anon, authenticated;
