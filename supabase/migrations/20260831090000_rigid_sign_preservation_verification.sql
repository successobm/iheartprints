-- Signs Phase S4.1: rigid-sign DETERMINISTIC preservation-verification
-- evidence — the third of four SEPARATE S4 authorities (Constitution
-- §16A.3):
--
--   1. APPROVED REPAIR PLAN      (sign_preparations.plan/plan_key)
--   2. EXECUTION EVIDENCE        (assets.metadata -> rigidSign.executionGeometry /
--                                  providerAlphaNormalization)
--   3. PRESERVATION EVIDENCE     (this table)
--   4. REVIEW-RISK APPROVAL      (Signs Phase S4.3 — not yet implemented)
--
-- Additive and forward-only. Changes nothing about any existing sign or
-- apparel path, authorizes no readiness transition, and does not touch
-- `production_asset_validations`'s own formula. Signs Phase S4.1
-- establishes DETERMINISTIC evidence only — `status` may be 'changed' (a
-- proven structural impossibility) or 'unknown' (the fail-closed default);
-- it can NEVER be 'preserved' until Signs Phase S4.2's semantic
-- verification exists. That invariant is enforced at the application layer
-- (`sign-preservation-capability.ts`), never by this schema alone — this
-- migration's own CHECK constraint below permits all three values, exactly
-- like `production_asset_validations.status` already permits values no
-- single code path can currently reach every one of.
--
-- ITS OWN TABLE, NEVER A COLUMN ON `assets`:
--
--   Assets are append-only (Constitution §6.11, "Version Everything") —
--   `ProjectRepository` exposes no method to update an already-created
--   asset's metadata (confirmed exhaustively across Signs Phases S3C/S3D).
--   Preservation verification is a genuinely separate, potentially paid
--   (from S4.2 onward) step that must be able to run, and be re-verified
--   (via `verification_algorithm_version`), AFTER the final asset already
--   exists — without ever rewriting it. This is the identical reasoning
--   `production_asset_validations` is already its own append-only table
--   rather than a column on `assets` (20260807140000).
--
-- IDENTITY / STALENESS:
--
--   `final_asset_id` is THE binding identity — immutable, unique, never
--   reused for a different asset. `plan_key` is a redundant, fail-closed
--   cross-check (should be unreachable to disagree given upstream
--   invariants, but this codebase's doctrine throughout Signs S1-S3D is
--   "fail closed on any mismatch, even ones that shouldn't be reachable").
--   `verification_algorithm_version` is the one genuinely independent
--   staleness lever — bumping it forces re-verification even against an
--   otherwise-unchanged final asset. The unique index below is what Signs
--   Phase S4.2 will lean on to guarantee at-most-one paid semantic call
--   per exact verification identity.

create table if not exists public.rigid_sign_preservation_verifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  sign_preparation_id uuid not null references public.sign_preparations (id) on delete cascade,

  -- Lineage: the customer's immutable original.
  source_asset_id uuid not null references public.assets (id) on delete restrict,
  source_sha256 text not null,

  -- The persisted reconstruction-intermediate this verification compares
  -- the final content region against. Always present — a preservation
  -- verification only ever runs against a `resolutionProvenance:
  -- "reconstructed"` final asset, which always has one
  -- (`pass1_intermediate`, Signs Phase S3A / Phase 28V precedent).
  intermediate_asset_id uuid not null references public.assets (id) on delete restrict,

  -- THE binding identity this verification is FOR.
  final_asset_id uuid not null references public.assets (id) on delete cascade,
  -- Independently re-hashed at verification time — evidence, not identity
  -- (the asset id above is already immutable/unique on its own).
  final_asset_sha256 text not null,

  -- The approved plan's own canonical identity, re-verified at read time —
  -- a redundant, fail-closed cross-check alongside `final_asset_id`.
  plan_key text not null,

  -- Explicit staleness lever (see header comment).
  verification_algorithm_version text not null,

  -- Structured, versioned, bounded deterministic evidence (lineage, region
  -- mapping, reconstruction<->final RGB integrity, extension-region
  -- verification, source<->reconstruction similarity). Never per-pixel
  -- arrays — bounded summaries sufficient for audit/reproducibility. See
  -- `src/capabilities/sign-preservation/contracts.ts`.
  deterministic_evidence jsonb not null default '{}'::jsonb,

  -- Reserved for Signs Phase S4.2's semantic/multimodal verification.
  -- Always null until then.
  semantic_evidence jsonb null,

  status text not null check (status in ('preserved', 'changed', 'unknown')),
  reasons jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now()
);

-- Idempotent identity: at most one verification row per exact
-- (final_asset_id, verification_algorithm_version) pair. Doubles as the
-- only lookup query this phase's capability performs — no separate
-- project-scoped listing index is added without a query that needs one.
create unique index if not exists rigid_sign_preservation_verifications_identity_idx
  on public.rigid_sign_preservation_verifications (final_asset_id, verification_algorithm_version);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention 20260811191500 established and
-- `security-lockdown.migration.test.ts` enforces. Two independent
-- controls: RLS with no policies (no row qualifies for any non-bypassing
-- role) AND revoked table privileges for the browser-facing roles.
alter table public.rigid_sign_preservation_verifications enable row level security;
revoke all privileges on table public.rigid_sign_preservation_verifications from anon, authenticated;
