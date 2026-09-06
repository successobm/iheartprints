-- Signs QR Visual Revision Acceptance: durable evidence that a HUMAN has
-- looked at and approved the exact, immutable production candidate whose
-- visible artwork was materially changed by a QR replacement/restoration
-- (a decorative/nonfunctional source QR-like graphic composited into a
-- real, working QR). Additive and forward-only. Changes nothing about any
-- existing sign or apparel row.
--
-- WHY THIS IS A GENUINELY SEPARATE AUTHORITY FROM EVERYTHING ELSE IN THIS
-- WORKFLOW:
--
--   `sign_preparations.authorized_at/by`     — a human accepted the REPAIR
--                                               PLAN (a set of deterministic
--                                               steps). Says nothing about
--                                               any resulting candidate's
--                                               appearance.
--   `sign_preparations.qr_resolutions`       — a human confirmed the
--                                               INTENDED QR PAYLOAD TEXT.
--                                               Says nothing about whether
--                                               anyone has SEEN the
--                                               replacement QR composited
--                                               into the artwork.
--   `production_asset_validations`           — TECHNICAL evidence (decode,
--                                               dimensions, resolution,
--                                               bounds). Proves the QR
--                                               scans; never proves a human
--                                               found the visible result
--                                               acceptable.
--
-- A QR replacement is a real, visible edit to the customer's artwork
-- (module pattern, density, quiet zone, apparent size, surrounding
-- composition can all change) — "the replacement QR technically works" is
-- necessary but not sufficient for that edit to be acceptable. This table
-- is the fourth, missing authority: explicit human sign-off on the EXACT
-- revised pixels.
--
-- ITS OWN TABLE, KEYED TO `asset_id` ALONE (never a plan/project column):
--
--   Assets are append-only (Constitution §6.11, "Version Everything") — an
--   asset's pixels never change once created, so a genuine visible
--   revision always means a NEW asset id, never a mutation of an existing
--   row. Binding to `asset_id` alone (rather than `final_direction_
--   approvals`'s "at most one active per project" shape) is therefore
--   already fail-closed by construction: a later QR-revised candidate gets
--   its own new asset id, and this table simply has no row for it yet —
--   there is no "supersede the old row" step to forget, and prior
--   acceptance can never be silently read as covering a different asset.
--   Mirrors `rigid_sign_preservation_verifications`'s identical reasoning
--   for binding to `final_asset_id` as THE identity, not a redundant
--   "active" flag.
--
-- `final_artwork_job_id` and `plan_key` are redundant, fail-closed
-- cross-checks alongside `asset_id` — this codebase's doctrine throughout
-- Signs S1-S4 is "fail closed on any mismatch, even ones that shouldn't be
-- reachable" (see `rigid_sign_preservation_verifications`'s identical
-- note).
create table public.sign_candidate_visual_acceptances (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  final_artwork_job_id uuid not null references public.final_artwork_jobs (id) on delete cascade,

  -- THE binding identity this acceptance is FOR — immutable, never reused
  -- for a different asset (Constitution §6.11).
  asset_id uuid not null references public.assets (id) on delete cascade,

  -- Redundant, fail-closed cross-check alongside `asset_id`.
  plan_key text not null,

  accepted_at timestamptz not null default now(),
  -- Never a personal identity (ARCHITECTURE.md §23: no user-authentication
  -- layer exists at all) — a narrow actor TYPE, mirroring
  -- `sign_preparations.authorized_by`'s identical discipline. This
  -- workflow's approval action is internal-operator-gated only in V1 (no
  -- customer-facing counterpart exists), but the column stays as wide as
  -- the plan-authorization precedent for the same future reason that one
  -- is.
  accepted_by text not null check (accepted_by in ('customer', 'operator')),

  created_at timestamptz not null default now()
);

-- Idempotent identity: at most one acceptance row per exact asset. Doubles
-- as the lookup query `isSignCandidateReadyForDelivery` performs — no
-- separate project-scoped listing index is added without a query that
-- needs one. Mirrors `rigid_sign_preservation_verifications_identity_idx`'s
-- identical shape and purpose.
create unique index sign_candidate_visual_acceptances_asset_id_idx
  on public.sign_candidate_visual_acceptances (asset_id);

create index sign_candidate_visual_acceptances_project_id_idx
  on public.sign_candidate_visual_acceptances (project_id);

-- Server-only lockdown, in the same migration that creates the table — the
-- convention 20260811191500 established and
-- `security-lockdown.migration.test.ts` enforces.
alter table public.sign_candidate_visual_acceptances enable row level security;
revoke all privileges on table public.sign_candidate_visual_acceptances from anon, authenticated;
