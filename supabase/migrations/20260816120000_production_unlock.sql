-- Sprint A5.1 — the Production Unlock (commercial entitlement).
--
-- Additive and forward-only. Creates one new table. Nothing is renamed,
-- rewritten, backfilled, or deleted; no existing table is altered and no
-- customer row is read or mutated by this migration.
--
-- WHAT THIS RECORD MEANS
--
--   "This design project may be prepared for production under one
--    production profile."
--
-- It is COMMERCIAL AUTHORITY. It is not a payment, not an account, not an
-- identity, not a technical capability, and not a generation allowance.
--
-- WHY THE PROJECT IS THE KEY
--
-- The obvious alternative is to bind the purchase to the thing the customer
-- was looking at when they bought it — the active `final_direction_approvals`
-- row. That is wrong, and the codebase already proves it: an approval is
-- DESIGNED to be cheap to supersede, and is superseded from four separate
-- code paths —
--
--   a different artwork being approved      (FinalArtworkCapability)
--   a revision request being understood     (ConversationCapability, x2)
--   a new concept batch completing          (GenerationWorkerCapability)
--
-- The second of those fires the moment a customer SAYS they want a change.
-- An entitlement bound to an approval would therefore be revoked by the
-- customer's first sentence after paying. Every other candidate key fails
-- for a related reason:
--
--   artwork_versions              replaced by every targeted revision
--   final_artwork_jobs            created AFTER the gate that authorizes them
--   assets / the production PNG   an OUTPUT of the paid work, not permission
--   requested_production_output   deliberately mutable — changing your mind
--                                 must not void a purchase
--
-- `print_projects.id` is the only identifier here that survives revision,
-- approval supersession, regeneration, and a change of requested output. It
-- is also already the authority every acquisition gate resolves from, so the
-- commercial gate and the spend gate agree by construction.
--
-- WHY A MIGRATION IS REQUIRED
--
-- The entitlement has to survive a reload, a second tab, a duplicate
-- request, a worker process with no request context, and a direct API call —
-- so it cannot live in a cookie, in React state, or in a signed token. And
-- "at most one active unlock per project and profile" has to be enforced by
-- PostgreSQL rather than by application code reading before it writes, for
-- the same reason `acquisition_free_concept_claims` is a primary key rather
-- than a check: under concurrency, the constraint IS the guarantee.
--
-- No existing table could carry it:
--
--   acquisition_sessions   one row per BROWSER SESSION. An unlock stored
--                          here would make every project that session ever
--                          creates paid — the audit's Goal 14 failure.
--   print_projects         a boolean column cannot be superseded, audited,
--                          or revoked without destroying history, and could
--                          not express a per-profile grant at all.
--   final_direction_approvals  superseded constantly, by design (above).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD
--
--   No provider ids, no Stripe/checkout/payment-intent columns, no amount,
--   no currency. Payment is A5.3+ and belongs in its own transaction and
--   event tables. A column nothing can legitimately write is a feature that
--   only looks implemented — the same rule that kept a `paid` value out of
--   `acquisition_sessions.entitlement` in Sprint A4.
--
--   No `unlocked_for_approval_id` / `unlocked_for_artwork_version_id`
--   provenance columns. They would be write-only in this slice, and a
--   nullable id sitting next to an entitlement is a standing invitation for
--   a future gate to read it — which is precisely the binding this design
--   exists to prevent. They can be added additively when something actually
--   consumes them.
--
--   No revision/finalization allowance counters. A5.1/A5.2 unlocks
--   FINALIZATION ONLY; concept generation stays refused for prospects, so
--   there is no unbounded-spend surface for a counter to bound yet. Adding
--   them is a later additive migration, not an architecture change: the
--   unlock row is exactly where a conditional `... where remaining > 0`
--   decrement will live.

-- ---------------------------------------------------------------------------
-- 1. The production unlock.
-- ---------------------------------------------------------------------------

