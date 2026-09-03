-- Signs Phase 3A: operator-confirmed structural evidence for
-- `reflow_structural_layout` planning when deterministic segmentation
-- (`sign-layout-segmentation.ts`) is ambiguous or cannot measure a banner
-- structure at all. Additive only — every column is nullable, every
-- existing `sign_preparations` row is untouched.
--
-- NOT APPLIED to any live database by this change. This repository's
-- convention is to land migration + dependent code together and apply the
-- migration only as part of an explicit, reviewed deploy step.
--
-- SCHEMA DISCIPLINE AUDIT
--
-- 1. WHY COLUMNS ON `sign_preparations`, NOT A NEW TABLE
--
--    A rigid-sign preparation has exactly ONE live operator structural
--    override at a time — never a history of proposals. This mirrors
--    `sign_plan_authorization`'s own reasoning (20260831210000) exactly:
--    three additive columns on the existing row, not a generic table, is
--    the smaller and more honest fit for a single current decision.
--
-- 2. WHY BOUND TO THE EXACT SOURCE ASSET/HASH/DIMENSIONS, NOT JUST STORED
--
--    An override drawn against a stale source (a re-upload, or the
--    original re-decoded differently) must never silently keep governing
--    a DIFFERENT image than the operator actually looked at.
--    `operator_structural_override` therefore embeds
--    `sourceAssetId`/`sourceSha256`/`sourceWidthPx`/`sourceHeightPx`
--    inside its own jsonb payload (never trusted without re-checking
--    against the preparation's CURRENT `original_asset_id` and a fresh
--    hash/decode at every use — the same "never trust a caller-supplied
--    window blindly" discipline `resolveFrameAnalysisWindow`/
--    `validateAnalysisWindow` already established for analysis windows).
--
-- 3. WHY THIS DOES NOT NEED ITS OWN PLAN-KEY-LIKE IDENTITY COLUMN
--
--    The override's content (its regions/gaps) already flows INTO
--    `structuralLayoutSegmentation`, which is already part of
--    `computeSignPlanKey`'s own canonical payload (every step's `params`,
--    which `encodeStructuralReflowParams` derives directly from
--    regions/gaps). Changing the override therefore already changes the
--    resulting plan's own `plan_key` — no separate override-identity
--    column is needed for that guarantee; `sign_preparation_capability.ts`
--    is responsible for re-validating the override against the CURRENT
--    source on every planning pass, never trusting a stale binding.
--
-- 4. WHY `jsonb`, LIKE `plan`/`inspection`
--
--    Loosely-typed, narrowed to `SignOperatorStructuralLayoutOverride` at
--    the capability boundary — internal diagnostics/production evidence,
--    never rendered raw to a customer (this profile has no customer-facing
--    surface at all, Constitution §16A.1).

alter table public.sign_preparations
  add column if not exists operator_structural_override jsonb null;

alter table public.sign_preparations
  add column if not exists operator_structural_override_created_at timestamptz null;

alter table public.sign_preparations
  add column if not exists operator_structural_override_created_by text null
    check (operator_structural_override_created_by in ('operator'));
