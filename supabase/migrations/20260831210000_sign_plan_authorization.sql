-- Live Product Blocker #4: durable production-risk authorization for one
-- rigid-sign repair plan. Additive and forward-only. Changes nothing about
-- any existing sign or apparel row — every column is nullable and every
-- existing `sign_preparations` row is untouched (NULL for all three).
--
-- NOT APPLIED to any live database by this change. This repository's
-- convention is to land migration + dependent code together and apply the
-- migration only as part of an explicit, reviewed deploy step.
--
-- SCHEMA DISCIPLINE AUDIT
--
-- 1. WHY THIS IS A GENUINELY SEPARATE DECISION FROM PLANNING
--
--    `sign_preparations.plan`/`plan_key` (20260830120000) record that a
--    repair plan was FORMULATED. They say nothing about whether anyone —
--    customer or operator — has authorized PRODUCTION from it. Conflating
--    the two would mean "a plan exists" silently doubles as "this plan may
--    be executed", which is exactly the gap the S0.5/S2 audit trail
--    documents this profile as never having closed.
--
-- 2. WHY NOT A GENERIC APPROVALS TABLE
--
--    A rigid-sign plan has exactly ONE authorization decision in its
--    lifecycle (this plan, right now) — never a history of proposals,
--    counter-offers, or multi-party sign-off. `FinalDirectionApproval`
--    exists as its own table because Create New Artwork approvals ARE a
--    real, recurring, per-artwork-version history; this is not that shape.
--    Three columns on the existing row, mirroring `spec_confirmed_at`'s own
--    established discipline, is the smaller and more honest fit.
--
-- 3. WHY A THIRD COLUMN (`authorized_by`), NOT JUST A TIMESTAMP
--
--    "Was this authorized" is not the only question the risk rules need
--    answered — "BY WHOM" determines whether the authorization is even
--    VALID for this plan's own risk classification. An `auto_safe` plan
--    accepts the customer's own self-service action; a `review_required`
--    plan requires an internal operator's judgment specifically, because
--    the engine itself could not prove the repair safe on its own. An
--    `approved_at` column alone would lose exactly the fact that
--    distinction depends on. This codebase has no user-authentication
--    layer at all (ARCHITECTURE.md §23) — `authorized_by` is therefore a
--    narrow ACTOR TYPE (`'customer' | 'operator'`), never a personal
--    identity.
--
-- 4. WHY BOUND TO `authorized_plan_key`, NOT A BARE `authorized: true`
--
--    A plan can be re-planned (a human confirms a different size, or the
--    planner's own logic changes) — `planKey` changes when that happens,
--    exactly like `sign_final_artwork_authority`'s own `sign_plan_key`
--    precedent. An authorization that does not independently record WHICH
--    plan it was granted for could silently keep authorizing a plan the
--    customer/operator never actually saw. `requestSignFinalArtwork` (and,
--    independently, PrintValidation) compare `authorized_plan_key` against
--    the CURRENTLY PERSISTED, freshly recomputed `plan_key` — never trust
--    the stored key alone, the same discipline this profile already
--    applies everywhere else.

alter table public.sign_preparations
  add column if not exists authorized_plan_key text null;

alter table public.sign_preparations
  add column if not exists authorized_at timestamptz null;

alter table public.sign_preparations
  add column if not exists authorized_by text null
    check (authorized_by in ('customer', 'operator'));