create table if not exists public.production_unlocks (
  id uuid primary key default gen_random_uuid(),

  -- THE ENTITLEMENT KEY.
  --
  -- ON DELETE RESTRICT, matching every other acquisition foreign key and for
  -- the same reason: losing a row must never be the thing that changes what
  -- somebody is entitled to. A cascade here would silently destroy the only
  -- durable evidence that a project was ever paid for.
  project_id uuid not null
    references public.print_projects (id) on delete restrict,

  -- WHO held the project when the unlock was granted. Attribution plus a
  -- fail-closed cross-check — never an independent authority. The gate
  -- resolves the session from the PROJECT and refuses if the two disagree,
  -- so this column can never widen access on its own.
  --
  -- NOT NULL: a legacy project (acquisition_session_id IS NULL) is
  -- grandfathered and needs no unlock at all, so there is no legitimate way
  -- to grant one without a session.
  acquisition_session_id uuid not null
    references public.acquisition_sessions (id) on delete restrict,

  -- WHICH PRODUCTION PATH this authorizes. A production OUTCOME, never a
  -- file format: 'apparel_raster' is raster garment decoration, and the fact
  -- that V1's pipeline currently delivers that as a validated Production PNG
  -- is a property of the pipeline, not of what was purchased.
  --
  -- The CHECK is the point of this column, not decoration. The domain type
  -- (`GRANTABLE_PRODUCTION_PROFILES`) is the strict GRANTABLE subset of the
  -- application's `ProductionCategory` vocabulary — that union also carries
  -- refusal and dormant-role values ('apparel_vector', 'out_of_scope_product',
  -- 'signage', 'logo_vector', 'unknown'), none of which is a thing anyone can
  -- be sold. Without this constraint the database would authorize a future
  -- production path the moment a string reached the column. Widening it is a
  -- deliberate migration, which is exactly the friction that decision
  -- deserves.
  production_profile text not null
    check (production_profile in ('apparel_raster')),

  --   'active'  — this project may be prepared for production. The ONLY
  --               value any gate treats as permission.
  --   'revoked' — withdrawn (refund, chargeback, operator action). The row
  --               is never deleted; prior final_artwork_jobs, assets, and
  --               production_asset_validations are never touched. Revocation
  --               stops FUTURE finalization; it does not rewrite history.
  --
  -- Deliberately NO payment-lifecycle values. "Did the money arrive" is a
  -- question about a transaction and belongs to a payment table; mixing it
  -- in here would make "may this project be produced" unanswerable without
  -- also knowing a payment provider's vocabulary.
  status text not null
    check (status in ('active', 'revoked')),

  granted_at timestamptz not null default now(),

  revoked_at timestamptz null,
  -- Operational note only. Never customer-facing, never a provider message.
  revoked_reason text null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The two columns cannot disagree with the status they describe. Without
  -- this, a partially-applied revocation ('revoked' with no timestamp, or
  -- 'active' with a revocation stamped on it) would be indistinguishable
  -- afterwards from a real state, and the audit trail a refund depends on
  -- would be untrustworthy exactly when it matters.
  --
  -- `revoked_reason` is not required even when revoked: an operator acting
  -- without a note is a documentation gap, not a data-integrity failure, and
  -- forcing a string would just produce empty ones.
  constraint production_unlocks_revocation_consistent check (
    (status = 'active' and revoked_at is null and revoked_reason is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

comment on table public.production_unlocks is
  'Sprint A5.1: the commercial entitlement — this design project may be prepared for production under one production profile. Keyed on the PROJECT, never on an approval/artwork/job/asset (all of which are superseded or created downstream of the gate). Not a payment record, not identity, not a technical capability, not a generation allowance.';

comment on column public.production_unlocks.project_id is
  'Sprint A5.1: THE entitlement key — the only identifier that survives revision, approval supersession, regeneration, and a change of requested production output. ON DELETE RESTRICT: losing a row must never change what somebody is entitled to.';

comment on column public.production_unlocks.acquisition_session_id is
  'Sprint A5.1: who held the project when the unlock was granted. Attribution and a fail-closed cross-check against the project''s own durable binding — never an independent authority, and never accepted from a request.';

comment on column public.production_unlocks.production_profile is
  'Sprint A5.1: which production path this authorizes — a production OUTCOME, never a file format. CHECK-constrained to the grantable subset so a string in a column can never authorize a production path the product does not implement.';

comment on column public.production_unlocks.status is
  'Sprint A5.1: ''active'' is the only value any gate treats as permission. ''revoked'' stops FUTURE finalization and never deletes rows or rewrites produced artwork. No payment-lifecycle values — those belong to a payment transaction record.';

-- ---------------------------------------------------------------------------
-- 2. THE AUTHORITY INVARIANT — at most one ACTIVE unlock per project+profile.
-- ---------------------------------------------------------------------------
--
-- A partial unique index, so revoked rows accumulate freely as the audit
-- trail they are, while only one grant is ever live. This is what makes
-- `createProductionUnlock` race-safe without application locking: two
-- concurrent grants resolve to one winner and one `unique_violation`, and
-- the loser re-reads the winner rather than creating a second entitlement.
--
-- It is also, deliberately, what makes re-granting after a revocation
-- possible: a revoked row does not occupy the slot, so a refunded customer
-- who buys again gets a NEW row with its own `granted_at` — the honest
-- record — rather than a resurrection of the one that was withdrawn.
--
-- Scoped to (project, profile) rather than (project): a future embroidery or
-- vector production profile is a genuinely different purchase, and must not
-- be blocked by — or silently satisfied by — an apparel-raster unlock.

create unique index if not exists production_unlocks_active_per_project_profile_idx
  on public.production_unlocks (project_id, production_profile)
  where status = 'active';

-- Supports the reverse lookup ("what has this session unlocked") for
-- operational and future analytics reads. Deliberately not unique: one
-- session may legitimately unlock several of its own projects.
create index if not exists production_unlocks_acquisition_session_idx
  on public.production_unlocks (acquisition_session_id);

-- ---------------------------------------------------------------------------
-- 3. Server-only RLS lockdown (see 20260811191500).
-- ---------------------------------------------------------------------------
--
-- The convention every new application table follows: RLS enabled with ZERO
-- policies denies every row to every non-bypassing role, and revoking the
-- Data API grants is the second, independent control. `service_role` holds
-- BYPASSRLS and is unaffected.
--
-- This matters more here than on most tables. These rows decide who may
-- spend money on production reconstruction; a browser that could read them
-- would learn the shape of the entitlement, and one that could write them
-- would hold the entire commercial gate.
--
-- No policy is added, for the reason the lockdown migration states —
-- possession of a session token is not identity, and a `using (true)` policy
-- would re-open the hole that migration closed. There is still no customer
-- identity model, so there is still no owner-scoped policy to write.

alter table public.production_unlocks enable row level security;
revoke all privileges on table public.production_unlocks from anon, authenticated;
